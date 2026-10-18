/**
 * Model Intelligence data model: blind trials (personal preference),
 * reproducible benchmarks (general measurement), and usage events.
 * Personal and general evidence are stored and reported separately.
 */

export const TASK_CATEGORIES = ["coding", "research", "writing", "analysis", "extraction", "general"] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export type TrialWinner = "A" | "B" | "tie" | "both_bad";

export interface TrialArm {
  label: "A" | "B";
  modelId: string;
  displayName: string;
  provider: string;
  /** Model version the provider says actually served the request (e.g. a dated snapshot). */
  servedModel: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensEstimated: boolean;
  cost: number | null;
  simulated: boolean;
  error: string | null;
}

export interface TrialRecord {
  id: string;
  createdAt: string;
  category: TaskCategory;
  prompt: string;
  promptHash: string;
  testItemId: string | null;
  arms: TrialArm[];
  winner: TrialWinner;
  /** Optional 1–5 quality ratings per arm label. */
  ratings: Partial<Record<"A" | "B", number>>;
  note: string | null;
  /** How many model self-identifications were hidden before display. */
  redactions: number;
}

export type CheckerSpec =
  | { type: "exact"; answer: string }
  | { type: "contains_all"; values: string[] }
  | { type: "contains_any"; values: string[] }
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "numeric"; answer: number; tolerance: number }
  | { type: "json_keys"; keys: string[] }
  | { type: "bullets"; count: number; maxWords?: number }
  | { type: "lowercase" }
  | { type: "not_stated"; forbidden?: string[] };

export interface TestItem {
  id: string;
  prompt: string;
  checker: CheckerSpec;
  /** Why this item exists / what it probes. Shown in the UI. */
  probes: string;
}

export interface TestSet {
  id: string;
  name: string;
  category: TaskCategory;
  version: string;
  description: string;
  systemPrompt: string;
  items: TestItem[];
  builtIn: boolean;
}

export interface BenchmarkItemResult {
  itemId: string;
  passed: boolean;
  score: number; // 0–1
  detail: string;
  output: string;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  error: string | null;
}

export interface BenchmarkRun {
  id: string;
  createdAt: string;
  testSetId: string;
  testSetName: string;
  category: TaskCategory;
  /** Content hash of the exact items and system prompt used. */
  testSetHash: string;
  modelId: string;
  displayName: string;
  servedModel: string | null;
  params: { maxOutputTokens: number; temperature: number | null };
  simulated: boolean;
  results: BenchmarkItemResult[];
}

export interface UsageRow {
  modelId: string;
  purpose: string;
  category: string | null;
  servedModel: string | null;
  fallbackFrom: string | null;
  status: "success" | "error";
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  createdAt: string;
}

export interface PrivacyProfile {
  /** Does the provider use API inputs for training by default? null = not verified. */
  trainsOnApiData: boolean | null;
  /** Default retention of API inputs/outputs in days; null = not verified. */
  retentionDays: number | null;
  zeroRetentionAvailable: boolean | null;
  processingRegions: string[] | null;
  sourceUrl: string | null;
  verifiedAt: string | null;
  notes: string;
}
