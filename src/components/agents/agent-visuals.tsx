"use client";
import type { CSSProperties, ReactNode } from "react";
import {
  BookOpen,
  Bot,
  Brain,
  Briefcase,
  ChartColumn,
  CodeXml,
  Compass,
  FileText,
  Globe,
  GraduationCap,
  Lightbulb,
  Palette,
  PenLine,
  Rocket,
  Scale,
  Shield,
  Sparkles,
  SquareTerminal,
  Telescope,
} from "lucide-react";
import type { AgentAccent, AgentCapability, AgentConfig, AgentIcon } from "@/lib/agents/types";
import { cn } from "@/lib/utils";

export const AGENT_ICON_COMPONENTS: Record<AgentIcon, typeof Bot> = {
  bot: Bot,
  telescope: Telescope,
  code: CodeXml,
  pen: PenLine,
  chart: ChartColumn,
  lightbulb: Lightbulb,
  sparkles: Sparkles,
  brain: Brain,
  book: BookOpen,
  compass: Compass,
  scale: Scale,
  shield: Shield,
  rocket: Rocket,
  palette: Palette,
  graduation: GraduationCap,
  briefcase: Briefcase,
};

/** Mid-tone accents that read on both the warm light and charcoal dark themes. */
export const ACCENT_COLORS: Record<AgentAccent, string> = {
  violet: "#7b6cf0",
  blue: "#4f86ea",
  teal: "#2a9d92",
  green: "#3f9f62",
  amber: "#c98a1c",
  rose: "#d9587a",
};

export const CAPABILITY_ICONS: Record<AgentCapability, ReactNode> = {
  web_search: <Globe />,
  file_analysis: <FileText />,
  data_analysis: <ChartColumn />,
  code_execution: <SquareTerminal />,
};

const SIZES = {
  xs: "h-[18px] w-[18px] rounded-[6px] [&_svg]:h-3 [&_svg]:w-3",
  sm: "h-8 w-8 rounded-[10px] [&_svg]:h-4 [&_svg]:w-4",
  md: "h-11 w-11 rounded-[14px] [&_svg]:h-[22px] [&_svg]:w-[22px]",
  lg: "h-16 w-16 rounded-[20px] [&_svg]:h-8 [&_svg]:w-8",
};

export function AgentAvatar({
  agent,
  size = "md",
  className,
}: {
  agent: Pick<AgentConfig, "icon" | "accent">;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const Icon = AGENT_ICON_COMPONENTS[agent.icon] ?? Bot;
  const color = ACCENT_COLORS[agent.accent] ?? ACCENT_COLORS.violet;
  return (
    <span
      aria-hidden
      className={cn("relative grid shrink-0 place-items-center border", SIZES[size], className)}
      style={
        {
          color,
          background: `color-mix(in srgb, ${color} 15%, transparent)`,
          borderColor: `color-mix(in srgb, ${color} 26%, transparent)`,
          boxShadow: size === "lg" ? `0 14px 40px -16px ${color}` : undefined,
        } as CSSProperties
      }
    >
      <Icon strokeWidth={1.8} />
    </span>
  );
}
