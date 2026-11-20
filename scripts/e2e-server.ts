// Test-only provider: the production entry point never imports this file.
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../server/src/app.js";
import type { AIService } from "../server/src/services/ai.js";
import { fileURLToPath } from "node:url";
const mongo = await MongoMemoryServer.create({
  binary: {
    downloadDir: fileURLToPath(
      new URL("../server/.cache/mongodb-binaries", import.meta.url),
    ),
  },
});
await mongoose.connect(mongo.getUri());
const ai: AIService = {
  async *generate(messages, tone, signal) {
    const prompt = messages.at(-1)?.content || "";
    if (prompt.includes("trigger-error"))
      throw new Error("Controlled provider failure");
    const answer = `**${tone}** response. Context contains ${messages.length} messages.\n\nA streamed explanation with \`safe code\` and a helpful conclusion.`;
    for (const char of answer) {
      await new Promise((resolve) =>
        setTimeout(resolve, prompt.includes("slow") ? 80 : 5),
      );
      if (signal.aborted) throw new Error("Aborted");
      yield char;
    }
  },
};
const server = createApp({
  ai,
  config: {
    mongoUri: mongo.getUri(),
    openaiApiKey: "test-only",
    openaiModel: "controlled-test",
    clientOrigin: "http://localhost:5173",
    port: 5017,
  },
}).listen(5017, "127.0.0.1");
async function close() {
  server.closeAllConnections();
  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
