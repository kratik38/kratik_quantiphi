import "dotenv/config";
import type { AppConfig } from "../types.js";
export const config: AppConfig = {
  mongoUri:
    process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/ai_chat_assistant",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  port: Number(process.env.PORT || 3001),
};
