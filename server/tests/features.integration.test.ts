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
async function seedConversation(
  turns: Array<[string, string]> = [["Explain hashing", "Original answer"]],
): Promise<Conversation> {
  const conversation = await repository.create("professional");
  for (const [prompt, answer] of turns) {
    const requestId = crypto.randomUUID();
    const started = await repository.begin({
      conversationId: conversation._id,
      message: prompt,
      tone: "professional",
      requestId,
    });
    await repository.complete(
      conversation._id,
      requestId,
      started.assistantMessageId,
      answer,
      "professional",
    );
  }
  return repository.get(conversation._id);
}
const regeneration = (conversation: Conversation, tone: Tone = "casual") => ({
  conversationId: conversation._id,
  messageId: [...conversation.messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.status === "completed")!._id,
  tone,
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({
    binary: {
      downloadDir: fileURLToPath(
        new URL("../.cache/mongodb-binaries", import.meta.url),
      ),
    },
  });
  await mongoose.connect(mongo.getUri());
  server = createApp({
    repository,
    ai,
    config: {
      mongoUri: "",
      openaiApiKey: "test-only-key",
      openaiModel: "test-model",
      clientOrigin: "http://localhost:5173",
      port: 0,
    },
  }).listen(0, "127.0.0.1");
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
    yield "$Replacement ";
    yield "answer";
  });
});

describe("regenerating the latest assistant response", () => {
  it("streams a stable-ID replacement using the current tone and preceding context without duplicating prompts", async () => {
    const original = await seedConversation([
      ["First question", "First answer"],
      ["Second question", "Original latest answer"],
    ]);
    const abandoned = await repository.begin({
      conversationId: original._id,
      message: "Later failed user message",
      tone: "professional",
      requestId: crypto.randomUUID(),
    });
    await repository.fail(
      original._id,
      abandoned.conversation.messages.at(-1)!.requestId,
      "failed",
    );
    const before = await repository.get(original._id);
    const body = regeneration(before, "concise");
    generate.mockImplementation(async function* (messages, tone) {
      expect(tone).toBe("concise");
      expect(messages.map((m) => [m.role, m.content])).toEqual([
        ["user", "First question"],
        ["assistant", "First answer"],
        ["user", "Second question"],
      ]);
      expect((await repository.get(before._id)).messages).toEqual(
        before.messages,
      );
      yield "$Replacement ";
      yield "answer";
    });
    const response = await request("/chat/regenerate", "POST", body);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = readEvents(await response.text());
    expect(events.map((e) => e.event)).toEqual([
      "start",
      "delta",
      "delta",
      "done",
    ]);
    expect(events[0]?.data.assistantMessageId).toBe(body.messageId);
    const refreshed = (
      await (await request(`/conversations/${before._id}`)).json()
    ).conversation as Conversation;
    expect(refreshed.messages).toHaveLength(before.messages.length);
    expect(refreshed.messages.filter((m) => m.role === "user")).toEqual(
      before.messages.filter((m) => m.role === "user"),
    );
    expect(
      refreshed.messages.find((m) => m._id === body.messageId),
    ).toMatchObject({
      _id: body.messageId,
      content: "$Replacement answer",
      tone: "concise",
      status: "completed",
    });
    expect(refreshed.messages[1]).toEqual(before.messages[1]);
    expect(refreshed.messages.at(-1)).toEqual(before.messages.at(-1));
    expect(
      refreshed.messages.find((m) => m._id === body.messageId)?.requestId,
    ).toBe(before.messages.find((m) => m._id === body.messageId)?.requestId);

    expect(refreshed.tone).toBe("concise");
    expect(await ConversationModel.countDocuments()).toBe(1);

    const prompt = before.messages.find(
      (m) =>
        m.role === "user" &&
        m.requestId ===
          before.messages.find((m) => m._id === body.messageId)?.requestId,
    )!;
    const replay = readEvents(
      await (
        await request("/chat/stream", "POST", {
          conversationId: before._id,
          message: prompt.content,
          tone: prompt.tone,
          requestId: prompt.requestId,
        })
      ).text(),
    );
    expect(replay.map((e) => e.event)).toEqual(["start", "done"]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(
      (await repository.get(before._id)).messages.find(
        (m) => m._id === body.messageId,
      )?.content,
    ).toBe("$Replacement answer");
  });

  it("preserves the original answer and releases the lease on interrupted provider output", async () => {
    const original = await seedConversation();
    generate.mockImplementationOnce(async function* () {
      yield "Incomplete replacement";
      throw { status: 429, message: "provider-secret-detail" };
    });
    const events = readEvents(
      await (
        await request("/chat/regenerate", "POST", regeneration(original))
      ).text(),
    );
    expect(events.at(-1)).toMatchObject({
      event: "error",
      data: { code: "AI_RATE_LIMIT" },
    });
    expect(JSON.stringify(events)).not.toContain("provider-secret-detail");
    expect((await repository.get(original._id)).messages).toEqual(
      original.messages,
    );
    const retry = readEvents(
      await (
        await request("/chat/regenerate", "POST", regeneration(original))
      ).text(),
    );
    expect(retry.at(-1)?.event).toBe("done");
    expect((await repository.get(original._id)).messages).toHaveLength(2);
  });

  it("cancels safely and blocks competing generation, submission and edits", async () => {
    const original = await seedConversation();
    let started = false;
    generate.mockImplementationOnce(async function* (_messages, _tone, signal) {
      started = true;
      yield "Temporary replacement";
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const controller = new AbortController();
    const body = regeneration(original);
    const response = await fetch(`${base}/chat/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    await eventually(async () => started);
    expect((await request("/chat/regenerate", "POST", body)).status).toBe(409);
    expect(
      (
        await request("/chat/stream", "POST", {
          conversationId: original._id,
          message: "Competing prompt",
          tone: "casual",
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/conversations/${original._id}`, "PATCH", {
          tone: "concise",
        })
      ).status,
    ).toBe(409);
    controller.abort();
    await response.body?.cancel().catch(() => {});
    await eventually(
      async () =>
        (await ConversationModel.findById(original._id))?.activeRequest ===
        null,
    );
    expect((await repository.get(original._id)).messages).toEqual(
      original.messages,
    );
    expect(
      (
        await request(`/conversations/${original._id}`, "PATCH", {
          tone: "concise",
        })
      ).status,
    ).toBe(200);
  });

  it("replays a completed regeneration request without calling the provider twice", async () => {
    const original = await seedConversation();
    const body = { ...regeneration(original), requestId: crypto.randomUUID() };
    const first = readEvents(
      await (await request("/chat/regenerate", "POST", body)).text(),
    );
    expect(first.at(-1)?.event).toBe("done");
    const saved = (await repository.get(original._id)).messages;
    const replay = readEvents(
      await (await request("/chat/regenerate", "POST", body)).text(),
    );
    expect(replay.map((e) => e.event)).toEqual(["start", "done"]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await repository.get(original._id)).messages).toEqual(saved);
  });

  it("rejects stale completion after a lease expires without replacing the original answer", async () => {
    const original = await seedConversation();
    const first = { ...regeneration(original), requestId: crypto.randomUUID() };
    await repository.beginRegeneration(first);
    await ConversationModel.updateOne(
      { _id: original._id },
      { $set: { leaseUntil: new Date(Date.now() - 1000) } },
    );
    const second = {
      ...regeneration(original),
      requestId: crypto.randomUUID(),
    };
    await repository.beginRegeneration(second);
    await expect(
      repository.completeRegeneration(
        original._id,
        first.requestId,
        first.messageId,
        "Stale replacement",
        "casual",
      ),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
    expect((await repository.get(original._id)).messages).toEqual(
      original.messages,
    );
    await repository.failRegeneration(original._id, second.requestId);
  });

  it("preserves the original on an empty replacement rather than saving an empty answer", async () => {
    const original = await seedConversation();
    generate.mockImplementationOnce(async function* () {
      yield "  ";
    });
    const events = readEvents(
      await (
        await request("/chat/regenerate", "POST", regeneration(original))
      ).text(),
    );
    expect(events.at(-1)).toMatchObject({
      event: "error",
      data: { code: "AI_EMPTY" },
    });
    expect((await repository.get(original._id)).messages).toEqual(
      original.messages,
    );
  });

  it("rejects old or non-assistant targets and invalid requests without changing stored messages", async () => {
    const original = await seedConversation([
      ["First", "First answer"],
      ["Second", "Second answer"],
    ]);
    const valid = regeneration(original);
    for (const changes of [
      { conversationId: "bad-id" },
      { messageId: "bad-id" },
      { tone: "arbitrary" },
      { requestId: "bad-uuid" },
      { system: "untrusted" },
    ]) {
      expect(
        (await request("/chat/regenerate", "POST", { ...valid, ...changes }))
          .status,
      ).toBe(400);
    }
    const old = await request("/chat/regenerate", "POST", {
      ...valid,
      messageId: original.messages[1]!._id,
    });
    expect(old.status).toBe(409);
    const userTarget = await request("/chat/regenerate", "POST", {
      ...valid,
      messageId: original.messages[0]!._id,
    });
    expect(userTarget.status).toBe(404);
    const absent = await request("/chat/regenerate", "POST", {
      ...valid,
      messageId: new mongoose.Types.ObjectId().toString(),
    });
    expect(absent.status).toBe(404);
    expect(generate).not.toHaveBeenCalled();
    expect((await repository.get(original._id)).messages).toEqual(
      original.messages,
    );
  });
});

describe("persisted conversation search", () => {
  it("finds title and message matches case-insensitively with stable navigation IDs and bounded projection", async () => {
    const titleMatch = await seedConversation([
      ["A normal prompt", "A normal answer"],
    ]);
    await repository.update(titleMatch._id, { title: "Launch Planning" });
    const messageMatch = await seedConversation([
      ["An unrelated question", "The hiddenNeedle is in this stored answer."],
    ]);
    const titleResponse = await request("/conversations/search?q=LAUNCH");
    expect(titleResponse.status).toBe(200);
    const titleResults = (await titleResponse.json()).results;
    expect(titleResults).toHaveLength(1);
    expect(titleResults[0]).toMatchObject({
      _id: titleMatch._id,
      title: "Launch Planning",
      messageId: null,
    });
    const response = await request("/conversations/search?q=HIDDENneedle");
    expect(response.status).toBe(200);
    const results = (await response.json()).results;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      _id: messageMatch._id,
      messageId: messageMatch.messages[1]!._id,
    });
    expect(results[0].snippet.toLowerCase()).toContain("hiddenneedle");
    for (const result of [titleResults[0], results[0]]) {
      expect(Object.keys(result).sort()).toEqual(
        [
          "_id",
          "title",
          "tone",
          "createdAt",
          "updatedAt",
          "snippet",
          "messageId",
        ].sort(),
      );
      expect(result.snippet.length).toBeLessThanOrEqual(250);
    }
    // A fresh repository has no browser/history cache: results still come from MongoDB.
    const fresh = new MongoConversationRepository();
    expect((await fresh.get(messageMatch._id)).messages[1]?._id).toBe(
      results[0].messageId,
    );
  });

  it("treats regex metacharacters literally and returns a useful empty result", async () => {
    const literal = ".*[abc](x)+?";
    const matching = await seedConversation([
      ["Literal query", `Stored characters: ${literal} are intentional`],
    ]);
    await seedConversation([
      ["Other question", "Everything would match an unescaped wildcard"],
    ]);
    const response = await request(
      `/conversations/search?${new URLSearchParams({ q: literal })}`,
    );
    const results = (await response.json()).results;
    expect(results).toHaveLength(1);
    expect(results[0]._id).toBe(matching._id);
    expect(
      (
        await (
          await request("/conversations/search?q=not-present-anywhere")
        ).json()
      ).results,
    ).toEqual([]);
  });

  it("centers snippets on Unicode case-insensitive matches far into stored content", async () => {
    const conversation = await seedConversation([
      ["Unicode discussion", `${"😀".repeat(220)} ÉCOLE and its explanation`],
    ]);
    const response = await request(
      `/conversations/search?${new URLSearchParams({ q: "école" })}`,
    );
    expect(response.status).toBe(200);
    const { results } = await response.json();
    expect(results).toHaveLength(1);
    expect(results[0].messageId).toBe(conversation.messages[1]!._id);
    expect(results[0].snippet).toContain("ÉCOLE");
    expect([...results[0].snippet].length).toBeLessThanOrEqual(180);
  });

  it("validates query length and shape before running a search", async () => {
    for (const query of [
      "",
      "q=",
      "q=%20%20",
      `q=${"x".repeat(101)}`,
      "q=one&q=two",
      "q[$ne]=anything",
    ]) {
      expect((await request(`/conversations/search?${query}`)).status).toBe(
        400,
      );
    }
  });

  it("limits recent results and emits short snippets around content matches", async () => {
    const records = [];
    for (let i = 0; i < 23; i++) {
      const timestamp = new Date(Date.UTC(2025, 0, i + 1));
      records.push({
        title: `Searchable ${i}`,
        tone: "professional",
        messages: [
          {
            _id: new mongoose.Types.ObjectId(),
            role: "user",
            content: `${"prefix ".repeat(80)}needle marker ${i} ${"suffix ".repeat(80)}`,
            timestamp,
            status: "completed",
            tone: "professional",
            requestId: crypto.randomUUID(),
          },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    // Direct collection writes preserve controlled timestamps for a deterministic recency assertion.
    await ConversationModel.collection.insertMany(records);
    const results = (
      await (await request("/conversations/search?q=needle")).json()
    ).results;
    expect(results).toHaveLength(20);
    expect(results[0].title).toBe("Searchable 22");
    expect(results.at(-1).title).toBe("Searchable 3");
    expect(
      results.every(
        (r: { snippet: string; messageId: string }) =>
          r.snippet.includes("needle") &&
          r.snippet.length <= 250 &&
          /^[a-f\d]{24}$/.test(r.messageId),
      ),
    ).toBe(true);
  });
});
