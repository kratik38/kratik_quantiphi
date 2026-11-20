export type Tone = "professional" | "casual" | "concise";
export interface Message {
  _id?: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  status?: "pending" | "completed" | "failed" | "cancelled";
  tone?: Tone;
  requestId?: string;
}
export interface Conversation {
  _id: string;
  title: string;
  tone: Tone;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}
export type Summary = Omit<Conversation, "messages">;
export interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}
