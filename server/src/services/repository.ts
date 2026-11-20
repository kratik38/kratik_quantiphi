import mongoose from "mongoose";
import { ConversationModel } from "../models/Conversation.js";
import {
  AppError,
  type Conversation,
  type ConversationSummary,
  type Tone,
  type SearchResult,
  type Message,
} from "../types.js";
import type { StreamInput, RegenerateInput } from "../validation.js";
function plain(doc: unknown): Conversation {
  const value = JSON.parse(JSON.stringify(doc));
  delete value.activeRequest;
  delete value.leaseUntil;
  delete value.__v;
  return value as Conversation;
}
export interface BeginResult {
  conversation: Conversation;
  replay: boolean;
  assistantMessageId: string;
  context?: Message[];
}
export interface ConversationRepository {
  isReady(): boolean;
  list(): Promise<ConversationSummary[]>;
  search(query: string): Promise<SearchResult[]>;
  beginRegeneration(input: RegenerateInput): Promise<BeginResult>;
  completeRegeneration(
    id: string,
    requestId: string,
    messageId: string,
    content: string,
    tone: Tone,
  ): Promise<Conversation>;
  failRegeneration(id: string, requestId: string): Promise<Conversation>;
  create(tone: Tone): Promise<Conversation>;
  get(id: string): Promise<Conversation>;
  update(
    id: string,
    changes: { title?: string; tone?: Tone },
  ): Promise<Conversation>;
  delete(id: string): Promise<void>;
  begin(input: StreamInput): Promise<BeginResult>;
  complete(
    id: string,
    requestId: string,
    assistantMessageId: string,
    content: string,
    tone: Tone,
  ): Promise<Conversation>;
  fail(
    id: string,
    requestId: string,
    status: "failed" | "cancelled",
  ): Promise<Conversation>;
}
export class MongoConversationRepository implements ConversationRepository {
  isReady() {
    return mongoose.connection.readyState === 1;
  }
  private async recoverExpired(id?: string) {
    await ConversationModel.updateMany(
      {
        ...(id ? { _id: id } : {}),
        activeRequest: { $ne: null },
        leaseUntil: { $lt: new Date() },
      },
      {
        $set: {
          activeRequest: null,
          leaseUntil: null,
          "messages.$[pending].status": "failed",
        },
      },
      { arrayFilters: [{ "pending.status": "pending" }] },
    );
  }
  async list() {
    await this.recoverExpired();
    return (
      await ConversationModel.find()
        .select("-messages -activeRequest -leaseUntil")
        .sort({ updatedAt: -1 })
        .lean()
    ).map((d) => plain(d));
  }
  async search(query: string): Promise<SearchResult[]> {
    // Literal matching avoids regex injection. Bounds, a result cap and a query deadline
    // keep this single-user search predictable; histories never leave MongoDB in bulk.
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(escaped, "i");
    const matches = await ConversationModel.aggregate([
      {
        $match: {
          $or: [{ title: expression }, { "messages.content": expression }],
        },
      },
      { $sort: { updatedAt: -1, _id: -1 } },
      { $limit: 20 },
      {
        $project: {
          title: 1,
          tone: 1,
          createdAt: 1,
          updatedAt: 1,
          match: {
            $arrayElemAt: [
              {
                $filter: {
                  input: "$messages",
                  as: "message",
                  cond: {
                    $regexMatch: {
                      input: "$$message.content",
                      regex: expression,
                    },
                  },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $project: {
          title: 1,
          tone: 1,
          createdAt: 1,
          updatedAt: 1,
          messageId: { $ifNull: ["$match._id", null] },
          snippet: {
            $let: {
              vars: { source: { $ifNull: ["$match.content", "$title"] } },
              in: {
                $substrCP: [
                  "$$source",
                  {
                    $max: [
                      0,
                      {
                        $subtract: [
                          {
                            $let: {
                              vars: {
                                location: {
                                  $regexFind: {
                                    input: "$$source",
                                    regex: expression,
                                  },
                                },
                              },
                              in: "$$location.idx",
                            },
                          },
                          55,
                        ],
                      },
                    ],
                  },
                  180,
                ],
              },
            },
          },
        },
      },
    ]).option({ maxTimeMS: 2000 });
    return JSON.parse(JSON.stringify(matches)) as SearchResult[];
  }
  async beginRegeneration(input: RegenerateInput): Promise<BeginResult> {
    await this.recoverExpired(input.conversationId);
    const doc = await ConversationModel.findOneAndUpdate(
      {
        _id: input.conversationId,
        activeRequest: null,
      },
      {
        $set: {
          activeRequest: input.requestId,
          leaseUntil: new Date(Date.now() + 180000),
        },
      },
      { new: true },
    );
    if (!doc) {
      await this.get(input.conversationId);
      throw new AppError(
        409,
        "CONVERSATION_BUSY",
        "A response is already being generated in this conversation.",
      );
    }
    try {
      const conversation = plain(doc);
      const index = conversation.messages.findIndex(
        (message) =>
          message._id === input.messageId &&
          message.role === "assistant" &&
          message.status === "completed",
      );
      const latest = [...conversation.messages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" && message.status === "completed",
        );
      if (index < 0)
        throw new AppError(
          404,
          "MESSAGE_NOT_FOUND",
          "Completed assistant response not found.",
        );
      if (latest?._id !== input.messageId)
        throw new AppError(
          409,
          "REGENERATION_NOT_LATEST",
          "Only the latest completed assistant response can be regenerated.",
        );
      const target = conversation.messages[index]!;
      const promptIndex = conversation.messages.findIndex(
        (message, messageIndex) =>
          messageIndex < index &&
          message.role === "user" &&
          message.requestId === target.requestId,
      );
      if (promptIndex < 0)
        throw new AppError(
          409,
          "PROMPT_NOT_FOUND",
          "The original user prompt could not be found.",
        );
      const replay = target.regenerationRequestId === input.requestId;
      if (replay && target.tone !== input.tone)
        throw new AppError(
          409,
          "REQUEST_CONFLICT",
          "This regeneration request ID was already used with another tone.",
        );
      if (replay)
        await ConversationModel.updateOne(
          { _id: doc._id, activeRequest: input.requestId },
          { $set: { activeRequest: null, leaseUntil: null } },
        );
      return {
        conversation: await this.get(input.conversationId),
        assistantMessageId: input.messageId,
        replay,
        context: conversation.messages.slice(0, promptIndex + 1),
      };
    } catch (error) {
      await ConversationModel.updateOne(
        { _id: doc._id, activeRequest: input.requestId },
        { $set: { activeRequest: null, leaseUntil: null } },
      );
      throw error;
    }
  }
  async completeRegeneration(
    id: string,
    requestId: string,
    messageId: string,
    content: string,
    tone: Tone,
  ) {
    const result = await ConversationModel.updateOne(
      {
        _id: id,
        activeRequest: requestId,
        messages: {
          $elemMatch: {
            _id: new mongoose.Types.ObjectId(messageId),
            role: "assistant",
            status: "completed",
          },
        },
      },
      {
        $set: {
          "messages.$.content": content,
          "messages.$.timestamp": new Date(),
          "messages.$.tone": tone,
          "messages.$.regenerationRequestId": requestId,
          tone,
          activeRequest: null,
          leaseUntil: null,
        },
      },
    );
    if (result.modifiedCount !== 1)
      throw new AppError(
        409,
        "LEASE_LOST",
        "The regenerated response could not be saved. Reload and retry.",
      );
    return this.get(id);
  }
  async failRegeneration(id: string, requestId: string) {
    await ConversationModel.updateOne(
      { _id: id, activeRequest: requestId },
      { $set: { activeRequest: null, leaseUntil: null } },
    );
    return this.get(id);
  }
  async create(tone: Tone) {
    return plain(await ConversationModel.create({ tone }));
  }
  async get(id: string) {
    await this.recoverExpired(id);
    const doc = await ConversationModel.findById(id).select(
      "-activeRequest -leaseUntil",
    );
    if (!doc) throw new AppError(404, "NOT_FOUND", "Conversation not found.");
    return plain(doc);
  }
  async update(id: string, changes: { title?: string; tone?: Tone }) {
    const doc = await ConversationModel.findOneAndUpdate(
      {
        _id: id,
        $or: [{ activeRequest: null }, { leaseUntil: { $lt: new Date() } }],
      },
      { $set: changes },
      { new: true, runValidators: true },
    ).select("-activeRequest -leaseUntil");
    if (!doc) {
      await this.get(id);
      throw new AppError(
        409,
        "CONVERSATION_BUSY",
        "Wait for the current response before editing this conversation.",
      );
    }
    return plain(doc);
  }
  async delete(id: string) {
    const doc = await ConversationModel.findOneAndDelete({
      _id: id,
      $or: [{ activeRequest: null }, { leaseUntil: { $lt: new Date() } }],
    });
    if (!doc) {
      await this.get(id);
      throw new AppError(
        409,
        "CONVERSATION_BUSY",
        "Stop the current response before deleting this conversation.",
      );
    }
  }
  async begin(input: StreamInput): Promise<BeginResult> {
    // The database lease prevents simultaneous streams even across Node processes.
    const doc = await ConversationModel.findOneAndUpdate(
      {
        _id: input.conversationId,
        $or: [{ activeRequest: null }, { leaseUntil: { $lt: new Date() } }],
      },
      {
        $set: {
          activeRequest: input.requestId,
          leaseUntil: new Date(Date.now() + 180000),
        },
      },
      { new: true },
    );
    if (!doc) {
      await this.get(input.conversationId);
      throw new AppError(
        409,
        "CONVERSATION_BUSY",
        "A response is already being generated in this conversation.",
      );
    }
    try {
      const prior = doc.messages.find(
        (m) => m.role === "user" && m.requestId === input.requestId,
      );
      if (
        prior &&
        (prior.content !== input.message || prior.tone !== input.tone)
      )
        throw new AppError(
          409,
          "REQUEST_CONFLICT",
          "This request ID has already been used with a different message or tone.",
        );
      const answer = doc.messages.find(
        (m) =>
          m.role === "assistant" &&
          m.requestId === input.requestId &&
          m.status === "completed",
      );
      if (answer) {
        await ConversationModel.updateOne(
          { _id: doc._id, activeRequest: input.requestId },
          { $set: { activeRequest: null, leaseUntil: null } },
        );
        return {
          conversation: await this.get(input.conversationId),
          replay: true,
          assistantMessageId: answer._id.toString(),
        };
      }
      if (
        prior &&
        doc.messages[doc.messages.length - 1]?._id.toString() !==
          prior._id.toString()
      )
        throw new AppError(
          409,
          "RETRY_OUT_OF_ORDER",
          "Only the most recent failed message can be retried. Start a new message instead.",
        );
      // Any pending prompt left by a crashed process becomes a recoverable failed turn.
      for (const message of doc.messages)
        if (message.status === "pending") message.status = "failed";
      if (prior) prior.status = "pending";
      else
        doc.messages.push({
          role: "user",
          content: input.message,
          timestamp: new Date(),
          status: "pending",
          tone: input.tone,
          requestId: input.requestId,
        });
      doc.tone = input.tone;
      if (doc.messages.length === 1)
        doc.title = input.message.replace(/\s+/g, " ").slice(0, 60);
      await doc.save();
      return {
        conversation: await this.get(input.conversationId),
        replay: false,
        assistantMessageId: new mongoose.Types.ObjectId().toString(),
      };
    } catch (error) {
      await ConversationModel.updateOne(
        { _id: doc._id, activeRequest: input.requestId },
        { $set: { activeRequest: null, leaseUntil: null } },
      );
      throw error;
    }
  }
  async complete(
    id: string,
    requestId: string,
    assistantMessageId: string,
    content: string,
    tone: Tone,
  ) {
    const answer = {
      _id: new mongoose.Types.ObjectId(assistantMessageId),
      role: "assistant",
      content,
      timestamp: new Date(),
      status: "completed",
      tone,
      requestId,
    };
    // A pipeline changes the prompt and appends its answer in a single atomic document update.
    // $literal ensures user/model text beginning with '$' is never interpreted as an expression.
    const result = await ConversationModel.updateOne(
      { _id: id, activeRequest: requestId, "messages.requestId": requestId },
      [
        {
          $set: {
            messages: {
              $concatArrays: [
                {
                  $map: {
                    input: "$messages",
                    as: "message",
                    in: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ["$$message.role", "user"] },
                            {
                              $eq: [
                                "$$message.requestId",
                                { $literal: requestId },
                              ],
                            },
                          ],
                        },
                        {
                          $mergeObjects: ["$$message", { status: "completed" }],
                        },
                        "$$message",
                      ],
                    },
                  },
                },
                { $literal: [answer] },
              ],
            },
            activeRequest: null,
            leaseUntil: null,
          },
        },
      ],
    );
    if (result.modifiedCount !== 1)
      throw new AppError(
        409,
        "LEASE_LOST",
        "The response could not be saved. Reload the conversation before retrying.",
      );
    return this.get(id);
  }
  async fail(id: string, requestId: string, status: "failed" | "cancelled") {
    await ConversationModel.updateOne(
      { _id: id, activeRequest: requestId, "messages.requestId": requestId },
      {
        $set: {
          "messages.$.status": status,
          activeRequest: null,
          leaseUntil: null,
        },
      },
    );
    return this.get(id);
  }
}
