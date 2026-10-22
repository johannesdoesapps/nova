import type { ChatMode } from "../ai/modes";
import type { RouterMode } from "../ai/platform";

/**
 * The template library: common workflows a user can start without writing
 * prompts. A template either runs its own short series of model steps (each
 * step sees the inputs and the earlier steps' results), or hands the inputs
 * to an existing tool that already does the job (Missions, Arena, Verify).
 *
 * To add a workflow, add an entry here; the page, runner and estimates read
 * everything from this list.
 */

export type InputKind = "text" | "longtext" | "select";

export interface TemplateInput {
  id: string;
  label: string;
  kind: InputKind;
  required: boolean;
  placeholder?: string;
  /** Shown under the field. */
  help?: string;
  options?: string[];
  /** Character limit. */
  max: number;
}

export interface TemplateStep {
  id: string;
  title: string;
  /** What the step produces, shown while it runs. */
  doing: string;
  /** The chat mode whose instructions the model follows. */
  mode: ChatMode;
  /** Search the web first and give the step the results (when search is set up). */
  web?: boolean;
  /** The search query, with the same placeholders as the prompt. */
  searchQuery?: string;
  /**
   * The step's instructions. {{input}} inserts an input, {{steps.id}} an
   * earlier step's result, and {{?input}}…{{/input}} keeps a passage only
   * when that input was filled in.
   */
  prompt: string;
  maxOutputTokens: number;
}

export type Handoff = "missions" | "arena" | "verify";

export type TemplateCategory = "research" | "writing" | "code" | "planning" | "evaluation";

export interface Template {
  id: string;
  name: string;
  description: string;
  /** What the user ends up with. */
  outcome: string;
  category: TemplateCategory;
  inputs: TemplateInput[];
  /** The model setup suggested (Auto's routing), and why. */
  suggested: { router: RouterMode; why: string };
  steps?: TemplateStep[];
  /** Instead of steps: open an existing tool with the inputs filled in. */
  handoff?: { to: Handoff; label: string; why: string };
}

export const CATEGORY_LABELS: Record<TemplateCategory, string> = { research: "Research", writing: "Writing", code: "Code", planning: "Planning", evaluation: "Checking and comparing" };

const LONG = 40_000;

export const TEMPLATES: Template[] = [
  {
    id: "research-topic",
    name: "Research a topic",
    description: "A clear briefing on a subject, with sources when web search is available.",
    outcome: "A sourced briefing, then a short list of what to double-check before relying on it.",
    category: "research",
    inputs: [
      { id: "topic", label: "Topic or question", kind: "text", required: true, placeholder: "e.g. How do heat pumps perform in cold climates?", max: 400 },
      {
        id: "purpose",
        label: "What it's for",
        kind: "longtext",
        required: false,
        placeholder: "e.g. Deciding whether to replace our gas boiler next year",
        help: "Helps the briefing focus on what matters to you.",
        max: 2000,
      },
      { id: "depth", label: "Depth", kind: "select", required: true, options: ["Quick overview", "Thorough briefing"], max: 40 },
    ],
    suggested: { router: "research", why: "Auto · Research prefers models that are careful with facts, and web sources are used when search is set up." },
    steps: [
      {
        id: "brief",
        title: "Briefing",
        doing: "Researching and writing the briefing",
        mode: "research",
        web: true,
        searchQuery: "{{topic}}",
        maxOutputTokens: 3000,
        prompt: `Write a {{depth}} on: {{topic}}
{{?purpose}}It is for: {{purpose}}. Focus on what matters for that.
{{/purpose}}
Structure it as:
1. Summary: 3–5 bullet points with the main takeaways.
2. Key facts: the important facts and figures. When web sources are given, cite them as [n]; otherwise say plainly that these come from general knowledge and may be out of date.
3. Where views differ: real debates or trade-offs, presented fairly.
4. What's uncertain or changing.
5. Where to read more: the kinds of sources worth checking (name only real, well-known ones).
Be concrete and plain. Don't pad.`,
      },
      {
        id: "check",
        title: "What to double-check",
        doing: "Reviewing the briefing for gaps",
        mode: "critic",
        maxOutputTokens: 1200,
        prompt: `Here is a briefing on "{{topic}}":

{{steps.brief}}

Review it critically. List, briefly:
- The 3–6 claims most worth checking before relying on them, and why (e.g. figures that change, contested points, uncited statements).
- Important questions it doesn't answer.
- How to check each point (what kind of source to consult).
Don't rewrite the briefing.`,
      },
    ],
  },
  {
    id: "compare-competitors",
    name: "Compare competitors",
    description: "Profiles of your competitors and a side-by-side comparison with your product.",
    outcome: "Competitor profiles, a comparison table, and where you can win.",
    category: "research",
    inputs: [
      { id: "product", label: "Your product or company", kind: "text", required: true, placeholder: "e.g. Orbis, an AI workspace for small teams", max: 300 },
      { id: "competitors", label: "Competitors", kind: "text", required: true, placeholder: "e.g. Notion AI, ChatGPT Team, Microsoft Copilot", help: "Separate them with commas.", max: 400 },
      { id: "market", label: "Market or customer", kind: "text", required: false, placeholder: "e.g. agencies of 5–50 people in Europe", max: 300 },
      { id: "criteria", label: "What to compare", kind: "longtext", required: false, placeholder: "e.g. pricing, integrations, data privacy", max: 1000 },
    ],
    suggested: { router: "research", why: "Profiles need current facts, so web sources are used when search is set up; the comparison uses an analytical model." },
    steps: [
      {
        id: "profiles",
        title: "Competitor profiles",
        doing: "Profiling each competitor",
        mode: "research",
        web: true,
        searchQuery: "{{competitors}} pricing features comparison{{?market}} {{market}}{{/market}}",
        maxOutputTokens: 3000,
        prompt: `Profile each of these competitors of {{product}}: {{competitors}}.
{{?market}}The market is: {{market}}.
{{/market}}For each: positioning in one line, target customers, main features, pricing model, notable strengths, notable weaknesses.
Cite web sources as [n] when given. If you don't know something (especially prices), write "unknown" rather than guessing, and note that details change often.`,
      },
      {
        id: "compare",
        title: "Comparison and opportunities",
        doing: "Comparing them with your product",
        mode: "analyst",
        maxOutputTokens: 2500,
        prompt: `Using these profiles:

{{steps.profiles}}

Compare {{product}} with {{competitors}}{{?market}} for {{market}}{{/market}}.
1. A comparison table across {{?criteria}}these criteria: {{criteria}}{{/criteria}}{{!criteria}}the criteria that matter most to buyers (5–7){{/criteria}}. Use "unknown" where the profiles don't say.
2. Where {{product}} is likely stronger, and where weaker.
3. Gaps in the market none of them fill well.
4. Three concrete moves for {{product}}, each with the reason and a first step.
Keep claims tied to the profiles; flag anything that needs checking.`,
      },
    ],
  },
  {
    id: "summarise-document",
    name: "Summarise a document",
    description: "The key points of a long text, written for whoever needs to read it.",
    outcome: "Key points with exact figures, then a summary at the length and level you choose.",
    category: "writing",
    inputs: [
      {
        id: "document",
        label: "Document",
        kind: "longtext",
        required: true,
        placeholder: "Paste the text here",
        help: "Up to about 40,000 characters. Its contents are sent to the AI model.",
        max: LONG,
      },
      { id: "audience", label: "Who it's for", kind: "select", required: true, options: ["Me", "My team", "Executives", "Non-specialists"], max: 40 },
      { id: "length", label: "Length", kind: "select", required: true, options: ["5 bullet points", "One page"], max: 40 },
      { id: "focus", label: "Anything to focus on", kind: "text", required: false, placeholder: "e.g. costs and deadlines", max: 300 },
    ],
    suggested: { router: "quick", why: "Summarising doesn't need the largest models; Auto picks a capable, lower-cost one." },
    steps: [
      {
        id: "points",
        title: "Key points",
        doing: "Pulling out the key points",
        mode: "analyst",
        maxOutputTokens: 2000,
        prompt: `Read this document and list its key points{{?focus}}, paying special attention to {{focus}}{{/focus}}.

<document>
{{document}}
</document>

List: main points; figures, dates and names (copied exactly); decisions or requests; open questions or risks it raises. Use only what the document says.`,
      },
      {
        id: "summary",
        title: "Summary",
        doing: "Writing the summary",
        mode: "analyst",
        maxOutputTokens: 1500,
        prompt: `Write a summary as {{length}} for {{audience}}, using only these key points from the document:

{{steps.points}}

Lead with what matters most to the reader. Keep figures exactly as given. End with one line: "Check in the original:" and anything ambiguous or important enough to confirm.`,
      },
    ],
  },
  {
    id: "write-article",
    name: "Write or improve an article",
    description: "From a topic or your draft to a polished article, via an outline and a critical edit.",
    outcome: "An outline, a draft, and a final edited version.",
    category: "writing",
    inputs: [
      { id: "topic", label: "Topic, or your draft to improve", kind: "longtext", required: true, placeholder: "A topic and the main point you want to make, or paste a draft", max: LONG },
      { id: "audience", label: "Readers", kind: "text", required: false, placeholder: "e.g. small business owners new to AI", max: 300 },
      { id: "tone", label: "Tone", kind: "select", required: true, options: ["Clear and friendly", "Professional", "Persuasive", "Conversational"], max: 40 },
      { id: "length", label: "Length", kind: "select", required: true, options: ["About 500 words", "About 1,000 words", "About 1,500 words"], max: 40 },
    ],
    suggested: { router: "deep", why: "Writing and editing benefit from stronger models; Auto · Deep chooses one within your plan." },
    steps: [
      {
        id: "outline",
        title: "Outline",
        doing: "Planning the structure",
        mode: "analyst",
        maxOutputTokens: 1200,
        prompt: `Plan an article.
Input (a topic, or a draft to improve):
<input>
{{topic}}
</input>
{{?audience}}Readers: {{audience}}.
{{/audience}}Tone: {{tone}}. Length: {{length}}.

If the input is a draft, first list its 3–5 biggest weaknesses in one line each. Then give: a working title, the one-sentence main point, and an outline (sections with 1–2 lines each) that serves the readers.`,
      },
      {
        id: "draft",
        title: "Draft",
        doing: "Writing the draft",
        mode: "analyst",
        maxOutputTokens: 3500,
        prompt: `Write the article from this plan:

{{steps.outline}}

Original input, for content and facts (keep the author's own facts and examples; don't invent statistics or quotes):
<input>
{{topic}}
</input>

Tone: {{tone}}. Length: {{length}}. Use short paragraphs and descriptive subheadings. Output only the article.`,
      },
      {
        id: "edit",
        title: "Edited version",
        doing: "Editing critically",
        mode: "critic",
        maxOutputTokens: 3500,
        prompt: `Edit this article as a demanding editor{{?audience}} for {{audience}}{{/audience}}:

{{steps.draft}}

First, 3–5 bullet points on what you changed and why. Then the full improved article: tighter, clearer, no filler, every claim either supported by the input or phrased with appropriate care. Keep the {{tone}} tone and about the same length.`,
      },
    ],
  },
  {
    id: "debug-code",
    name: "Debug a coding issue",
    description: "Likely causes ranked by evidence, then a fix and how to test it.",
    outcome: "A diagnosis, the fix, and steps to confirm it works.",
    category: "code",
    inputs: [
      { id: "problem", label: "What's going wrong", kind: "longtext", required: true, placeholder: "The error message and what happens", max: 8000 },
      {
        id: "code",
        label: "The relevant code",
        kind: "longtext",
        required: true,
        placeholder: "Paste the code involved",
        help: "For a whole project, use Orbis Code instead: it can read and run the project.",
        max: LONG,
      },
      { id: "expected", label: "What should happen", kind: "text", required: false, max: 1000 },
      { id: "environment", label: "Language, framework and versions", kind: "text", required: false, placeholder: "e.g. TypeScript 5, Next.js 16, Node 22", max: 300 },
    ],
    suggested: { router: "coding", why: "Auto · Coding prefers models that are strongest at reading and fixing code." },
    steps: [
      {
        id: "diagnose",
        title: "Diagnosis",
        doing: "Finding the likely causes",
        mode: "coding",
        maxOutputTokens: 2000,
        prompt: `Diagnose this bug.
Problem: {{problem}}
{{?expected}}Expected: {{expected}}
{{/expected}}{{?environment}}Environment: {{environment}}
{{/environment}}
<code>
{{code}}
</code>

List the likely causes, most likely first. For each: the evidence in the code (quote the lines), and a quick way to confirm or rule it out. Don't write the fix yet.`,
      },
      {
        id: "fix",
        title: "Fix",
        doing: "Writing the fix",
        mode: "coding",
        maxOutputTokens: 3000,
        prompt: `Diagnosis so far:

{{steps.diagnose}}

Original code:
<code>
{{code}}
</code>

Fix the most likely cause. Give: the corrected code (only the parts that change, clearly marked), a short explanation, how to test that it's fixed, and what to try next if it isn't.`,
      },
    ],
  },
  {
    id: "review-code",
    name: "Review code",
    description: "Findings ranked by severity, then corrected code for the important ones.",
    outcome: "A prioritised review and the code changes to address it.",
    category: "code",
    inputs: [
      { id: "code", label: "Code or diff", kind: "longtext", required: true, placeholder: "Paste the code or a diff", max: LONG },
      { id: "focus", label: "Focus", kind: "select", required: true, options: ["Everything", "Bugs and correctness", "Security", "Readability", "Performance"], max: 40 },
      { id: "context", label: "What the code does", kind: "text", required: false, max: 1000 },
    ],
    suggested: { router: "coding", why: "Auto · Coding prefers models that are strongest at reading code." },
    steps: [
      {
        id: "review",
        title: "Review",
        doing: "Reviewing the code",
        mode: "coding",
        maxOutputTokens: 3000,
        prompt: `Review this code. Focus: {{focus}}.{{?context}} It: {{context}}.{{/context}}

<code>
{{code}}
</code>

List findings, most severe first, each with: severity (High / Medium / Low), where (quote the line), what's wrong, why it matters, and the fix. Only real issues; at most 3 Low ones. If it's in good shape, say so.`,
      },
      {
        id: "patch",
        title: "Corrected code",
        doing: "Writing the corrections",
        mode: "coding",
        maxOutputTokens: 3000,
        prompt: `Review findings:

{{steps.review}}

Original code:
<code>
{{code}}
</code>

Write corrected code for the High and Medium findings (only the parts that change, each marked with the finding it addresses). If there were none, say so and stop.`,
      },
    ],
  },
  {
    id: "weekly-plan",
    name: "Create a weekly work plan",
    description: "A realistic day-by-day plan around your fixed commitments.",
    outcome: "This week's top outcomes, a day-by-day schedule, and what to drop if it's too much.",
    category: "planning",
    inputs: [
      { id: "priorities", label: "What needs doing", kind: "longtext", required: true, placeholder: "Tasks, deadlines and anything carrying over", max: 6000 },
      { id: "fixed", label: "Fixed commitments", kind: "longtext", required: false, placeholder: "e.g. Mon 10–11 team call, Thu afternoon off", max: 3000 },
      { id: "hours", label: "Hours available for focused work", kind: "text", required: false, placeholder: "e.g. about 25 hours", max: 100 },
    ],
    suggested: { router: "quick", why: "Planning a week doesn't need the largest models; Auto picks a capable, lower-cost one." },
    steps: [
      {
        id: "plan",
        title: "Weekly plan",
        doing: "Planning your week",
        mode: "analyst",
        maxOutputTokens: 2500,
        prompt: `Make a realistic work plan for the coming week (Monday to Friday).
What needs doing:
{{priorities}}
{{?fixed}}Fixed commitments: {{fixed}}
{{/fixed}}{{?hours}}Hours available for focused work: {{hours}}
{{/hours}}
Give:
1. The 3 most important outcomes for the week.
2. A day-by-day plan with time blocks, working around the fixed commitments, hardest work earlier in the day, and buffer time.
3. If it doesn't fit: what to drop, delay or delegate, and why.
Don't invent tasks that weren't mentioned.`,
      },
    ],
  },
  {
    id: "plan-project",
    name: "Plan a project",
    description: "Turn a goal into milestones and tasks you can track, with AI help on each task.",
    outcome: "A mission with milestones and tasks, saved to your projects.",
    category: "planning",
    inputs: [
      { id: "goal", label: "Goal", kind: "longtext", required: true, placeholder: "e.g. Launch our new website by March", max: 3000 },
      { id: "deadline", label: "Deadline", kind: "text", required: false, max: 100 },
      { id: "constraints", label: "Constraints", kind: "text", required: false, placeholder: "e.g. two people, small budget", max: 600 },
    ],
    suggested: { router: "deep", why: "Missions plans with a stronger model; you review the plan before anything is saved." },
    handoff: {
      to: "missions",
      label: "Plan it in Missions",
      why: "Missions already turns a goal into milestones and tasks you can edit, track and run AI on, so this template opens it with your goal filled in.",
    },
  },
  {
    id: "compare-responses",
    name: "Compare multiple AI responses",
    description: "Ask several models the same question and see where they agree.",
    outcome: "Answers side by side, with an analysis, a combined answer and cost per model.",
    category: "evaluation",
    inputs: [{ id: "prompt", label: "Question or task", kind: "longtext", required: true, placeholder: "What should every model answer?", max: 4000 }],
    suggested: { router: "deep", why: "You choose the models in Arena; it shows the cost before running." },
    handoff: { to: "arena", label: "Compare in Arena", why: "Arena already runs several models side by side and combines their answers, so this template opens it with your question filled in." },
  },
  {
    id: "review-claims",
    name: "Review claims and evidence",
    description: "Check the important claims in an answer or document against sources.",
    outcome: "Each claim labelled by what the sources reviewed say, with the evidence to inspect.",
    category: "evaluation",
    inputs: [
      { id: "text", label: "Answer or document", kind: "longtext", required: true, placeholder: "Paste what you want checked", max: LONG },
      { id: "question", label: "The question it answers", kind: "text", required: false, max: 1000 },
    ],
    suggested: { router: "research", why: "Verify compares claims with sources and only counts evidence it can quote." },
    handoff: { to: "verify", label: "Check in Verify", why: "Verify is the checking workflow, so this template opens it with your text filled in." },
  },
];

export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/**
 * Fill in a step's instructions: {{name}} → value, {{steps.id}} → an earlier
 * result, {{?name}}…{{/name}} kept only when filled in, {{!name}}…{{/name}}
 * kept only when empty.
 */
export function renderPrompt(template: string, inputs: Record<string, string>, steps: Record<string, string> = {}): string {
  const value = (key: string) => (key.startsWith("steps.") ? (steps[key.slice(6)] ?? "") : (inputs[key] ?? "")).trim();
  let out = template.replace(/\{\{([?!])([\w.]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_, sign: string, key: string, body: string) => ((sign === "?") === !!value(key) ? body : ""));
  out = out.replace(/\{\{([\w.]+)\}\}/g, (_, key: string) => value(key));
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Problems with the inputs, by field (empty when they're fine). */
export function checkInputs(t: Template, inputs: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of t.inputs) {
    const v = (inputs[f.id] ?? "").trim();
    if (f.required && !v) errors[f.id] = `${f.label} is needed.`;
    else if (v.length > f.max) errors[f.id] = `${f.label} is too long (up to ${f.max.toLocaleString("en")} characters).`;
    else if (f.kind === "select" && v && f.options && !f.options.includes(v)) errors[f.id] = `Choose one of the options for ${f.label.toLowerCase()}.`;
  }
  return errors;
}

/** Defaults: the first option of each select. */
export function defaultInputs(t: Template): Record<string, string> {
  return Object.fromEntries(t.inputs.filter((f) => f.kind === "select" && f.options?.length).map((f) => [f.id, f.options![0]!]));
}

/** Where a hand-off template opens, with the inputs filled in. Verify takes its text from the page's storage instead of the URL. */
export function handoffHref(t: Template, inputs: Record<string, string>): string | null {
  const v = (k: string) => (inputs[k] ?? "").trim();
  switch (t.handoff?.to) {
    case "missions": {
      const goal = [v("goal"), v("deadline") && `Deadline: ${v("deadline")}.`, v("constraints") && `Constraints: ${v("constraints")}.`].filter(Boolean).join("\n");
      return `/missions?goal=${encodeURIComponent(goal.slice(0, 4000))}`;
    }
    case "arena":
      return `/arena?q=${encodeURIComponent(v("prompt").slice(0, 4000))}`;
    case "verify":
      return "/verify";
    default:
      return null;
  }
}

/** Characters each step will send, roughly: its instructions with inputs, plus earlier results (estimated at their output cap). */
export function stepInputChars(t: Template, step: TemplateStep, inputs: Record<string, string>, override?: string): number {
  const prior = (t.steps ?? []).slice(0, (t.steps ?? []).indexOf(step));
  const placeholders = Object.fromEntries(prior.map((p) => [p.id, "x".repeat(p.maxOutputTokens * 4)]));
  return renderPrompt(override ?? step.prompt, inputs, placeholders).length;
}
