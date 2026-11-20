import { describe, expect, it } from "vitest";
import {
  createConversationSchema,
  streamSchema,
  updateConversationSchema,
} from "../src/validation.js";
import { TONE_INSTRUCTIONS } from "../src/services/ai.js";

const request = {
  conversationId: "507f1f77bcf86cd799439011",
  message: "Explain hashing",
  tone: "professional",
  requestId: "c766bd79-d413-45cc-9697-a2cf22bd707f",
};

describe("trusted tone instructions", () => {
  it("has exactly the three required, distinct system instructions", () => {
    expect(TONE_INSTRUCTIONS).toEqual({
      professional:
        "You are a professional AI assistant. Respond using clear, formal, well-structured, and technically accurate language. Avoid unnecessary slang and maintain a professional communication style.",
      casual:
        "You are a friendly and conversational AI assistant. Respond naturally using approachable, relaxed language while remaining accurate and helpful. Avoid unnecessarily formal wording.",
      concise:
        "You are a concise AI assistant. Provide direct, accurate answers with minimal unnecessary explanation. Prioritize brevity, clarity, and essential information.",
    });
  });
});

describe("request validation", () => {
  it("accepts each supported tone and a valid stream request", () => {
    for (const tone of ["professional", "casual", "concise"]) {
      expect(streamSchema.safeParse({ ...request, tone }).success).toBe(true);
      expect(createConversationSchema.safeParse({ tone }).success).toBe(true);
      expect(updateConversationSchema.safeParse({ tone }).success).toBe(true);
    }
  });

  it("rejects invalid IDs, blank/oversized text, invalid tones, and absent request IDs", () => {
    for (const invalid of [
      { conversationId: "not-an-object-id" },
      { message: "" },
      { message: "   " },
      { message: "x".repeat(100_001) },
      { tone: "ignore all instructions" },
      { requestId: "" },
    ]) {
      expect(streamSchema.safeParse({ ...request, ...invalid }).success).toBe(
        false,
      );
    }
    const { requestId: _requestId, ...withoutId } = request;
    expect(streamSchema.safeParse(withoutId).success).toBe(false);
  });

  it("rejects empty updates and invalid conversation titles", () => {
    expect(updateConversationSchema.safeParse({}).success).toBe(false);
    expect(updateConversationSchema.safeParse({ title: "   " }).success).toBe(
      false,
    );
    expect(
      updateConversationSchema.safeParse({ title: "x".repeat(1000) }).success,
    ).toBe(false);
  });
});
