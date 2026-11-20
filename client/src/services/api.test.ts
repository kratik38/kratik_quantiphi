import { afterEach, describe, expect, it, vi } from "vitest";
import { api, streamChat } from "./api";

function streamed(text: string, splitEveryByte = false) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (splitEveryByte)
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        else controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

describe("Fetch SSE client", () => {
  it("decodes Unicode and event boundaries split at every byte and ignores heartbeats", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          streamed(
            ': heartbeat\n\nevent: start\ndata: {"requestId":"one"}\n\nevent: delta\ndata: {"text":"Hi 👋 नमस्ते\\nnext"}\n\nevent: done\ndata: {"conversation":{"_id":"one"}}\n\n',
            true,
          ),
        ),
    );
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    await streamChat({ message: "test" }, signal(), (event) =>
      events.push(event),
    );
    expect(events.map(({ event }) => event)).toEqual([
      "start",
      "delta",
      "done",
    ]);
    expect(events[1]?.data.text).toBe("Hi 👋 नमस्ते\nnext");
  });
  it("accepts CRLF line endings split across byte chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          streamed(
            'event: delta\r\ndata: {"text":"ok"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n',
            true,
          ),
        ),
    );
    const onEvent = vi.fn();
    await streamChat({}, signal(), onEvent);
    expect(onEvent.mock.calls.map(([event]) => event.event)).toEqual([
      "delta",
      "done",
    ]);
  });
  it("rejects premature EOF instead of leaving loading active", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          streamed('event: delta\ndata: {"text":"partial"}\n\n'),
        ),
    );
    await expect(streamChat({}, signal(), vi.fn())).rejects.toThrow(
      "interrupted",
    );
  });
  it("reports a structured SSE error without fabricating a completed answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          streamed(
            'event: error\ndata: {"code":"AI_RATE_LIMIT","message":"Quota exceeded"}\n\n',
          ),
        ),
    );
    await expect(streamChat({}, signal(), vi.fn())).rejects.toThrow(
      "Quota exceeded",
    );
  });
  it("surfaces HTTP validation errors and passes AbortController signal to fetch", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid tone" } }), {
        status: 400,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await expect(
      streamChat({ tone: "invalid" }, controller.signal, vi.fn()),
    ).rejects.toThrow("Invalid tone");
    expect(fetch.mock.calls[0]?.[1].signal).toBe(controller.signal);
  });
  it("rejects malformed SSE JSON rather than committing corrupted output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(streamed("event: delta\ndata: {bad}\n\n")),
    );
    await expect(streamChat({}, signal(), vi.fn())).rejects.toThrow();
  });
  it("surfaces REST errors consistently", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { message: "Database unavailable" } }),
            { status: 503 },
          ),
        ),
    );
    await expect(api("/conversations")).rejects.toThrow("Database unavailable");
  });
});
