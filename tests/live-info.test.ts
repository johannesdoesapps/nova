/**
 * The "no live data" note is added only to questions about things that change
 * day to day. Ordinary questions that happen to use words like "score", "price
 * of", "currently" or "right now" no longer get a needless warning.
 */
import { describe, expect, it } from "vitest";
import { needsLiveInfo } from "@/lib/ai/turn-context";

const LIVE = [
  "what's the weather in Paris tomorrow",
  "latest news about the election",
  "bitcoin price today",
  "who won the match last night",
  "what is the exchange rate from euro to dollar",
  "Apple stock price",
  "current headlines in the UK",
  "is the Louvre open on Monday",
  "score of the Lakers game",
  "what are the newest iPhone models just released",
  "forecast for London this weekend",
  "breaking news in tech",
  "what happened this week in AI",
  "what's the share price of Nvidia right now",
  "latest version of Node.js",
];
const GENERAL = [
  "what is a good credit score",
  "how is the SAT scored and what is a good score",
  "explain the price of anarchy in game theory",
  "the price of a book in 1900",
  "I need help with my essay right now",
  "what am I currently doing wrong in this code",
  "how do I improve my test scores",
  "summarise recent chapters of my notes",
  "what's the best way to make money online",
  "when did ww2 start",
  "write a poem about rain",
  "what does 'currently' mean in grammar",
  "explain the scoring rules of tennis",
  "how do exchange students apply",
  "recently I started running, how do I avoid injuries",
];

describe("live information detection", () => {
  it.each(LIVE)("flags %s", (q) => expect(needsLiveInfo(q)).toBe(true));
  it.each(GENERAL)("leaves %s alone", (q) => expect(needsLiveInfo(q)).toBe(false));
});
