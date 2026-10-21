import { z } from "zod";

/**
 * Attachments for coding tasks: which files can be attached, their limits,
 * and the checks run in the browser and again on the server. Text files are
 * read by the agent; images are shown to models that can see images. Nothing
 * attached is ever run.
 */

export const MAX_TEXT_BYTES = 200_000;
/** Images are resized in the browser to fit this many pixels on the long side (what vision models use anyway). */
export const MAX_IMAGE_SIDE = 1_600;
export const MAX_IMAGE_BYTES = 2_500_000;
export const MAX_ATTACHMENTS = 20;
/** Characters of attached text put straight into the task; the rest the agent reads with read_attachment. */
export const ATTACHED_TEXT_BUDGET = 60_000;

const TEXT_EXT = [
  "txt",
  "md",
  "markdown",
  "mdx",
  "rst",
  "csv",
  "tsv",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "xml",
  "svg",
  "log",
  "env.example",
  "sql",
  "graphql",
  "gql",
  "proto",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "vue",
  "svelte",
  "astro",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "py",
  "pyi",
  "rb",
  "php",
  "java",
  "kt",
  "kts",
  "scala",
  "go",
  "rs",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "swift",
  "m",
  "mm",
  "dart",
  "lua",
  "r",
  "pl",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "ex",
  "exs",
  "erl",
  "hs",
  "clj",
  "elm",
  "fs",
  "ml",
  "nim",
  "zig",
  "sol",
  "tf",
  "hcl",
  "gradle",
  "properties",
  "lock",
  "patch",
  "diff",
  "ipynb",
];
const TEXT_NAMES = [
  "dockerfile",
  "makefile",
  "procfile",
  "gemfile",
  "rakefile",
  "license",
  "readme",
  "changelog",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
  ".babelrc",
  ".nvmrc",
  ".npmignore",
];
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
export const TEXT_ACCEPT = TEXT_EXT.map((e) => `.${e}`).join(",") + ",text/*";

/** Folders skipped when a whole folder is chosen. */
const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|\.venv|venv|__pycache__|\.cache|\.turbo|vendor|target)(\/|$)/;

export function baseName(name: string): string {
  return name.split("/").pop() ?? name;
}

/** Files that usually hold credentials: never attached (the AI must not see them). */
export function isSecretName(name: string): boolean {
  const n = baseName(name).toLowerCase();
  if (/^\.env\.(example|sample|template|dist)$/.test(n)) return false;
  return /^\.env(\..+)?$|\.(pem|key|p12|pfx|keystore)$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|^(credentials|service-account|secrets?)\.(json|ya?ml|toml)$|^\.(npmrc|pypirc|netrc|git-credentials)$/.test(
    n,
  );
}

export function isTextName(name: string): boolean {
  const n = baseName(name).toLowerCase();
  if (TEXT_NAMES.includes(n)) return true;
  const ext = n.includes(".") ? n.slice(n.indexOf(".") + 1) : "";
  const last = n.includes(".") ? n.slice(n.lastIndexOf(".") + 1) : "";
  return TEXT_EXT.includes(ext) || TEXT_EXT.includes(last);
}

export function isImageType(type: string): boolean {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type);
}

/** Folder entries worth attaching (no dependency or build folders). */
export function inSkippedFolder(path: string): boolean {
  return SKIP_DIRS.test(path);
}

/** Text that is really binary: NUL characters, or many undecodable bytes. */
export function looksBinary(text: string): boolean {
  if (text.includes("\u0000")) return true;
  const bad = (text.match(/�/g) ?? []).length;
  return text.length > 0 && bad / text.length > 0.01;
}

/** Why a file can't be attached, before reading it (null when it can be). */
export function rejectReason(file: { name: string; type: string; size: number }): string | null {
  if (isSecretName(file.name)) return `${baseName(file.name)} looks like a file with secrets (keys, passwords), so it isn't sent to the AI.`;
  if (isImageType(file.type)) return null;
  if (file.type.startsWith("image/")) return `${baseName(file.name)}: only PNG, JPEG, WebP and GIF images can be attached.`;
  if (/\.(pdf|docx?|xlsx?|pptx?|odt|pages|key|numbers)$/i.test(file.name))
    return `${baseName(file.name)}: PDF and Office files can't be read yet. Export it as text or Markdown, or paste the part you need.`;
  if (!isTextName(file.name) && !file.type.startsWith("text/")) return `${baseName(file.name)}: only text and source files, and images, can be attached.`;
  if (file.size > MAX_TEXT_BYTES) return `${baseName(file.name)} is larger than ${Math.round(MAX_TEXT_BYTES / 1000)} KB.`;
  return null;
}

/** Plain relative names only (folder uploads keep their path inside the folder). */
export const attachmentName = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((n) => !n.startsWith("/") && !/(^|\/)\.{1,2}(\/|$)/.test(n) && !/[\\\u0000-\u001f\u007f]/.test(n), "Invalid file name.");

export const attachmentInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), name: attachmentName, content: z.string().max(MAX_TEXT_BYTES) }).strict(),
  z
    .object({
      kind: z.literal("image"),
      name: attachmentName,
      mediaType: z.enum(["image/jpeg", "image/png"]),
      data: z
        .string()
        .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/, "Image data must be base64."),
    })
    .strict(),
]);
export type AttachmentInput = z.infer<typeof attachmentInput>;

/** What the browser and the run view know about an attachment (never its contents). */
export interface AttachmentMeta {
  id: string;
  name: string;
  kind: "text" | "image";
  mediaType: "text/plain" | "image/jpeg" | "image/png";
  size: number;
}

/** The image type from its first bytes (not from the name or the browser's claim). */
export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a)
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}
