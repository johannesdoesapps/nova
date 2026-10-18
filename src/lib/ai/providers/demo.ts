import type { AIProvider, GenerateParams, GenerateResult, StreamEvent } from "../types";
import { estimateTokens } from "../cost";

export const DEMO_NOTICE =
  "**Demo mode — simulated response.** No AI provider is configured, so this text was generated locally from a template and is not a real model output.";

function demoText(params: GenerateParams): string {
  const last = [...params.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const question =
    last.match(/Question:\s*(.+)/)?.[1]?.slice(0, 200) ??
    last.replace(/<document[\s\S]*?<\/document>/g, "").split("\n").find((l) => l.trim())?.trim().slice(0, 200) ??
    "your request";
  const quoted = question.replace(/[.!?…]+$/, "");
  const hasSources = params.messages.some((m) => m.content.includes("<source "));
  const system = params.messages.find((m) => m.role === "system")?.content ?? "";
  const agent = system.match(/^Agent name: (.+)\.$/m)?.[1];
  const mode = (system.match(/Mode: (\w+)\./)?.[1] ?? "Research") as keyof typeof MODE_STEPS;
  const steps = MODE_STEPS[mode] ?? MODE_STEPS.Research;
  const intro = agent
    ? agentSection(agent, system)
    : [`### What a connected model would do (${mode} mode)`, ...steps.map((s, i) => `${i + 1}. ${s}`)];
  return [
    DEMO_NOTICE,
    "",
    agent ? `You asked **${agent}**: “${quoted}”.` : `You asked: “${quoted}”.`,
    "",
    ...intro,
    "",
    "> Demo replies come from a fixed template on the server. They show how NOVA lays out an answer and contain no analysis of your question.",
    "",
    "### Connect a provider",
    hasSources
      ? "Real web sources were retrieved for this question and are listed alongside this message, but no model was available to read and summarise them. Add a key to get a grounded answer:"
      : "Add a key to `.env.local` (keys stay on the server and are never sent to the browser), then restart the dev server:",
    "",
    "```bash",
    "# .env.local",
    "OPENAI_API_KEY=your-key-here",
    "# or, for open models",
    "HUGGINGFACE_API_KEY=your-key-here",
    "```",
  ].join("\n");
}

/** Shows what the selected agent is configured to do, read back from its system prompt. */
function agentSection(agent: string, system: string): string[] {
  const tools = system.match(/^Enabled tools: (.+)\.$/m)?.[1] ?? "none";
  const role = system.match(/<agent_instructions>\n([^\n]+)/)?.[1]?.trim();
  const computed = system.includes('<tool_result tool="data_analysis"');
  return [
    `### How ${agent} would handle this`,
    ...(role ? [`- **Role:** ${role}`] : []),
    `- **Tools enabled:** ${tools}.`,
    ...(computed ? ["- **Data analysis ran for real:** the server computed the column statistics shown above this reply. A connected model would interpret them."] : []),
    "- A connected model would follow the agent's full instructions and reply here.",
  ];
}

const MODE_STEPS = {
  Research: [
    "Summarise what is established about the question.",
    "Separate facts from interpretation and flag anything that may be out of date.",
    "Cite live web sources as [n] when **Web** is switched on.",
  ],
  Analyst: [
    "Break the question into explicit criteria.",
    "Compare the options against each criterion, with trade-offs.",
    "Finish with a clear, hedged takeaway.",
  ],
  Critic: [
    "Briefly steelman your position.",
    "Surface hidden assumptions, weak evidence and risks.",
    "Say what evidence would change the conclusion.",
  ],
  Coding: [
    "Write working code in fenced blocks with a language tag.",
    "Explain the key decisions and edge cases.",
    "Describe how to test the change.",
  ],
};

export const demoProvider: AIProvider = {
  id: "demo",
  isConfigured: () => true,
  missingConfig: () => null,
  async generate(params): Promise<GenerateResult> {
    const text = demoText(params);
    return {
      text,
      usage: { inputTokens: estimateTokens(params.messages), outputTokens: estimateTokens(text), estimated: true },
      simulated: true,
    };
  },
  async *stream(params): AsyncGenerator<StreamEvent> {
    const text = demoText(params);
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 10) chunks.push(text.slice(i, i + 10));
    // A short pause, then a steady stream, so the UI's thinking and streaming states are visible.
    await new Promise((r) => setTimeout(r, 450));
    for (const chunk of chunks) {
      if (params.signal?.aborted) return;
      yield { type: "delta", text: chunk };
      await new Promise((r) => setTimeout(r, 14));
    }
    yield {
      type: "usage",
      usage: { inputTokens: estimateTokens(params.messages), outputTokens: estimateTokens(text), estimated: true },
    };
  },
};
