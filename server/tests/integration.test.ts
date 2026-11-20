import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { ConversationModel } from "../src/models/Conversation.js";
import { MongoConversationRepository } from "../src/services/repository.js";
import type { AIService } from "../src/services/ai.js";
import type { Conversation, Message, Tone } from "../src/types.js";
import { eventually, readEvents } from "./helpers.js";

let mongo: MongoMemoryServer;
let server: Server;
let base: string;
const repository = new MongoConversationRepository();
const generate = vi.fn<AIService["generate"]>();
const config = {
  mongoUri: "",
  openaiApiKey: "test-only-key",
  openaiModel: "test-model",
  clientOrigin: "http://localhost:5173",
  port: 0,
};
const ai: AIService = {
  generate: (messages, tone, signal) => generate(messages, tone, signal),
};
async function request(path: string, method = "GET", body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function newConversation(
  tone: Tone = "professional",
): Promise<Conversation> {
  const response = await request("/conversations", "POST", { tone });
  expect(response.status).toBe(201);
  return (await response.json()).conversation;
}
const input = (
  id: string,
  message = "Explain hashing",
  tone: Tone = "professional",
) => ({ conversationId: id, message, tone, requestId: crypto.randomUUID() });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({
    binary: {
      downloadDir: fileURLToPath(
        new URL("../.cache/mongodb-binaries", import.meta.url),
      ),
    },
  });
  await mongoose.connect(mongo.getUri());
  server = createApp({ repository, ai, config }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Test server did not bind a TCP port");
  base = `http://127.0.0.1:${address.port}/api`;
}, 120_000);
afterEach(async () => {
  await ConversationModel.deleteMany({});
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});
beforeEach(() => {
  generate.mockReset();
  generate.mockImplementation(async function* () {
    yield "Hashing maps ";
    yield "input to a fixed-size value.";
  });
});

describe("conversation REST API with real ephemeral MongoDB", () => {
  it("creates, retrieves, updates tone/title, lists and deletes persisted conversations", async () => {
    const created = await newConversation();
    expect(created).toMatchObject({ tone: "professional", messages: [] });
    expect(created._id).toMatch(/^[a-f\d]{24}$/);
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);
    const patch = await request(`/conversations/${created._id}`, "PATCH", {
      tone: "casual",
      title: "Hashing discussion",
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).conversation).toMatchObject({
      tone: "casual",
      title: "Hashing discussion",
    });
    const get = await request(`/conversations/${created._id}`);
    expect((await get.json()).conversation).toMatchObject({
      _id: created._id,
      tone: "casual",
    });
    const list = (await (await request("/conversations")).json()).conversations;
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("messages");
    expect((await ConversationModel.findById(created._id))?.tone).toBe(
      "casual",
    );
    expect(
      (await request(`/conversations/${created._id}`, "DELETE")).status,
    ).toBe(204);
    expect(await ConversationModel.findById(created._id)).toBeNull();
    expect((await request(`/conversations/${created._id}`)).status).toBe(404);
  });

  it("validates IDs, unexpected system instructions, malformed JSON and unknown routes", async () => {
    expect((await request("/conversations/not-an-id")).status).toBe(400);
    expect(
      (
        await request("/conversations", "POST", {
          tone: "casual",
          system: "arbitrary instruction",
        })
      ).status,
    ).toBe(400);
    const malformed = await fetch(`${base}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("INVALID_JSON");
    expect((await request("/missing")).status).toBe(404);
    const rejectedOrigin = await fetch(`${base}/conversations`, {
      headers: { Origin: "https://unexpected.example" },
    });
    expect(rejectedOrigin.status).toBe(403);
  });

  it("reports disconnected MongoDB safely in health and conversation APIs", async () => {
    const ready = vi.spyOn(repository, "isReady").mockReturnValue(false);
    try {
      const health = await request("/health");
      expect(health.status).toBe(503);
      expect(await health.json()).toMatchObject({
        status: "degraded",
        database: "disconnected",
      });
      const response = await request("/conversations");
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error.code).toBe("DATABASE_UNAVAILABLE");
      expect(JSON.stringify(body)).not.toContain("test-only-key");
    } finally {
      ready.mockRestore();
    }
  });
});

describe("AI stream, durability, context and idempotency", () => {
  it("persists prompt before first AI chunk, streams deltas, saves complete answer and replays without duplicates", async () => {
    const conversation = await newConversation();
    const body = input(conversation._id);
    generate.mockImplementation(async function* () {
      const saved = await repository.get(conversation._id);
      expect(saved.messages).toHaveLength(1);
      expect(saved.messages[0]).toMatchObject({
        role: "user",
        content: body.message,
        status: "pending",
      });
      yield "Hashing maps ";
      yield "input to a fixed-size value.";
    });
    const response = await request("/chat/stream", "POST", body);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = readEvents(await response.text());
    expect(events.map(({ event }) => event)).toEqual([
      "start",
      "delta",
      "delta",
      "done",
    ]);
    expect(
      events
        .filter(({ event }) => event === "delta")
        .map(({ data }) => data.text)
        .join(""),
    ).toBe("Hashing maps input to a fixed-size value.");
    const persisted = await repository.get(conversation._id);
    expect(persisted.title).toBe(body.message);
    expect(persisted.messages).toHaveLength(2);
    expect(
      persisted.messages.map(({ role, status }) => ({ role, status })),
    ).toEqual([
      { role: "user", status: "completed" },
      { role: "assistant", status: "completed" },
    ]);
    for (const message of persisted.messages)
      expect(Number.isNaN(Date.parse(message.timestamp))).toBe(false);
    const replay = readEvents(
      await (await request("/chat/stream", "POST", body)).text(),
    );
    expect(replay.map(({ event }) => event)).toEqual(["start", "done"]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await repository.get(conversation._id)).messages).toHaveLength(2);
    const conflict = await request("/chat/stream", "POST", {
      ...body,
      message: "Different prompt",
    });
    expect(conflict.status).toBe(409);
  });

  it("forwards the first response chunk before the provider finishes generation", async () => {
    const conversation = await newConversation();
    let release!: () => void;
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    generate.mockImplementationOnce(async function* () {
      yield "$first chunk";
      await finish;
      yield " last chunk";
    });
    const response = await request(
      "/chat/stream",
      "POST",
      input(conversation._id),
    );
    const reader = response.body!.getReader();
    let received = "";
    try {
      while (!received.includes("first chunk")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Stream ended before first delta");
        received += new TextDecoder().decode(chunk.value);
      }
      expect(received).not.toContain("event: done");
      expect((await repository.get(conversation._id)).messages).toHaveLength(1);
    } finally {
      release();
    }
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += new TextDecoder().decode(chunk.value);
    }
    expect(readEvents(received).at(-1)?.event).toBe("done");
    expect((await repository.get(conversation._id)).messages[1]?.content).toBe(
      "$first chunk last chunk",
    );
  });

  it("restores multi-turn context and applies changed tone only to subsequent requests", async () => {
    const conversation = await newConversation();
    await (
      await request(
        "/chat/stream",
        "POST",
        input(conversation._id, "First question"),
      )
    ).text();
    await request(`/conversations/${conversation._id}`, "PATCH", {
      tone: "concise",
    });
    await (
      await request(
        "/chat/stream",
        "POST",
        input(conversation._id, "Follow-up", "concise"),
      )
    ).text();
    const [messages, tone] = generate.mock.calls[1] as [
      Message[],
      Tone,
      AbortSignal,
    ];
    expect(tone).toBe("concise");
    expect(messages.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(messages.map(({ content }) => content)).toEqual([
      "First question",
      "Hashing maps input to a fixed-size value.",
      "Follow-up",
    ]);
    const saved = await repository.get(conversation._id);
    expect(saved.tone).toBe("concise");
    expect(saved.messages[1]?.tone).toBe("professional");
    expect(saved.messages[3]?.tone).toBe("concise");
  });

  it("keeps failed prompt recoverable, omits partial AI text, and retries the same request without a second prompt", async () => {
    const conversation = await newConversation();
    const body = input(conversation._id);
    generate.mockImplementationOnce(async function* () {
      yield "partial response";
      throw { status: 429, message: "secret-test-key" };
    });
    const events = readEvents(
      await (await request("/chat/stream", "POST", body)).text(),
    );
    expect(events.at(-1)).toMatchObject({
      event: "error",
      data: { code: "AI_RATE_LIMIT" },
    });
    expect(JSON.stringify(events)).not.toContain("secret-test-key");
    const failed = await repository.get(conversation._id);
    expect(failed.messages).toHaveLength(1);
    expect(failed.messages[0]?.status).toBe("failed");
    const retried = readEvents(
      await (await request("/chat/stream", "POST", body)).text(),
    );
    expect(retried.at(-1)?.event).toBe("done");
    expect((await repository.get(conversation._id)).messages).toHaveLength(2);
  });

  it("cancels a disconnected stream, rejects concurrent edits/submissions, and persists no partial assistant", async () => {
    const conversation = await newConversation();
    let started = false;
    generate.mockImplementationOnce(async function* (_messages, _tone, signal) {
      started = true;
      yield "partial";
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const controller = new AbortController();
    const response = await fetch(`${base}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input(conversation._id)),
      signal: controller.signal,
    });
    await eventually(async () => started);
    expect(
      (
        await request(
          "/chat/stream",
          "POST",
          input(conversation._id, "Concurrent"),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/conversations/${conversation._id}`, "PATCH", {
          tone: "casual",
        })
      ).status,
    ).toBe(409);
    expect(
      (await request(`/conversations/${conversation._id}`, "DELETE")).status,
    ).toBe(409);
    controller.abort();
    await response.body?.cancel().catch(() => {});
    await eventually(
      async () =>
        (await repository.get(conversation._id)).messages[0]?.status ===
        "cancelled",
    );
    const saved = await repository.get(conversation._id);
    expect(saved.messages).toHaveLength(1);
    expect(
      (
        await request(`/conversations/${conversation._id}`, "PATCH", {
          tone: "casual",
        })
      ).status,
    ).toBe(200);
  });

  it("recovers an expired lease left by a crashed server and marks old pending prompts failed", async () => {
    const conversation = await newConversation();
    await repository.begin(input(conversation._id, "Abandoned question"));
    await ConversationModel.updateOne(
      { _id: conversation._id },
      { $set: { leaseUntil: new Date(Date.now() - 1000) } },
    );
    const recovered = await request(`/conversations/${conversation._id}`);
    expect((await recovered.json()).conversation.messages[0].status).toBe(
      "failed",
    );
    const response = await request(
      "/chat/stream",
      "POST",
      input(conversation._id, "New question"),
    );
    expect(readEvents(await response.text()).at(-1)?.event).toBe("done");
    const saved = await repository.get(conversation._id);
    expect(saved.messages.map(({ status }) => status)).toEqual([
      "failed",
      "completed",
      "completed",
    ]);
  });
});
