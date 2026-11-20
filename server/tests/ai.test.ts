import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/types.js";
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    responses = { create };
  },
}));
import {
  OpenAIService,
  safeAIError,
  selectContext,
  TONE_INSTRUCTIONS,
} from "../src/services/ai.js";

const message = (
  role: "user" | "assistant",
  content: string,
  status: Message["status"] = "completed",
): Message => ({
  _id: crypto.randomUUID(),
  role,
  content,
  status,
  timestamp: new Date().toISOString(),
  tone: "professional",
  requestId: crypto.randomUUID(),
});
async function collect(stream: AsyncIterable<string>) {
  let output = "";
  for await (const delta of stream) output += delta;
  return output;
}
async function* completed() {
  yield { type: "response.output_text.delta", delta: "Hello " };
  yield { type: "response.output_text.delta", delta: "world" };
  yield { type: "response.completed" };
}

beforeEach(() => {
  create.mockReset();
  create.mockImplementation(async () => completed());
});
describe("official SDK request construction", () => {
  it.each(["professional", "casual", "concise"] as const)(
    "passes the trusted %s instruction and ordered history to Responses API",
    async (tone) => {
      const history = [
        message("user", "First question"),
        message("assistant", "First answer"),
        message("user", "Follow-up", "pending"),
      ];
      const signal = new AbortController().signal;
      expect(
        await collect(
          new OpenAIService("test-key", "configured-model").generate(
            history,
            tone,
            signal,
          ),
        ),
      ).toBe("Hello world");
      expect(create).toHaveBeenCalledWith(
        {
          model: "configured-model",
          instructions: TONE_INSTRUCTIONS[tone],
          input: history.map(({ role, content }) => ({ role, content })),
          max_output_tokens: 4096,
          stream: true,
          store: false,
        },
        { signal },
      );
    },
  );

  it("does not silently accept a truncated or incomplete OpenAI stream", async () => {
    create.mockImplementation(async () =>
      (async function* () {
        yield { type: "response.output_text.delta", delta: "partial" };
      })(),
    );
    await expect(
      collect(
        new OpenAIService("test-key", "model").generate(
          [],
          "professional",
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: "AI_INCOMPLETE" });
    create.mockImplementation(async () =>
      (async function* () {
        yield { type: "response.incomplete" };
      })(),
    );
    await expect(
      collect(
        new OpenAIService("test-key", "model").generate(
          [],
          "professional",
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: "AI_INCOMPLETE" });
  });

  it("returns actionable setup instructions for a missing key without calling the provider", async () => {
    await expect(
      collect(
        new OpenAIService("", "model").generate(
          [],
          "professional",
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: "AI_NOT_CONFIGURED", status: 503 });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("bounded context and safe provider errors", () => {
  it("reports exhausted credits even when the provider omits an HTTP status", () => {
    const failure = safeAIError({
      code: "credit_balance_exhausted",
      type: "insufficient_quota",
      message: "sensitive provider detail",
    });
    expect(failure).toMatchObject({ status: 429, code: "AI_QUOTA_EXHAUSTED" });
    expect(failure.message).toContain("billing");
    expect(failure.message).not.toContain("sensitive provider detail");
  });

  it("omits failed/cancelled turns and bounds the context to recent messages", () => {
    const history = Array.from({ length: 60 }, (_, i) =>
      message(i % 2 ? "assistant" : "user", String(i)),
    );
    expect(selectContext(history)).toEqual(history.slice(-40));
    expect(
      selectContext([
        message("user", "failed", "failed"),
        message("assistant", "partial", "cancelled"),
        message("user", "current", "pending"),
      ]).map((entry) => entry.content),
    ).toEqual(["current"]);
    expect(
      selectContext([
        message("user", "old"),
        message("assistant", "x".repeat(64_001)),
        message("user", "latest"),
      ]).map((entry) => entry.content),
    ).toEqual(["latest"]);
  });
  it.each([
    [401, "AI_AUTH_ERROR"],
    [403, "AI_AUTH_ERROR"],
    [429, "AI_RATE_LIMIT"],
    [404, "AI_MODEL_ERROR"],
    [500, "AI_UNAVAILABLE"],
  ])("sanitizes provider status %s", (status, code) => {
    const error = safeAIError({
      status,
      message: "secret-api-key-from-provider",
    });
    expect(error.code).toBe(code);
    expect(error.message).not.toContain("secret-api-key");
  });
});
