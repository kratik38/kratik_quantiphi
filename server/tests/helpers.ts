/** Parse a fully collected SSE response while preserving its structured event payloads. */
export function readEvents(
  text: string,
): Array<{ event: string; data: Record<string, unknown> }> {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .flatMap((frame) => {
      const lines = frame.split("\n");
      const event = lines
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim();
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!event || !data) return [];
      return [{ event, data: JSON.parse(data) as Record<string, unknown> }];
    });
}

/** Fail bounded asynchronous assertions instead of hanging a test on a stream. */
export async function eventually(
  check: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition did not become true within the bounded wait");
}
