export type Tone = "professional" | "casual" | "concise";
export interface Message {
  _id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  tone: Tone;
  requestId: string;
}
export interface Conversation {
  _id: string;
  title: string;
  tone: Tone;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}
export type ConversationSummary = Omit<Conversation, "messages">;
export interface AppConfig {
  mongoUri: string;
  openaiApiKey: string;
  openaiModel: string;
  clientOrigin: string;
  port: number;
}
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
