import { ClipboardCheck, FlaskConical, LayoutTemplate, ListOrdered, ShieldCheck, Workflow } from "lucide-react";

export const LAB_TABS = [
  { href: "/lab", label: "Goal → Plan", icon: FlaskConical },
  { href: "/lab/workflows", label: "Workflows", icon: Workflow },
  { href: "/lab/runs", label: "Runs", icon: ListOrdered },
  { href: "/lab/approvals", label: "Approvals", icon: ClipboardCheck },
  { href: "/lab/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/lab/tools", label: "Tool permissions", icon: ShieldCheck },
];
