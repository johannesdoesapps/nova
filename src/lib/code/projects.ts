import { z } from "zod";

/**
 * Code workspace projects: limits, path rules and starter templates. Shared
 * by the API and the editor; the database enforces the same limits
 * (supabase/migrations/20261020020000_code_workspace.sql).
 */

export const MAX_PROJECT_FILES = 300;
export const MAX_FILE_BYTES = 204_800;
export const MAX_PROJECT_BYTES = 3 * 1024 * 1024;
/** Administrators' projects are larger, so Orbis's own code fits (the database applies the same rule). */
export const ADMIN_MAX_PROJECT_FILES = 2000;
export const ADMIN_MAX_PROJECT_BYTES = 20 * 1024 * 1024;

export function projectLimits(admin: boolean): { files: number; bytes: number } {
  return admin ? { files: ADMIN_MAX_PROJECT_FILES, bytes: ADMIN_MAX_PROJECT_BYTES } : { files: MAX_PROJECT_FILES, bytes: MAX_PROJECT_BYTES };
}
/** The port a project's app listens on for the live preview. */
export const PREVIEW_PORT = 3000;

/** Folders that hold installed packages or build output: never copied back from the workspace computer. */
export const IGNORED_DIRS = ["node_modules", ".git", ".next", "dist", "build", "out", "__pycache__", ".venv", "venv", ".cache", ".npm", "coverage", ".pytest_cache", "target", ".turbo", ".vercel"];

export function isIgnoredPath(path: string): boolean {
  return path.split("/").some((part) => IGNORED_DIRS.includes(part));
}

/** A plain relative path: no leading slash, no "." or ".." parts, no backslashes or control characters. */
export function validProjectPath(path: string): boolean {
  if (path.length < 1 || path.length > 300) return false;
  if (path.startsWith("/") || path.includes("//") || path.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export const projectPath = z.string().refine(validProjectPath, "Use a plain file path like src/app.js.");
export const fileContent = z.string().refine((s) => byteLength(s) <= MAX_FILE_BYTES, "Files can be at most 200 KB.");

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export const TEMPLATE_IDS = ["blank", "python", "node", "website"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface Template {
  id: TemplateId;
  label: string;
  description: string;
  runCommand: string;
  files: Record<string, string>;
}

export const TEMPLATES: Record<TemplateId, Template> = {
  website: {
    id: "website",
    label: "Website",
    description: "HTML, CSS and JavaScript with a live preview.",
    runCommand: "python3 -m http.server 3000",
    files: {
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My site</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main>
      <h1>Hello from Orbis</h1>
      <p>Edit index.html, press Run, and open the preview.</p>
      <button id="count">Clicked 0 times</button>
    </main>
    <script src="script.js"></script>
  </body>
</html>
`,
      "style.css": `body {
  font-family: system-ui, sans-serif;
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #0b0d12;
  color: #f3f4f6;
}
button {
  font: inherit;
  padding: 0.6rem 1rem;
  border-radius: 0.6rem;
  border: 0;
  background: #6366f1;
  color: white;
  cursor: pointer;
}
`,
      "script.js": `let clicks = 0;
const button = document.getElementById("count");
button.addEventListener("click", () => {
  clicks += 1;
  button.textContent = \`Clicked \${clicks} time\${clicks === 1 ? "" : "s"}\`;
});
`,
    },
  },
  node: {
    id: "node",
    label: "Node.js app",
    description: "A small web server with npm packages.",
    runCommand: "npm install && npm start",
    files: {
      "package.json": `{
  "name": "my-app",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node index.js"
  }
}
`,
      "index.js": `import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);

createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(\`<h1>Hello from Node.js</h1><p>You asked for \${req.url}</p>\`);
}).listen(port, "0.0.0.0", () => console.log(\`Listening on port \${port}\`));
`,
    },
  },
  python: {
    id: "python",
    label: "Python",
    description: "A Python script; add packages to requirements.txt.",
    runCommand: "python3 main.py",
    files: {
      "main.py": `def greet(name: str) -> str:
    return f"Hello, {name}!"


if __name__ == "__main__":
    print(greet("Orbis"))
`,
      "requirements.txt": "",
    },
  },
  blank: {
    id: "blank",
    label: "Blank",
    description: "An empty project.",
    runCommand: "",
    files: { "README.md": "# My project\n" },
  },
};

export const newProjectBody = z.object({
  name: z.string().trim().min(1).max(80),
  template: z.enum(TEMPLATE_IDS).default("blank"),
});

export interface ProjectSummary {
  id: string;
  name: string;
  template: string;
  runCommand: string;
  sourceRepo: string | null;
  updatedAt: string;
}

export interface ProjectFile {
  path: string;
  content: string;
}

/** A proposed change to one file: null content means delete. */
export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

/**
 * "Try an example": a small calculator whose tests fail, created as an
 * ordinary Node.js project, so a first-time user can watch the agent find the
 * bug, fix it and run the tests.
 */
export const EXAMPLE_PROJECT = {
  name: "Example: calculator with a bug",
  template: "node" as TemplateId,
  runCommand: "npm test",
  task: "The tests fail. Find the bug, fix it, and make the tests pass. Don't change the tests.",
  files: {
    "package.json": `{
  "name": "calculator",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
    "README.md": "# Calculator\n\nA tiny calculator library. Run the tests with `npm test`.\n",
    "src/calc.js": "export function add(a, b) {\n  return a - b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n",
    "test/calc.test.js": `import test from "node:test";
import assert from "node:assert/strict";
import { add, multiply } from "../src/calc.js";

test("adds two numbers", () => {
  assert.equal(add(2, 3), 5);
});

test("adds negative numbers", () => {
  assert.equal(add(-1, -2), -3);
});

test("multiplies", () => {
  assert.equal(multiply(4, 5), 20);
});
`,
  } as Record<string, string>,
};
