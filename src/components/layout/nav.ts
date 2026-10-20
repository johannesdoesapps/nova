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
  Dna,
  Fingerprint,
  Layers,
  Plug,
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
  { href: "/claims", label: "Claim DNA", icon: Dna },
  { href: "/intel", label: "Model Intelligence", icon: Fingerprint },
  { href: "/discover", label: "Model Discovery", icon: Compass },
  { href: "/lab", label: "AI Lab", icon: FlaskConical },
  { href: "/radar", label: "Signal Radar", icon: Radar },
  { href: "/workspaces", label: "Workspaces", icon: Layers },
  { href: "/projects", label: "Research Projects", icon: FolderKanban },
  { href: "/community", label: "Community", icon: Users },
  { href: "/connectors", label: "Connectors", icon: Plug },
  { href: "/simulator", label: "What-If Simulator", icon: GitBranch, soon: true },
  { href: "/graph", label: "Knowledge Graph", icon: Network, soon: true },
  { href: "/settings", label: "Settings", icon: Settings },
];
