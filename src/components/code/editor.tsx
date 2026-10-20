"use client";
import CodeMirror from "@uiw/react-codemirror";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { useMemo } from "react";
import { languageOf } from "./api";

function extensionsFor(path: string) {
  const base = [EditorView.lineWrapping];
  switch (languageOf(path)) {
    case "javascript":
      return [...base, javascript()];
    case "jsx":
      return [...base, javascript({ jsx: true })];
    case "typescript":
      return [...base, javascript({ typescript: true })];
    case "tsx":
      return [...base, javascript({ jsx: true, typescript: true })];
    case "python":
      return [...base, python()];
    case "html":
      return [...base, html()];
    case "css":
      return [...base, css()];
    case "json":
      return [...base, json()];
    case "markdown":
      return [...base, markdown()];
    default:
      return base;
  }
}

/** The code editor (CodeMirror 6): syntax highlighting by file type, line numbers, search, undo history per file. */
export default function CodeEditor({ path, value, onChange, dark, readOnly }: { path: string; value: string; onChange: (v: string) => void; dark: boolean; readOnly?: boolean }) {
  const extensions = useMemo(() => extensionsFor(path), [path]);
  return (
    <CodeMirror
      key={path}
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={dark ? oneDark : "light"}
      readOnly={readOnly}
      height="100%"
      className="orbis-code-editor h-full text-[13px]"
      basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: true, tabSize: 2 }}
      aria-label={`Editing ${path}`}
    />
  );
}
