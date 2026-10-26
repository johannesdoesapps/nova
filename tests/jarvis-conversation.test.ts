/** Conversation mode's rules: what ends a conversation, and when Jarvis may listen. */
import { describe, expect, it } from "vitest";
import { isStopPhrase, shouldListen, type ListenGate } from "@/lib/jarvis/conversation";

describe("stop phrases", () => {
  it("end the conversation when the whole utterance is one", () => {
    for (const t of ["Stop", "stop.", "Stop listening", "OK Jarvis, stop", "Goodbye!", "bye Jarvis", "That's all, thanks", "that’s it", "We're done", "Never mind", "  END   the conversation "]) {
      expect(isStopPhrase(t), t).toBe(true);
    }
  });

  it("don't swallow real requests that contain the words", () => {
    for (const t of ["Stop the music", "Say goodbye to Sam for me", "What's the stop for the 42 bus?", "Is that all I need for the trip?", "", "   ", "Jarvis"]) {
      expect(isStopPhrase(t), t).toBe(false);
    }
  });
});

describe("when to listen", () => {
  const idle: ListenGate = { on: true, supported: true, listening: false, busy: false, speaking: false, visible: true, typing: false };
  it("listens only when the conversation is on and Jarvis is idle, quiet and in view", () => {
    expect(shouldListen(idle)).toBe(true);
    expect(shouldListen({ ...idle, on: false })).toBe(false);
    expect(shouldListen({ ...idle, supported: false })).toBe(false);
    expect(shouldListen({ ...idle, listening: true })).toBe(false);
    // Never while Jarvis is answering, running a mission or waiting for an approval click.
    expect(shouldListen({ ...idle, busy: true })).toBe(false);
    // Never while it speaks, so it can't hear itself.
    expect(shouldListen({ ...idle, speaking: true })).toBe(false);
    // Nothing is heard from a background tab.
    expect(shouldListen({ ...idle, visible: false })).toBe(false);
    expect(shouldListen({ ...idle, typing: true })).toBe(false);
  });
});
