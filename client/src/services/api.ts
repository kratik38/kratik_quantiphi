import type { StreamEvent } from "../types";
const base = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:3001"
).replace(/\/$/, "");
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${base}/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      body.error?.message ||
        body.message ||
        `Request failed (${response.status}). Please try again.`,
    );
  return body as T;
}
/** POST streaming requires Fetch rather than EventSource. Decode across arbitrary byte boundaries. */
export async function streamChat(
  body: object,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
  path = "/chat/stream",
) {
  const response = await fetch(`${base}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      error.error?.message ||
        error.message ||
        `Unable to send (${response.status}).`,
    );
  }
  if (!response.body)
    throw new Error("Your browser does not support response streaming.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    terminal = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = frame
          .split("\n")
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim();
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!event || !data) continue; // heartbeat comments
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (event === "error")
          throw new Error(
            String(parsed.message || "Generation failed. Please retry."),
          );
        if (event === "done") terminal = true;
        onEvent({ event, data: parsed });
      }
      if (done) break;
    }
    if (!terminal)
      throw new Error(
        "The response was interrupted. Your prompt has been saved; you can retry.",
      );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
