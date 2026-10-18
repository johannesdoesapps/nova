"use client";
import { Fragment, type ReactNode } from "react";
import { isSafeHttpUrl } from "@/lib/utils";

/**
 * Small, safe Markdown renderer. It builds React elements (never raw HTML),
 * so model or web text cannot inject markup. Supports headings, lists, code
 * blocks, inline code, bold/italic, http(s) links and [n] citation chips.
 */
export function Markdown({
  text,
  onCitation,
  validCitations,
}: {
  text: string;
  onCitation?: (n: number) => void;
  validCitations?: Set<number>;
}) {
  const blocks = parseBlocks(text);
  return (
    <div className="nova-prose text-[15px]">
      {blocks.map((b, i) => {
        const inl = (s: string) => inline(s, onCitation, validCitations);
        switch (b.type) {
          case "code":
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          case "h":
            return b.level === 1 ? <h2 key={i} className="text-lg">{inl(b.text)}</h2> : <h3 key={i}>{inl(b.text)}</h3>;
          case "ul":
            return <ul key={i}>{b.items.map((it, j) => <li key={j}>{inl(it)}</li>)}</ul>;
          case "ol":
            return <ol key={i}>{b.items.map((it, j) => <li key={j}>{inl(it)}</li>)}</ol>;
          default:
            return <p key={i}>{inl(b.text)}</p>;
        }
      })}
    </div>
  );
}

type Block =
  | { type: "p"; text: string }
  | { type: "h"; level: number; text: string }
  | { type: "code"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ type: "p", text: para.join(" ") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().startsWith("```")) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) code.push(lines[i++]!);
      out.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush();
      out.push({ type: "h", level: h[1]!.length, text: h[2]! });
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*•]\s+/, ""));
      i--;
      out.push({ type: "ul", items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*\d+[.)]\s+/, ""));
      i--;
      out.push({ type: "ol", items });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out;
}

const TOKEN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))|(\[\d{1,2}\])|(https?:\/\/[^\s)]+)/g;

function inline(s: string, onCitation?: (n: number) => void, valid?: Set<number>): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of s.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(<Fragment key={k++}>{s.slice(last, idx)}</Fragment>);
    const t = m[0];
    if (m[1]) parts.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (m[2]) parts.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (m[3]) parts.push(<em key={k++}>{t.slice(1, -1)}</em>);
    else if (m[4]) {
      const lm = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      parts.push(
        isSafeHttpUrl(lm[2]) ? (
          <a key={k++} href={lm[2]} target="_blank" rel="noopener noreferrer nofollow">
            {lm[1]}
          </a>
        ) : (
          <Fragment key={k++}>{lm[1]}</Fragment>
        ),
      );
    } else if (m[5]) {
      const n = Number(t.slice(1, -1));
      if (!valid || valid.has(n)) {
        parts.push(
          <button
            key={k++}
            type="button"
            onClick={() => onCitation?.(n)}
            className="mx-0.5 inline-flex h-[18px] min-w-[18px] -translate-y-px items-center justify-center rounded-md bg-accent-soft px-1 align-middle text-[11px] font-semibold text-accent hover:bg-accent hover:text-accent-fg"
            aria-label={`Source ${n}`}
          >
            {n}
          </button>,
        );
      }
    } else if (m[6]) {
      parts.push(
        isSafeHttpUrl(t) ? (
          <a key={k++} href={t} target="_blank" rel="noopener noreferrer nofollow">
            {t}
          </a>
        ) : (
          t
        ),
      );
    }
    last = idx + t.length;
  }
  if (last < s.length) parts.push(<Fragment key={k++}>{s.slice(last)}</Fragment>);
  return parts;
}
