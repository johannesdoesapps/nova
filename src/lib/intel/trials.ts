import type { TrialArm } from "./types";

export const TRIAL_SYSTEM_PROMPT = "You are a helpful assistant. Answer accurately and concisely. Do not invent facts, citations or numbers.";

/** Contents of the encrypted trial token: everything needed to reveal and record the trial after the vote. */
export interface SealedTrial {
  id: string;
  userId: string | null;
  createdAt: string;
  category: string;
  prompt: string;
  promptHash: string;
  testItemId: string | null;
  arms: TrialArm[];
  redactions: number;
}
