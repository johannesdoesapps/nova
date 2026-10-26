import { openInCode } from "../code/handoff";
import { runAgentTool } from "./desktop-client";
import type { Prepared, Step, StepResult } from "./mission";
import { TOOLS } from "./tools";

/**
 * What actually carries out each Jarvis step: browser tools here in the page, desktop tools through the Desktop
 * Agent. Results describe what really happened; a step the browser blocked (e.g. a pop-up) is reported as such,
 * with a link to finish it by hand.
 */

const str = (v: unknown) => String(v ?? "");

/** Message from an Orbis API error ({ error: { message } }). */
async function apiError(res: Response): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return j?.error?.message ?? `The request failed (${res.status}).`;
}

/**
 * Open a page in a new tab. External pages lose any link back to Orbis; Orbis pages keep it, so the new tab gets
 * a copy of this tab's session storage (used to hand over requests). Returns false when the browser blocked it.
 */
export function openTab(url: string, external: boolean): boolean {
  const w = window.open(external ? "about:blank" : url, "_blank");
  if (!w) return false;
  if (external) {
    w.opener = null;
    w.location.href = url;
  }
  return true;
}

function opened(ok: boolean, href: string, label: string, done: string): StepResult {
  return ok
    ? { outcome: "success", summary: done, verified: true, details: { kind: "link", href, label } }
    : { outcome: "partial", summary: `Your browser blocked the new tab. Use the link to open ${label}.`, verified: false, details: { kind: "link", href, label } };
}

/** One picture of a screen or window the user picks in the browser's own sharing prompt; sharing stops at once. */
export async function captureScreen(): Promise<{ mediaType: "image/jpeg"; data: string }> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const scale = Math.min(1, 1600 / Math.max(video.videoWidth || 1, video.videoHeight || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    for (const q of [0.8, 0.6, 0.4]) {
      const data = canvas.toDataURL("image/jpeg", q).split(",")[1] ?? "";
      if (data.length < 3_900_000) return { mediaType: "image/jpeg", data };
    }
    throw new Error("The picture is too large to send.");
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

const browser: Partial<Record<Step["tool"], (step: Step, signal: AbortSignal) => Promise<StepResult>>> = {
  async open_url(step) {
    const url = str(step.args.url);
    return opened(openTab(url, true), url, new URL(url).hostname, `Opened ${new URL(url).hostname} in a new tab.`);
  },
  async open_orbis_page(step) {
    const page = str(step.args.page);
    const href = `/${page}`;
    return opened(openTab(href, false), href, `Orbis ${page}`, `Opened Orbis ${page} in a new tab.`);
  },
  async research(step, signal) {
    const res = await fetch("/api/research", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: step.args.question, depth: step.args.depth }), signal });
    if (!res.ok) return { outcome: res.status === 401 || res.status === 403 ? "permission_denied" : "failure", summary: await apiError(res), verified: null };
    const id = ((await res.json()) as { run?: { id?: string } }).run?.id;
    if (!id) return { outcome: "failure", summary: "Deep Research didn't start.", verified: null };
    const href = `/research/${id}`;
    const ok = openTab(href, false);
    return ok
      ? { outcome: "success", summary: "Started Deep Research; it runs in the new tab.", verified: true, details: { kind: "link", href, label: "the research" } }
      : { outcome: "partial", summary: "Deep Research is ready, but your browser blocked the new tab. Open it with the link to run it.", verified: true, details: { kind: "link", href, label: "the research" } };
  },
  async build_website(step) {
    openInCode({ request: str(step.args.description), target: "new:website" });
    return opened(openTab("/code", false), "/code", "Code", "Opened Code with your website request filled in; press send there to start the build.");
  },
  async start_mission(step) {
    const href = `/missions?goal=${encodeURIComponent(str(step.args.goal).slice(0, 4000))}`;
    return opened(openTab(href, false), href, "Missions", "Opened Missions with your goal filled in.");
  },
  async remember(step, signal) {
    const res = await fetch("/api/memories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: step.args.fact }), signal });
    return res.ok ? { outcome: "success", summary: `Remembered: “${str(step.args.fact)}”.`, verified: true } : { outcome: "failure", summary: await apiError(res), verified: null };
  },
  async read_clipboard() {
    if (!navigator.clipboard?.readText) return { outcome: "unsupported", summary: "This browser doesn't let pages read the clipboard.", verified: null };
    try {
      const text = (await navigator.clipboard.readText()).slice(0, 8000);
      if (!text.trim()) return { outcome: "failure", summary: "The clipboard has no text.", verified: true };
      return { outcome: "success", summary: `Read ${text.length.toLocaleString("en")} characters from the clipboard.`, verified: true, details: { kind: "text", text } };
    } catch {
      return { outcome: "permission_denied", summary: "The browser didn't allow reading the clipboard.", verified: null };
    }
  },
  async look_at_screen(step, signal) {
    if (!navigator.mediaDevices?.getDisplayMedia) return { outcome: "unsupported", summary: "This browser can't share a screen.", verified: null };
    let image;
    try {
      image = await captureScreen();
    } catch (err) {
      return (err as Error)?.name === "NotAllowedError"
        ? { outcome: "permission_denied", summary: "No screen was shared, so nothing was captured.", verified: null }
        : { outcome: "failure", summary: (err as Error)?.message || "The screen couldn't be captured.", verified: null };
    }
    const res = await fetch("/api/jarvis/look", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: step.args.question, image }), signal });
    if (!res.ok) return { outcome: "failure", summary: await apiError(res), verified: null };
    const j = (await res.json()) as { answer: string };
    return { outcome: "success", summary: j.answer, verified: null, details: { kind: "text", text: j.answer } };
  },
};

/** For batch steps: work out exactly what would change, so that list is what gets approved. */
export async function prepareStep(step: Step, signal: AbortSignal): Promise<Prepared | StepResult | null> {
  if (step.tool !== "organize_folder") return null;
  const preview = await runAgentTool("organize_preview", step.args, signal);
  if (preview.outcome !== "success") return preview;
  const d = preview.details;
  const moves = d?.kind === "moves" ? d.moves : [];
  const skipped = d?.kind === "moves" ? (d.skipped ?? []) : [];
  if (!moves.length) return { outcome: "success", summary: preview.summary, verified: true, details: d };
  return {
    preview: {
      title: `Sort ${str(step.args.path)} by type`,
      lines: moves.map((m) => `${m.from} → ${m.to}`),
      note: `${preview.summary} No files will be deleted or overwritten.${skipped.length ? ` Left where they are: ${skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}.` : ""}`,
    },
    batchSize: moves.length,
    data: { path: step.args.path, moves },
  };
}

export async function executeStep(step: Step, signal: AbortSignal, prepared?: unknown): Promise<StepResult> {
  if (TOOLS[step.tool].runner === "desktop") {
    if (step.tool === "organize_folder") return runAgentTool("organize_apply", prepared as Record<string, unknown>, signal);
    return runAgentTool(step.tool, step.args, signal);
  }
  const run = browser[step.tool];
  if (!run) return { outcome: "unsupported", summary: "That action isn't available here.", verified: null };
  try {
    return await run(step, signal);
  } catch (err) {
    if (signal.aborted) return { outcome: "cancelled", summary: "Stopped before it finished; it may already have taken effect.", verified: null };
    return { outcome: "failure", summary: err instanceof Error ? err.message : "It failed.", verified: null };
  }
}
