import { Database, Dna, EyeOff, Fingerprint, History, ListChecks, Scale, ScrollText } from "lucide-react";

export const CLAIM_TABS = [
  { href: "/claims", label: "Claim DNA", icon: Dna },
  { href: "/claims/arena", label: "Hypothesis Arena", icon: Scale },
  { href: "/claims/replay", label: "Research Replay", icon: History },
];

export const INTEL_TABS = [
  { href: "/intel", label: "Fingerprint", icon: Fingerprint },
  { href: "/intel/trials", label: "Blind Trials", icon: EyeOff },
  { href: "/intel/benchmarks", label: "Benchmarks", icon: ListChecks },
  { href: "/intel/directory", label: "Model Directory", icon: Database },
  { href: "/intel/history", label: "Evaluation History", icon: ScrollText },
];
