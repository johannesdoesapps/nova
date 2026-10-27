import { z } from "zod";

/**
 * Jarvis skills: named, reusable instructions for a kind of task ("Research brief", "Tidy a folder"). Jarvis sees
 * only each skill's name and a line about when to use it; when a request matches, it loads the full instructions
 * with the `use_skill` tool and follows them (or they're added up front when the user picks a skill). Skills only
 * shape how Jarvis uses its tools: they can't add tools or change the permission rules.
 *
 * Built-in skills ship with Orbis. People can write their own on the Jarvis page; those are kept in that browser
 * (like Jarvis's other settings) and sent with each request.
 */

export interface Skill {
  id: string;
  name: string;
  /** When to use it, in one line (this is all the model sees until the skill is loaded). */
  description: string;
  instructions: string;
  builtin?: boolean;
  /** Needs the Orbis Desktop Agent (shown as a hint; the tools themselves are checked as usual). */
  desktop?: boolean;
}

export const MAX_USER_SKILLS = 20;

export const skillInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Use letters, numbers and dashes."),
  name: z.string().trim().min(2, "Give the skill a name.").max(40),
  description: z.string().trim().min(5, "Say in a few words when to use it.").max(200),
  instructions: z.string().trim().min(10, "Write the steps Jarvis should follow.").max(2000),
});
export type SkillInput = z.infer<typeof skillInput>;

export const BUILTIN_SKILLS: Skill[] = [
  {
    id: "research-brief",
    name: "Research brief",
    description: "A quick, sourced answer about a topic, product, person or news item.",
    instructions: [
      "1. Call web_search with a focused query. If the excerpts don't answer it, search once more from another angle.",
      "2. If one or two results look most relevant but the excerpts are thin, read them with read_web_page.",
      "3. Answer in at most five short sentences that read well aloud. Name the sites you used (\"according to the BBC…\") and say how recent they are when it matters.",
      "4. If the question needs many sources or a written report, offer to start Deep Research (the research tool) rather than guessing.",
      "Never invent sources, figures or dates. If the search finds nothing reliable, say so.",
    ].join("\n"),
    builtin: true,
  },
  {
    id: "compare-options",
    name: "Compare options",
    description: "Weigh two or more products, services or choices against what matters to the user.",
    instructions: [
      "1. If you don't know what matters most (budget, size, speed, location…), ask one short question first.",
      "2. web_search each option (current prices and specifications change), reading a page with read_web_page when needed.",
      "3. Use calculate for any totals, differences or per-unit prices.",
      "4. Give a recommendation in one sentence, then the key trade-off for each option. Say where the figures came from and that prices are as of today.",
    ].join("\n"),
    builtin: true,
  },
  {
    id: "find-file",
    name: "Find a file",
    description: "Track down a file on this computer from a rough description.",
    instructions: [
      "1. Turn the description into a name fragment and likely extensions (e.g. \"tax return\" → name \"tax\", extensions .pdf).",
      "2. Call find_files in the most likely allowed folder first (Downloads, then Documents, then Desktop); try at most three searches.",
      "3. Report the best matches with their folder, newest first when dates are shown.",
      "4. Open a file with open_path only if the user asked to open it and exactly one match fits; otherwise ask which one.",
    ].join("\n"),
    builtin: true,
    desktop: true,
  },
  {
    id: "tidy-folder",
    name: "Tidy a folder",
    description: "Sort a cluttered folder such as Downloads into subfolders by type.",
    instructions: [
      "1. Call list_directory on the folder first and summarise what's there (how many files, the main kinds).",
      "2. Propose organize_folder for it: the user sees every move before anything happens, and nothing is deleted or overwritten.",
      "3. Afterwards, mention that undo_last_change puts everything back if they change their mind.",
      "Never suggest deleting files; offer moving them to a folder to review instead.",
    ].join("\n"),
    builtin: true,
    desktop: true,
  },
  {
    id: "quick-math",
    name: "Quick maths",
    description: "Sums, percentages, tips, splits, unit conversions and other exact calculations.",
    instructions: [
      "1. Write the calculation as one expression and call calculate (never do the arithmetic yourself).",
      "2. For unit conversions, use the exact factor in the expression (1 mile = 1.609344 km).",
      "3. For currency conversions, web_search the current rate first, then calculate, and say the rate and its date.",
      "4. Say the result plainly, with the expression if it helps.",
    ].join("\n"),
    builtin: true,
  },
  {
    id: "world-clock",
    name: "Time zones",
    description: "What time it is somewhere, or when a meeting time falls in other places.",
    instructions: [
      "1. Call get_time with the IANA time zone of each place (Tokyo → Asia/Tokyo, New York → America/New_York).",
      "2. For a meeting, give the time in each place and point out any that fall outside 8:00–20:00 or on another day.",
      "3. Use calculate for differences in hours if needed.",
    ].join("\n"),
    builtin: true,
  },
  {
    id: "explain-screen",
    name: "Explain my screen",
    description: "Read and explain an error, form or page the user is looking at.",
    instructions: [
      "1. Call look_at_screen with the user's question; they choose which window to share.",
      "2. Explain what it shows in plain words and what to do next, step by step if it's an error.",
      "3. Don't repeat passwords, codes or personal details you see; refer to them generally.",
    ].join("\n"),
    builtin: true,
  },
];

const BUILTIN_IDS = new Set(BUILTIN_SKILLS.map((s) => s.id));

/** A skill id from its name: lowercase words joined by dashes, never clashing with a built-in. */
export function skillId(name: string, taken: Iterable<string> = []): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 34)
      .replace(/-+$/, "") || "skill";
  const used = new Set([...BUILTIN_IDS, ...taken]);
  let id = BUILTIN_IDS.has(base) ? `my-${base}` : base;
  for (let n = 2; used.has(id); n++) id = `${BUILTIN_IDS.has(base) ? `my-${base}` : base}-${n}`;
  return id;
}

/** Built-in skills, then the user's own (valid ones only, never replacing a built-in), at most MAX_USER_SKILLS. */
export function allSkills(user: readonly unknown[] = []): Skill[] {
  const mine: Skill[] = [];
  const seen = new Set(BUILTIN_IDS);
  for (const raw of user) {
    const p = skillInput.safeParse(raw);
    if (!p.success || seen.has(p.data.id) || mine.length >= MAX_USER_SKILLS) continue;
    seen.add(p.data.id);
    mine.push(p.data);
  }
  return [...BUILTIN_SKILLS, ...mine];
}

/** A skill by id, or by name ignoring case and punctuation (models sometimes use the name). */
export function findSkill(nameOrId: string, skills: readonly Skill[]): Skill | null {
  const key = nameOrId.trim().toLowerCase();
  const loose = key.replace(/[^a-z0-9]+/g, "");
  return skills.find((s) => s.id === key) ?? skills.find((s) => s.name.toLowerCase().replace(/[^a-z0-9]+/g, "") === loose) ?? null;
}

/** What the model sees about skills before loading one: one line each. */
export function skillCatalog(skills: readonly Skill[], desktopConnected: boolean): string {
  return skills
    .filter((s) => !s.desktop || desktopConnected)
    .map((s) => `- ${s.id}: ${s.name}. ${s.description}`)
    .join("\n");
}

/** A loaded skill, as the model reads it. */
export function skillText(skill: Skill): string {
  return `Skill "${skill.name}" (${skill.builtin ? "built in" : "written by the user"}). Follow these steps for this task:\n${skill.instructions}`;
}
