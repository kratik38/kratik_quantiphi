import mongoose from "mongoose";
import { createApp } from "./app.js";
import { config } from "./config/env.js";
mongoose.set("bufferCommands", false);
const server = createApp().listen(
  config.port,
  process.env.HOST || "127.0.0.1",
  () => console.info(`AI Chat API listening on port ${config.port}`),
);
// Serve a useful health/configuration error even when initial database connection fails.
let connecting = false;
async function connect() {
  if (connecting || mongoose.connection.readyState === 1) return;
  connecting = true;
  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
    console.info("MongoDB connected.");
  } catch {
    console.error(
      "MongoDB unavailable. Check MONGODB_URI and database availability.",
    );
  } finally {
    connecting = false;
  }
}
void connect();
const reconnect = setInterval(() => void connect(), 10000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearInterval(reconnect);
    server.close(() => {
      void mongoose.disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
