import mongoose, { Schema } from "mongoose";
const tones = ["professional", "casual", "concise"];
const messageSchema = new Schema({
  role: { type: String, enum: ["user", "assistant"], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now, required: true },
  status: {
    type: String,
    enum: ["pending", "completed", "failed", "cancelled"],
    default: "completed",
  },
  tone: { type: String, enum: tones, required: true },
  requestId: { type: String, required: true },
  regenerationRequestId: { type: String },
});
const conversationSchema = new Schema(
  {
    title: { type: String, default: "New conversation", maxlength: 100 },
    tone: { type: String, enum: tones, default: "professional" },
    messages: { type: [messageSchema], default: [] },
    activeRequest: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
  },
  { timestamps: true },
);
conversationSchema.index({ updatedAt: -1 });
export const ConversationModel = mongoose.model(
  "Conversation",
  conversationSchema,
);
