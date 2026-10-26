"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import { Download, ImageIcon, Loader2 } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { jsonFetch } from "@/hooks/use-ndjson";
import { cn } from "@/lib/utils";
import { StudioHeader } from "./frame";
import { Segmented } from "./ui";

type Size = "1024x1024" | "1536x1024" | "1024x1536";
type Quality = "low" | "medium" | "high";
type Made = { url: string; prompt: string; size: Size };

const SIZES: { value: Size; label: string }[] = [
  { value: "1024x1024", label: "Square" },
  { value: "1536x1024", label: "Landscape" },
  { value: "1024x1536", label: "Portrait" },
];
const QUALITIES: { value: Quality; label: string }[] = [
  { value: "low", label: "Draft" },
  { value: "medium", label: "Standard" },
  { value: "high", label: "High" },
];
const ASPECT: Record<Size, string> = { "1024x1024": "1 / 1", "1536x1024": "3 / 2", "1024x1536": "2 / 3" };

// The pixel-mosaic loader uses WebGL (three.js): loaded only on this page, and only in the browser.
const ImageLoader = dynamic(() => import("./image-loader"), {
  ssr: false,
  loading: () => <div className="w-full animate-pulse rounded-[18px] bg-s-hover" style={{ aspectRatio: "1 / 1" }} />,
});

const btn = "inline-flex h-10 items-center justify-center gap-1.5 rounded-full px-5 text-[14px] font-medium transition disabled:opacity-40 [&_svg]:h-4 [&_svg]:w-4";

/**
 * Create an image from a description with OpenAI's image model. Each image uses usage units like a message
 * to a larger model (higher quality uses more). Images aren't kept by Orbis: download the ones you want.
 */
export function ImagesPage() {
  const { user } = useApp();
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<Size>("1024x1024");
  const [quality, setQuality] = useState<Quality>("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Made[]>([]);
  /** The image being created: shown as the loader, then moved into `made` once it has been revealed. */
  const [pending, setPending] = useState<{ url: string | null; prompt: string; size: Size } | null>(null);

  const create = async () => {
    const p = prompt.trim();
    if (p.length < 3 || busy) return;
    setBusy(true);
    setError(null);
    setPending({ url: null, prompt: p, size });
    try {
      const j = await jsonFetch<{ image: string }>("/api/images", { method: "POST", body: JSON.stringify({ prompt: p, size, quality, requestId: crypto.randomUUID() }) });
      setPending({ url: j.image, prompt: p, size });
    } catch (e) {
      setPending(null);
      setError(e instanceof Error ? e.message : "The image couldn't be created. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <StudioHeader>
        <h1 className="text-[14px] font-medium text-s-ink-2">Images</h1>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-24 pt-2 sm:px-8">
          <h2 className="font-serif text-[clamp(30px,5vw,40px)] leading-tight">Images</h2>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-s-ink-3">
            Describe the picture you want. Each image uses units from your allowance, like a message to a larger model; Draft uses the fewest. Orbis doesn’t keep your images, so download the ones you
            want.
          </p>
          {!user ? (
            <section className="glass mt-6 rounded-[22px] p-5">
              <p className="text-[14px] text-s-ink-2">Sign in to create images.</p>
              <Link href="/login?next=/images" className={cn(btn, "mt-4 bg-s-accent text-s-accent-ink hover:brightness-110")}>
                Sign in
              </Link>
            </section>
          ) : (
            <section aria-label="Create an image" className="glass mt-6 rounded-[22px] p-4 sm:p-5">
              <label htmlFor="image-prompt" className="text-[13.5px] font-medium">
                Description
              </label>
              <textarea
                id="image-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void create();
                }}
                maxLength={2000}
                rows={3}
                placeholder="A watercolour of a lighthouse at dawn, soft pink sky, calm sea"
                className="mt-1.5 w-full resize-y rounded-xl border border-s-line bg-transparent px-3 py-2 text-[14px] outline-none placeholder:text-s-ink-3 focus:border-s-line-strong"
              />
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Segmented label="Shape" value={size} onChange={setSize} options={SIZES} />
                <Segmented label="Quality" value={quality} onChange={setQuality} options={QUALITIES} />
                <button type="button" onClick={() => void create()} disabled={busy || prompt.trim().length < 3} className={cn(btn, "ml-auto bg-s-accent text-s-accent-ink hover:brightness-110")}>
                  {busy ? <Loader2 className="animate-spin" /> : <ImageIcon />}
                  {busy ? "Creating…" : "Create image"}
                </button>
              </div>
              {busy && (
                <p className="mt-3 text-[12.5px] text-s-ink-3" role="status">
                  This can take up to a minute.
                </p>
              )}
              {error && (
                <p className="mt-3 text-[13px] text-s-danger" role="alert">
                  {error}
                </p>
              )}
            </section>
          )}
          {(made.length > 0 || pending) && (
            <ul className="mt-6 grid gap-4 sm:grid-cols-2">
              {pending && (
                <li className="glass overflow-hidden rounded-[18px]" aria-busy={!pending.url}>
                  <ImageLoader
                    src={pending.url}
                    aspect={ASPECT[pending.size]}
                    onRevealed={() => {
                      const done = pending;
                      if (done.url) setMade((xs) => [{ url: done.url!, prompt: done.prompt, size: done.size }, ...xs].slice(0, 12));
                      setPending(null);
                    }}
                  />
                  <div className="p-3">
                    <p className="text-[12.5px] leading-relaxed text-s-ink-2">{pending.prompt}</p>
                    <p className="mt-0.5 text-[12px] text-s-ink-3">{pending.url ? "Done" : "Creating…"}</p>
                  </div>
                </li>
              )}
              {made.map((m, i) => (
                <li key={`${i}-${m.prompt.slice(0, 20)}`} className="glass overflow-hidden rounded-[18px]">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL, not a static asset */}
                  <img src={m.url} alt={m.prompt} className="h-auto w-full" />
                  <div className="flex items-start gap-2 p-3">
                    <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-s-ink-2">{m.prompt}</p>
                    <a
                      href={m.url}
                      download={`orbis-image-${i + 1}.jpg`}
                      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-s-line-strong px-2.5 text-[12.5px] hover:bg-s-hover"
                    >
                      <Download className="h-3.5 w-3.5" /> Download
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
