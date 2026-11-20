import { streamChat } from "./api";
import type { Conversation, StreamEvent } from "../types";

/** Animate incoming chunks without waiting for the complete provider response. */
export async function streamProgressively(
  body: object,
  signal: AbortSignal,
  onText: (text: string) => void,
  onEvent: (event: StreamEvent) => void,
  path = "/chat/stream",
): Promise<Conversation | undefined> {
  let received = "",
    shown = "";
  let conversation: Conversation | undefined;
  const animation = window.setInterval(() => {
    if (shown === received || signal.aborted) return;
    shown = received.slice(
      0,
      shown.length +
        Math.max(1, Math.ceil((received.length - shown.length) / 3)),
    );
    onText(shown);
  }, 16);
  try {
    await streamChat(
      body,
      signal,
      (event) => {
        if (event.event === "delta")
          received += String(event.data.text ?? event.data.delta ?? "");
        if (event.event === "done")
          conversation = event.data.conversation as Conversation | undefined;
        onEvent(event);
      },
      path,
    );
    if (!signal.aborted) onText(received);
    return conversation;
  } finally {
    clearInterval(animation);
  }
}
