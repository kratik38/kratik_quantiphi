import OpenAI from "openai";
import { AppError, type Message, type Tone } from "../types.js";
export const TONE_INSTRUCTIONS: Record<Tone, string> = {
  professional:
    "You are a professional AI assistant. Respond using clear, formal, well-structured, and technically accurate language. Avoid unnecessary slang and maintain a professional communication style.",
  casual:
    "You are a friendly and conversational AI assistant. Respond naturally using approachable, relaxed language while remaining accurate and helpful. Avoid unnecessarily formal wording.",
  concise:
    "You are a concise AI assistant. Provide direct, accurate answers with minimal unnecessary explanation. Prioritize brevity, clarity, and essential information.",
};
export interface AIService {
  generate(
    messages: Message[],
    tone: Tone,
    signal: AbortSignal,
  ): AsyncIterable<string>;
}
// A conservative UTF-8 byte budget plus a turn cap keeps requests bounded without a tokenizer dependency.
export function selectContext(messages: Message[]): Message[] {
  const selected: Message[] = [];
  let bytes = 0;
  for (const message of [...messages].reverse()) {
    if (message.role === "assistant" && message.status !== "completed")
      continue;
    if (
      message.role === "user" &&
      !["completed", "pending"].includes(message.status)
    )
      continue;
    const size = Buffer.byteLength(message.content, "utf8");
    if (selected.length >= 40 || bytes + size > 64000) break;
    selected.unshift(message);
    bytes += size;
  }
  return selected;
}
export class OpenAIService implements AIService {
  constructor(
    private apiKey: string,
    private model: string,
  ) {}
  async *generate(messages: Message[], tone: Tone, signal: AbortSignal) {
    if (!this.apiKey || this.apiKey === "your_api_key_here")
      throw new AppError(
        503,
        "AI_NOT_CONFIGURED",
        "Set OPENAI_API_KEY in server/.env and restart the server.",
      );
    const client = new OpenAI({
      apiKey: this.apiKey,
      timeout: 110000,
      maxRetries: 0,
    });
    const stream = await client.responses.create(
      {
        model: this.model,
        instructions: TONE_INSTRUCTIONS[tone],
        input: selectContext(messages).map((m) => ({
          role: m.role,
          content: m.content,
        })),
        max_output_tokens: 4096,
        stream: true,
        store: false,
      },
      { signal },
    );
    let completed = false;
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") yield event.delta;
      if (event.type === "response.completed") completed = true;
      if (
        event.type === "response.failed" ||
        event.type === "response.incomplete" ||
        event.type === "error"
      )
        throw new AppError(
          502,
          "AI_INCOMPLETE",
          "The AI response was interrupted. Please retry your message.",
        );
    }
    if (!completed)
      throw new AppError(
        502,
        "AI_INCOMPLETE",
        "The AI stream ended before completion. Please retry.",
      );
  }
}
export function safeAIError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const status = (error as { status?: number })?.status;
  if (status === 401 || status === 403)
    return new AppError(
      502,
      "AI_AUTH_ERROR",
      "OpenAI rejected the server credentials. Check OPENAI_API_KEY and model access.",
    );
  if (status === 429)
    return new AppError(
      429,
      "AI_RATE_LIMIT",
      "OpenAI rate or quota limit reached. Check your quota and try again later.",
    );
  if (status === 404)
    return new AppError(
      502,
      "AI_MODEL_ERROR",
      "The configured OpenAI model is unavailable. Check OPENAI_MODEL.",
    );
  return new AppError(
    502,
    "AI_UNAVAILABLE",
    "The AI service could not complete the response. Please retry.",
  );
}
