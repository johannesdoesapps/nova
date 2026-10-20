/**
 * Chat: editing a sent question (which turns the model sees and which are
 * replaced), reply settings, and the request fields that carry them.
 */
import { describe, expect, it } from "vitest";
import { replyInstruction, replyTokens } from "@/lib/ai/reply-settings";
import { editedTurns, regeneratedReply } from "@/lib/db";
import { chatRequest, conversationPatch, conversationSearch } from "@/lib/validation";

const turns = [
  { id: "u1", role: "user", content: "first" },
  { id: "a1", role: "assistant", content: "one" },
  { id: "u2", role: "user", content: "second" },
  { id: "a2", role: "assistant", content: "two" },
];

describe("editing a question", () => {
  it("keeps the turns before it and replaces it and everything after", () => {
    expect(editedTurns(turns, "u2")).toEqual({ before: turns.slice(0, 2), superseded: ["u2", "a2"] });
    expect(editedTurns(turns, "u1")).toEqual({ before: [], superseded: ["u1", "a1", "u2", "a2"] });
  });

  it("only edits the user's own questions that are saved", () => {
    expect(editedTurns(turns, "a1")).toBeNull();
    expect(editedTurns(turns, "missing")).toBeNull();
  });

  it("still regenerates only the last reply", () => {
    expect(regeneratedReply(turns, "second")).toBe("a2");
    expect(regeneratedReply(turns, "first")).toBeNull();
  });
});

describe("reply settings", () => {
  it("adds instructions only for non-default settings", () => {
    expect(replyInstruction()).toBe("");
    expect(replyInstruction("normal", "balanced")).toBe("");
    expect(replyInstruction("short")).toMatch(/brief/);
    expect(replyInstruction("detailed", "precise")).toMatch(/thorough[\s\S]*precise/);
    expect(replyInstruction(undefined, "creative")).toMatch(/imaginative/);
  });

  it("shortens the output limit for short replies, never above the plan's", () => {
    expect(replyTokens(1200, "short")).toBe(480);
    expect(replyTokens(4800, "short")).toBe(1920);
    expect(replyTokens(600, "short")).toBe(400);
    expect(replyTokens(300, "short")).toBe(300);
    expect(replyTokens(2400, "detailed")).toBe(2400);
    expect(replyTokens(2400)).toBe(2400);
  });

  it("are accepted in chat requests, and unknown values aren't", () => {
    const base = { message: "hi" };
    expect(chatRequest.safeParse({ ...base, replyLength: "short", replyStyle: "creative", editOf: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
    expect(chatRequest.safeParse({ ...base, replyLength: "huge" }).success).toBe(false);
    expect(chatRequest.safeParse({ ...base, editOf: "not-a-uuid" }).success).toBe(false);
  });
});

describe("archiving", () => {
  it("is a conversation update, and the list can show archived chats", () => {
    expect(conversationPatch.safeParse({ archived: true }).success).toBe(true);
    expect(conversationPatch.safeParse({ archived: "yes" }).success).toBe(false);
    expect(conversationSearch.parse({ archived: "1" })).toEqual({ archived: "1" });
    expect(conversationSearch.safeParse({ archived: "true" }).success).toBe(false);
  });
});
