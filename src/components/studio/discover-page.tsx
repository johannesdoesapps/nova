"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { discoverFor, type DiscoverItem, type DiscoverKind } from "@/lib/home";
import { StudioHeader } from "./frame";
import { HOME_ICONS } from "./home";
import { Segmented } from "./ui";

const GROUPS: { kind: DiscoverKind; title: string; text: string }[] = [
  { kind: "capability", title: "What Orbis can do", text: "Things people often don’t know they can ask for." },
  { kind: "tool", title: "Tools", text: "Workspaces for particular jobs." },
  { kind: "idea", title: "Ideas to try", text: "Ways to get more out of a conversation." },
];

/** Where an item's action goes: pages directly; prompts open on the home, filled in ("/home?try=<id>"). */
const hrefFor = (d: DiscoverItem) => (d.action.kind === "link" ? d.action.href : `/home?try=${d.id}`);

/** Discover: every curated capability, tool and idea, each with a real way to try it. */
export function DiscoverPage() {
  const { integrations } = useApp();
  const [kind, setKind] = useState<"all" | DiscoverKind>("all");
  const items = discoverFor({ search: integrations.search });
  return (
    <>
      <StudioHeader>
        <h1 className="text-[14px] font-medium text-s-ink-2">Discover</h1>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1040px] px-4 pb-24 pt-2 sm:px-8">
          <h2 className="font-serif text-[clamp(30px,5vw,40px)] leading-tight">Discover</h2>
          <p className="mt-2 max-w-2xl text-[15px] text-s-ink-2">Everything here is something Orbis does today. Pick one to try it.</p>
          <div className="mt-6">
            <Segmented
              label="Show"
              value={kind}
              onChange={setKind}
              options={[{ value: "all" as const, label: "All" }, ...GROUPS.map((g) => ({ value: g.kind, label: g.kind === "capability" ? "Capabilities" : g.kind === "tool" ? "Tools" : "Ideas" }))]}
            />
          </div>
          {GROUPS.filter((g) => kind === "all" || g.kind === kind).map((g) => {
            const list = items.filter((d) => d.kind === g.kind);
            if (!list.length) return null;
            return (
              <section key={g.kind} aria-labelledby={`discover-${g.kind}`} className="mt-8">
                <h3 id={`discover-${g.kind}`} className="text-[15px] font-semibold">
                  {g.title}
                </h3>
                <p className="mt-0.5 text-[13px] text-s-ink-3">{g.text}</p>
                <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((d) => (
                    <li key={d.id}>
                      <Link href={hrefFor(d)} className="glass group flex h-full flex-col rounded-2xl p-4 transition hover:border-s-line-strong">
                        <span className="grid h-8 w-8 place-items-center rounded-lg bg-s-accent-soft text-s-ink-2 [&_svg]:h-4 [&_svg]:w-4">{HOME_ICONS[d.icon]}</span>
                        <span className="mt-3 text-[14px] font-medium">{d.title}</span>
                        <span className="mt-1 flex-1 text-[13px] leading-snug text-s-ink-3">{d.text}</span>
                        <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium">
                          {d.cta} <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}
