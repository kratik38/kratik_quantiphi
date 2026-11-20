import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { ZodError } from "zod";
import { config as defaultConfig } from "./config/env.js";
import { AppError, type AppConfig } from "./types.js";
import {
  createConversationSchema,
  idSchema,
  streamSchema,
  updateConversationSchema,
} from "./validation.js";
import {
  MongoConversationRepository,
  type ConversationRepository,
} from "./services/repository.js";
import { OpenAIService, safeAIError, type AIService } from "./services/ai.js";
import { formatSSE } from "./services/sse.js";
export interface AppDependencies {
  repository?: ConversationRepository;
  ai?: AIService;
  config?: AppConfig;
}
export function createApp(dependencies: AppDependencies = {}) {
  const config = dependencies.config ?? defaultConfig;
  const repository =
    dependencies.repository ?? new MongoConversationRepository();
  const ai =
    dependencies.ai ??
    new OpenAIService(config.openaiApiKey, config.openaiModel);
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: config.clientOrigin,
      methods: ["GET", "POST", "PATCH", "DELETE"],
    }),
  );
  // CORS is not access control. Refuse unexpected browser origins, including simple requests.
  app.use((req, res, next) => {
    if (req.headers.origin && req.headers.origin !== config.clientOrigin)
      return next(
        new AppError(
          403,
          "ORIGIN_REJECTED",
          "This browser origin is not allowed.",
        ),
      );
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  app.get("/api/health", (_req, res) =>
    res.status(repository.isReady() ? 200 : 503).json({
      status: repository.isReady() ? "ok" : "degraded",
      database: repository.isReady() ? "connected" : "disconnected",
      aiConfigured: Boolean(
        config.openaiApiKey && config.openaiApiKey !== "your_api_key_here",
      ),
    }),
  );
  app.use("/api", (_req, _res, next) =>
    repository.isReady()
      ? next()
      : next(
          new AppError(
            503,
            "DATABASE_UNAVAILABLE",
            "MongoDB is unavailable. Check MONGODB_URI and start your database.",
          ),
        ),
  );
  app.get("/api/conversations", async (_req, res) => {
    res.json({ conversations: await repository.list() });
  });
  app.post("/api/conversations", async (req, res) => {
    const { tone } = createConversationSchema.parse(req.body ?? {});
    res.status(201).json({ conversation: await repository.create(tone) });
  });
  app.get("/api/conversations/:id", async (req, res) => {
    res.json({
      conversation: await repository.get(idSchema.parse(req.params.id)),
    });
  });
  app.patch("/api/conversations/:id", async (req, res) => {
    res.json({
      conversation: await repository.update(
        idSchema.parse(req.params.id),
        updateConversationSchema.parse(req.body),
      ),
    });
  });
  app.delete("/api/conversations/:id", async (req, res) => {
    await repository.delete(idSchema.parse(req.params.id));
    res.sendStatus(204);
  });
  app.post(
    "/api/chat/stream",
    rateLimit({
      windowMs: 60000,
      limit: 20,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        error: {
          code: "RATE_LIMIT",
          message: "Too many AI requests. Please wait a minute.",
        },
      },
    }),
    async (req, res, next) => {
      const input = streamSchema.parse(req.body);
      const controller = new AbortController();
      let timedOut = false;
      let accepted = false;
      let committed = false;
      let saving = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 120000);
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on("close", onClose);
      const emit = (event: string, data: unknown) => {
        if (!res.destroyed) res.write(formatSSE(event, data));
      };
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        const started = await repository.begin(input);
        accepted = true;
        committed = started.replay;
        if (controller.signal.aborted)
          throw new AppError(499, "CANCELLED", "Response cancelled.");
        res.status(200).set({
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(": heartbeat\n\n");
        }, 15000);
        const userMessage = started.conversation.messages.find(
          (m) => m.role === "user" && m.requestId === input.requestId,
        );
        emit("start", {
          conversationId: input.conversationId,
          requestId: input.requestId,
          userMessage,
          assistantMessageId: started.assistantMessageId,
        });
        if (started.replay) {
          committed = true;
          emit("done", { conversation: started.conversation });
          return;
        }
        let response = "";
        for await (const text of ai.generate(
          started.conversation.messages,
          input.tone,
          controller.signal,
        )) {
          if (controller.signal.aborted)
            throw new AppError(499, "CANCELLED", "Response cancelled.");
          response += text;
          if (response.length > 100000)
            throw new AppError(
              502,
              "AI_RESPONSE_TOO_LONG",
              "The generated response exceeded the size limit. Please ask a shorter question.",
            );
          emit("delta", { text });
        }
        if (controller.signal.aborted)
          throw new AppError(499, "CANCELLED", "Response cancelled.");
        if (!response.trim())
          throw new AppError(
            502,
            "AI_EMPTY",
            "The AI returned no text. Please retry your message.",
          );
        saving = true;
        const conversation = await repository.complete(
          input.conversationId,
          input.requestId,
          started.assistantMessageId,
          response,
          input.tone,
        );
        committed = true;
        emit("done", { conversation });
      } catch (error) {
        const failure = timedOut
          ? new AppError(
              504,
              "AI_TIMEOUT",
              "The AI request timed out. Please retry.",
            )
          : controller.signal.aborted
            ? new AppError(499, "CANCELLED", "Response cancelled.")
            : (!accepted || saving) && !(error instanceof AppError)
              ? new AppError(
                  503,
                  "DATABASE_UNAVAILABLE",
                  "The conversation could not be saved. Check MongoDB, reload the conversation, and retry.",
                )
              : safeAIError(error);
        let conversation;
        if (accepted && !committed)
          try {
            conversation = await repository.fail(
              input.conversationId,
              input.requestId,
              controller.signal.aborted && !timedOut ? "cancelled" : "failed",
            );
          } catch {
            /* The database may have disconnected; the lease recovers after expiry. */
          }
        if (res.headersSent)
          emit("error", {
            code: failure.code,
            message: failure.message,
            conversation,
          });
        else next(error instanceof AppError ? error : failure);
      } finally {
        clearTimeout(timeout);
        if (heartbeat) clearInterval(heartbeat);
        res.off("close", onClose);
        if (res.headersSent && !res.writableEnded) res.end();
      }
    },
  );
  app.use((_req, _res, next) =>
    next(new AppError(404, "NOT_FOUND", "Endpoint not found.")),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (res.headersSent) return;
      if (error instanceof ZodError) {
        res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: error.issues
              .map(
                (issue) =>
                  `${issue.path.join(".") || "request"}: ${issue.message}`,
              )
              .join("; "),
          },
        });
        return;
      }
      if (
        error instanceof SyntaxError ||
        (error as { type?: string })?.type === "entity.parse.failed"
      ) {
        res.status(400).json({
          error: {
            code: "INVALID_JSON",
            message: "Request body must be valid JSON.",
          },
        });
        return;
      }
      if ((error as { type?: string })?.type === "entity.too.large") {
        res.status(413).json({
          error: {
            code: "BODY_TOO_LARGE",
            message: "Request body exceeds the size limit.",
          },
        });
        return;
      }
      const failure =
        error instanceof AppError
          ? error
          : new AppError(
              503,
              "SERVICE_UNAVAILABLE",
              "The service is temporarily unavailable. Please try again.",
            );
      res
        .status(failure.status)
        .json({ error: { code: failure.code, message: failure.message } });
    },
  );
  return app;
}
