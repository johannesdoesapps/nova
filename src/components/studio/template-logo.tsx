import { CalendarDays, ChartColumn, FileText, FolderKanban, LayoutTemplate, PenLine, ScanSearch, ShieldCheck, Swords, Telescope, Bug, type LucideIcon } from "lucide-react";
import type { TemplateCategory } from "@/lib/templates/registry";
import { cn } from "@/lib/utils";

/** Each template's logo and tint, in the same badge style as the agents. Unknown templates fall back to their category. */
const LOGO: Record<string, { icon: LucideIcon; tint: string }> = {
  "research-topic": { icon: Telescope, tint: "from-sky-500/25 to-cyan-400/5 text-sky-600 dark:text-sky-300" },
  "compare-competitors": { icon: ChartColumn, tint: "from-indigo-500/25 to-blue-400/5 text-indigo-600 dark:text-indigo-300" },
  "summarise-document": { icon: FileText, tint: "from-teal-500/25 to-cyan-400/5 text-teal-600 dark:text-teal-300" },
  "write-article": { icon: PenLine, tint: "from-violet-500/25 to-fuchsia-400/5 text-violet-600 dark:text-violet-300" },
  "debug-code": { icon: Bug, tint: "from-rose-500/25 to-red-400/5 text-rose-600 dark:text-rose-300" },
  "review-code": { icon: ScanSearch, tint: "from-amber-500/25 to-orange-400/5 text-amber-600 dark:text-amber-300" },
  "weekly-plan": { icon: CalendarDays, tint: "from-emerald-500/25 to-green-400/5 text-emerald-600 dark:text-emerald-300" },
  "plan-project": { icon: FolderKanban, tint: "from-orange-500/25 to-amber-400/5 text-orange-600 dark:text-orange-300" },
  "compare-responses": { icon: Swords, tint: "from-fuchsia-500/25 to-pink-400/5 text-fuchsia-600 dark:text-fuchsia-300" },
  "review-claims": { icon: ShieldCheck, tint: "from-green-500/25 to-emerald-400/5 text-green-600 dark:text-green-300" },
};
const BY_CATEGORY: Record<TemplateCategory, { icon: LucideIcon; tint: string }> = {
  research: LOGO["research-topic"]!,
  writing: LOGO["write-article"]!,
  code: LOGO["review-code"]!,
  planning: LOGO["plan-project"]!,
  evaluation: LOGO["compare-responses"]!,
};

export function TemplateLogo({ id, category, size = "md" }: { id: string; category: TemplateCategory; size?: "sm" | "md" }) {
  const { icon: Icon, tint } = LOGO[id] ?? BY_CATEGORY[category] ?? { icon: LayoutTemplate, tint: "from-s-accent/20 to-transparent text-s-ink" };
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center border border-s-line bg-gradient-to-br",
        tint,
        size === "md" ? "h-11 w-11 rounded-[14px] [&_svg]:h-5 [&_svg]:w-5" : "h-8 w-8 rounded-[10px] [&_svg]:h-4 [&_svg]:w-4",
      )}
    >
      <Icon />
    </span>
  );
}
