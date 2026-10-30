import {
  Bot,
  Braces,
  Brain,
  Briefcase,
  BookText,
  Compass,
  FileText,
  LayoutDashboard,
  PenLine,
  Rocket,
  ScanSearch,
  Scale,
  Shield,
  Sparkles,
  Telescope,
  Palette,
  Code2,
  type LucideIcon,
} from "lucide-react";

/** String → icon, so the catalog data stays free of React imports. */
const MAP: Record<string, LucideIcon> = {
  shield: Shield,
  layout: LayoutDashboard,
  scan: ScanSearch,
  scale: Scale,
  telescope: Telescope,
  compass: Compass,
  brain: Brain,
  book: BookText,
  briefcase: Briefcase,
  pen: PenLine,
  sparkles: Sparkles,
  rocket: Rocket,
  palette: Palette,
  code: Code2,
  bot: Bot,
  braces: Braces,
  file: FileText,
};

export function WorkspaceIcon({ name, className }: { name: string; className?: string }) {
  const Icon = MAP[name] ?? FileText;
  return <Icon className={className} aria-hidden />;
}
