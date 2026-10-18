import {
  Compass,
  FlaskConical,
  FolderKanban,
  GitBranch,
  House,
  MessageSquare,
  Network,
  Radar,
  Search,
  Settings,
  Swords,
  Users,
  Cpu,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  soon?: boolean;
}

export const NAV: NavItem[] = [
  { href: "/", label: "Home", icon: House },
  { href: "/search", label: "AI Search", icon: Search },
  { href: "/chat", label: "AI Chat", icon: MessageSquare },
  { href: "/battle", label: "Model Battle", icon: Swords },
  { href: "/models", label: "Model Router", icon: Cpu },
  { href: "/discover", label: "Model Discovery", icon: Compass },
  { href: "/projects", label: "Research Projects", icon: FolderKanban },
  { href: "/radar", label: "Radar", icon: Radar, soon: true },
  { href: "/simulator", label: "What-If Simulator", icon: GitBranch, soon: true },
  { href: "/lab", label: "AI Lab", icon: FlaskConical, soon: true },
  { href: "/graph", label: "Knowledge Graph", icon: Network, soon: true },
  { href: "/community", label: "Community", icon: Users, soon: true },
  { href: "/settings", label: "Settings", icon: Settings },
];
