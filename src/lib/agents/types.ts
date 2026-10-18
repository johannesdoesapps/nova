/** Agent model shared by the server and the browser (no server-only imports). */
import type { Capability } from "../ai/types";

export const AGENT_CAPABILITIES = ["web_search", "file_analysis", "data_analysis", "code_execution"] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export const CAPABILITY_INFO: Record<AgentCapability, { label: string; description: string }> = {
  web_search: { label: "Web search", description: "Search the web before answering and cite the sources found." },
  file_analysis: { label: "File analysis", description: "Read attached text files (.txt, .md, .csv, .json…) as context." },
  data_analysis: { label: "Data analysis", description: "Compute column statistics for attached CSV/TSV files on the server." },
  code_execution: { label: "Code execution", description: "Run code in an isolated sandbox." },
};

export const AGENT_ICONS = [
  "bot",
  "telescope",
  "code",
  "pen",
  "chart",
  "lightbulb",
  "sparkles",
  "brain",
  "book",
  "compass",
  "scale",
  "shield",
  "rocket",
  "palette",
  "graduation",
  "briefcase",
] as const;
export type AgentIcon = (typeof AGENT_ICONS)[number];

export const AGENT_ACCENTS = ["violet", "blue", "teal", "green", "amber", "rose"] as const;
export type AgentAccent = (typeof AGENT_ACCENTS)[number];

export const RESPONSE_STYLES = ["concise", "balanced", "detailed"] as const;
export type ResponseStyle = (typeof RESPONSE_STYLES)[number];

export const RESPONSE_STYLE_INFO: Record<ResponseStyle, { label: string; instruction: string }> = {
  concise: { label: "Concise", instruction: "Keep answers short and direct: lead with the answer, avoid preamble, use bullets only when they help." },
  balanced: { label: "Balanced", instruction: "Match length to the question: short for simple questions, structured with headings for complex ones." },
  detailed: { label: "Detailed", instruction: "Be thorough: explain reasoning, cover edge cases and alternatives, and use headings and examples." },
};

/** How many earlier messages an agent remembers in a conversation. */
export const HISTORY_LIMITS = [10, 20, 40] as const;

export const BUILTIN_AGENT_IDS = ["research", "coding", "writing", "data", "creative", "general"] as const;
export type BuiltinAgentId = (typeof BUILTIN_AGENT_IDS)[number];

export interface AgentConfig {
  /** Built-in key ("research") or a custom agent's UUID. */
  id: string;
  kind: "builtin" | "custom";
  name: string;
  description: string;
  category: string;
  instructions: string;
  icon: AgentIcon;
  accent: AgentAccent;
  /** Preferred model; null means "best available" (or "auto" to route each message). */
  modelId: string | null;
  /** Built-ins: the kind of model to use when no model is chosen. Kept separate from model ids so either can change. */
  modelPreference: Capability | null;
  responseStyle: ResponseStyle;
  historyLimit: number;
  capabilities: AgentCapability[];
  starters: string[];
  /** Sampling temperature where the provider supports it. */
  temperature: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Whether each capability is actually implemented and configured in this deployment. */
export type CapabilityStatus = Record<AgentCapability, { available: boolean; reason?: string }>;

export function isBuiltinId(id: string): id is BuiltinAgentId {
  return (BUILTIN_AGENT_IDS as readonly string[]).includes(id);
}
