import { CalendarDays, ChartColumn, FileText, FolderKanban, LayoutTemplate, PenLine, ScanSearch, ShieldCheck, Swords, Telescope, Bug, type LucideIcon } from "lucide-react";
import type { TemplateCategory } from "@/lib/templates/registry";
import { cn } from "@/lib/utils";

/** Each template's logo, shown on a plain neutral badge. Unknown templates fall back to their category. */
const LOGO: Record<string, LucideIcon> = {
  "research-topic": Telescope,
  "compare-competitors": ChartColumn,
  "summarise-document": FileText,
  "write-article": PenLine,
  "debug-code": Bug,
  "review-code": ScanSearch,
  "weekly-plan": CalendarDays,
  "plan-project": FolderKanban,
  "compare-responses": Swords,
  "review-claims": ShieldCheck,
};
const BY_CATEGORY: Record<TemplateCategory, LucideIcon> = {
  research: LOGO["research-topic"]!,
  writing: LOGO["write-article"]!,
  code: LOGO["review-code"]!,
  planning: LOGO["plan-project"]!,
  evaluation: LOGO["compare-responses"]!,
};

export function TemplateLogo({ id, category, size = "md" }: { id: string; category: TemplateCategory; size?: "sm" | "md" }) {
  const Icon = LOGO[id] ?? BY_CATEGORY[category] ?? LayoutTemplate;
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center border border-s-line bg-s-hover text-s-ink-2",
        size === "md" ? "h-11 w-11 rounded-[14px] [&_svg]:h-5 [&_svg]:w-5" : "h-8 w-8 rounded-[10px] [&_svg]:h-4 [&_svg]:w-4",
      )}
    >
      <Icon />
    </span>
  );
}
