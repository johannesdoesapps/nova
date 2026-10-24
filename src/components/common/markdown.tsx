"use client";
import { Fragment, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { isSafeHttpUrl } from "@/lib/utils";
import { codeLanguage } from "@/lib/code/languages";
import { RunButton, RunOutput, useCodeRun } from "./code-run";
import { highlight } from "./highlight";

/**
 * Small, safe Markdown renderer. It builds React elements (never raw HTML),
 * so model or web text cannot inject markup. Supports headings, lists, code
 * blocks (with a language label and copy button), tables, quotes, rules,
 * inline code, bold/italic, http(s) links and [n] citation chips. Wide code
 * blocks and tables scroll sideways inside a region that keyboards can reach. With `runnable`, code
 * blocks in a supported language get a Run button (see /api/code/run).
 */
export function Markdown({
  text,
  onCitation,
  validCitations,
  className = "orbis-prose text-[15px]",
  runnable = false,
}: {
  text: string;
  onCitation?: (n: number) => void;
  validCitations?: Set<number>;
  className?: string;
  /** Offer a Run button on code blocks Orbis can execute (not while the text is still streaming). */
  runnable?: boolean;
}) {
  const blocks = parseBlocks(text);
  // Replies usually start at "##". The top level used is announced as a level-2 heading (under the page's
  // h1) and the rest follow on from it, so screen readers never hear a skipped level; the look is unchanged.
  const top = Math.min(3, ...blocks.flatMap((b) => (b.type === "h" ? [b.level] : [])));
  const ariaLevel = (level: number) => Math.min(6, 2 + Math.min(level, 3) - top);
  return (
    <div className={className}>
      {blocks.map((b, i) => {
        const inl = (s: string) => inline(s, onCitation, validCitations);
        switch (b.type) {
          case "code":
            return runnable && codeLanguage(b.lang) && b.text.trim() ? (
              <RunnableCode key={i} lang={b.lang} text={b.text} />
            ) : (
              <div key={i} className="orbis-code">
                <div className="orbis-code-head">
                  <span>{b.lang || "code"}</span>
                  <CodeCopy text={b.text} />
                </div>
                <pre tabIndex={0} aria-label={b.lang ? `Code, ${b.lang}` : "Code"}>
                  <code>{highlight(b.text, b.lang)}</code>
                </pre>
              </div>
            );
          case "table":
            return (
              <div key={i} className="orbis-table" tabIndex={0} role="region" aria-label="Table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} scope="col" style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                          {inl(c)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {b.head.map((_, k) => (
                          <td key={k} style={b.align[k] ? { textAlign: b.align[k] } : undefined}>
                            {inl(r[k] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "h":
            return b.level === 1 ? (
              <h2 key={i}>{inl(b.text)}</h2>
            ) : b.level === 2 ? (
              <h3 key={i} aria-level={ariaLevel(2) === 3 ? undefined : ariaLevel(2)}>
                {inl(b.text)}
              </h3>
            ) : (
              <h4 key={i} aria-level={ariaLevel(b.level) === 4 ? undefined : ariaLevel(b.level)}>
                {inl(b.text)}
              </h4>
            );
          case "quote":
            return <blockquote key={i}>{inl(b.text)}</blockquote>;
          case "hr":
            return <hr key={i} />;
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
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "table"; head: string[]; align: ("left" | "center" | "right" | undefined)[]; rows: string[][] };

const TABLE_ROW = /^\s*\|?.*\|.*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** A table row's cells: outer pipes dropped, split on pipes that aren't escaped. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

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
      const lang = line.trim().slice(3).trim().split(/\s/)[0]!.slice(0, 20);
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) code.push(lines[i++]!);
      out.push({ type: "code", lang, text: code.join("\n") });
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? "") && cells(lines[i + 1]!).length === cells(line).length) {
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) rows.push(cells(lines[i++]!));
      i--;
      out.push({ type: "table", head, align, rows });
      continue;
    }
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push({ type: "hr" });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) q.push(lines[i++]!.replace(/^\s*>\s?/, "").trim());
      i--;
      out.push({ type: "quote", text: q.filter(Boolean).join(" ") });
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

function RunnableCode({ lang, text }: { lang: string; text: string }) {
  const { state, run, stop } = useCodeRun(lang, text);
  return (
    <div className="orbis-code">
      <div className="orbis-code-head">
        <span>{lang}</span>
        <span className="flex items-center gap-1">
          <RunButton running={state.status === "running"} onRun={run} onStop={stop} />
          <CodeCopy text={text} />
        </span>
      </div>
      <pre tabIndex={0} aria-label={`Code, ${lang}`}>
        <code>{highlight(text, lang)}</code>
      </pre>
      <RunOutput state={state} />
    </div>
  );
}

function CodeCopy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-sans text-[11.5px] opacity-80 transition hover:opacity-100"
      aria-label={done ? "Copied" : "Copy code"}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? "Copied" : "Copy"}
    </button>
  );
}
