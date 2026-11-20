import { z } from "zod";
export const toneSchema = z.enum(["professional", "casual", "concise"]);
export const idSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i, "Invalid conversation ID");
export const createConversationSchema = z
  .object({ tone: toneSchema.default("professional") })
  .strict();
export const updateConversationSchema = z
  .object({
    tone: toneSchema.optional(),
    title: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Provide a tone or title");
export const streamSchema = z
  .object({
    conversationId: idSchema,
    message: z.string().trim().min(1).max(16000),
    tone: toneSchema,
    requestId: z.string().uuid(),
  })
  .strict();
export type StreamInput = z.infer<typeof streamSchema>;
