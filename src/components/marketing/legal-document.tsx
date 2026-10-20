import Link from "next/link";
import type { ReactNode } from "react";
import { LEGAL, type Block, type LegalSection } from "@/content/legal";

/** Inline text: **bold** and [label](href). Internal links use Link; others open as plain anchors. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={m.index} className="font-medium text-fg">{m[1]}</strong>);
    else {
      const href = m[3]!;
      const cls = "text-fg underline underline-offset-4 hover:text-accent-2";
      out.push(
        href.startsWith("/") ? (
          <Link key={m.index} href={href} className={cls}>{m[2]}</Link>
        ) : (
          <a key={m.index} href={href} className={cls} {...(href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}>{m[2]}</a>
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function BlockView({ block }: { block: Block }) {
  if (typeof block === "string") return <p>{inline(block)}</p>;
  return (
    <ul className="list-disc space-y-2.5 pl-5 marker:text-muted">
      {block.list.map((item, i) => (
        <li key={i}>{inline(item)}</li>
      ))}
    </ul>
  );
}

/** A legal page: title, last-updated date, contents and numbered sections. */
export function LegalDocument({ title, intro, sections }: { title: string; intro: string; sections: LegalSection[] }) {
  return (
    <article className="mx-auto max-w-3xl px-5 pt-16 pb-20 sm:px-8 sm:pt-20">
      <h1 className="text-balance font-serif text-[44px] leading-[1.05] tracking-[-0.01em] text-fg sm:text-[56px]">{title}</h1>
      <p className="mt-4 text-sm text-muted">Last updated {LEGAL.updated}</p>
      <p className="mt-5 text-[17px] leading-relaxed text-muted">{intro}</p>
      <nav aria-label="Contents" className="mt-8 rounded-2xl border border-border bg-panel p-5">
        <h2 className="text-sm font-medium text-fg">Contents</h2>
        <ol className="mt-3 grid list-decimal gap-x-6 gap-y-2 pl-5 text-sm text-muted sm:grid-cols-2">
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="hover:text-fg">
                {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      {sections.map((s, i) => (
        <section key={s.id} aria-labelledby={s.id} className="mt-12 scroll-mt-24">
          <h2 id={s.id} className="text-2xl font-medium text-fg">
            {i + 1}. {s.title}
          </h2>
          <div className="mt-4 space-y-4 text-[15.5px] leading-relaxed text-muted">
            {s.blocks.map((b, j) => (
              <BlockView key={j} block={b} />
            ))}
          </div>
        </section>
      ))}
    </article>
  );
}
