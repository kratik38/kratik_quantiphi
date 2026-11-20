import { describe, expect, it } from "vitest";
import { formatSSE } from "../src/services/sse.js";
import { readEvents } from "./helpers.js";

describe("SSE wire formatting", () => {
  it("encodes multiline and Unicode text inside a single structured JSON event", () => {
    const data = { text: "Hello\n\nevent: error\nこんにちは 👋" };
    const frame = formatSSE("delta", data);
    expect(frame).toBe(`event: delta\ndata: ${JSON.stringify(data)}\n\n`);
    expect(readEvents(frame)).toEqual([{ event: "delta", data }]);
  });
  it("produces independently delimited start, delta and done events", () => {
    const stream =
      formatSSE("start", { requestId: "id" }) +
      formatSSE("delta", { text: "a" }) +
      formatSSE("done", { conversation: { _id: "chat" } });
    expect(readEvents(stream).map(({ event }) => event)).toEqual([
      "start",
      "delta",
      "done",
    ]);
  });
});
