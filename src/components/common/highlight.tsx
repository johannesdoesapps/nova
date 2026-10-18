import type { ReactNode } from "react";

/**
 * Small, dependency-free syntax highlighter for chat code blocks. It colours
 * comments, strings, numbers, keywords and function calls for the common
 * languages; anything it doesn't recognise stays plain text. Very large
 * blocks are left unhighlighted to keep streaming smooth.
 */

const KEYWORDS: Record<string, string> = {
  js: "async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield",
  ts: "abstract as declare enum implements interface keyof namespace private protected public readonly satisfies type unknown never any",
  py: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self print",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false",
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err",
  java: "abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public return short static super switch this throw throws true false try void volatile while",
  sql: "select from where and or not insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset as distinct union all case when then else end null is in like between primary key references default returning with",
  sh: "if then else elif fi for while do done case esac function in return export local echo cd",
  css: "important",
};

const ALIASES: Record<string, string> = {
  javascript: "js", jsx: "js", mjs: "js", typescript: "ts", tsx: "ts", python: "py", golang: "go", rs: "rust",
  kotlin: "java", kt: "java", c: "java", cpp: "java", "c++": "java", cs: "java", csharp: "java", swift: "java",
  bash: "sh", shell: "sh", zsh: "sh", console: "sh", postgres: "sql", postgresql: "sql", mysql: "sql", scss: "css",
};

const HASH_COMMENTS = new Set(["py", "sh", "rb", "ruby", "yaml", "yml", "toml", "r"]);

function keywordSet(lang: string): Set<string> {
  const l = ALIASES[lang] ?? lang;
  const words = l === "ts" ? `${KEYWORDS.js} ${KEYWORDS.ts}` : (KEYWORDS[l] ?? `${KEYWORDS.js} ${KEYWORDS.py}`);
  return new Set(words.split(" "));
}

export function highlight(code: string, lang: string): ReactNode {
  const l = (ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()) || "";
  if (code.length > 20_000 || ["text", "txt", "plain", "markdown", "md"].includes(l)) return code;
  const keywords = keywordSet(l);
  const hash = HASH_COMMENTS.has(l);
  const sql = l === "sql";
  const re = new RegExp(
    [
      String.raw`(\/\*[\s\S]*?\*\/|\/\/[^\n]*${hash ? String.raw`|#[^\n]*` : ""}${sql ? String.raw`|--[^\n]*` : ""})`,
      String.raw`("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\`(?:\\.|[^\`\\])*\`)`,
      String.raw`(\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b)`,
      String.raw`([A-Za-z_$][\w$]*)`,
    ].join("|"),
    "g",
  );
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of code.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(code.slice(last, i));
    const [text, comment, str, num, word] = m;
    let cls: string | null = null;
    if (comment) cls = "tok-c";
    else if (str) cls = "tok-s";
    else if (num) cls = "tok-n";
    else if (word) {
      const lower = sql ? word.toLowerCase() : word;
      if (keywords.has(lower)) cls = "tok-k";
      else if (code[i + word.length] === "(" || /^\s*\(/.test(code.slice(i + word.length, i + word.length + 4))) cls = "tok-f";
    }
    out.push(cls ? <span key={key++} className={cls}>{text}</span> : text);
    last = i + text.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}
