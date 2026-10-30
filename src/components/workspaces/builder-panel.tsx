"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronUp, Download, Loader2, Monitor, Plus, Save, Smartphone, Tablet, Trash2 } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader, useStudio } from "@/components/studio/frame";
import { WORKSPACES, type WorkspaceKey } from "@/lib/workspaces/catalog";
import { cn } from "@/lib/utils";

/**
 * A real, self-contained drag-and-drop page builder: add blocks, reorder them, edit their text,
 * preview responsively, then export the generated HTML or save the layout to Projects.
 * No model call — everything happens in the browser.
 */

type BlockType = "navbar" | "hero" | "features" | "about" | "gallery" | "stats" | "testimonial" | "pricing" | "cta" | "contact" | "footer";
interface Field { key: string; label: string; area?: boolean }
interface BlockDef { type: BlockType; name: string; fields: Field[]; defaults: Record<string, string>; render: (f: Record<string, string>, t: Theme) => string }
interface Block { id: string; type: BlockType; fields: Record<string, string> }
interface Theme { accent: string; font: string }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

const DEFS: BlockDef[] = [
  {
    type: "navbar",
    name: "Navigation bar",
    fields: [{ key: "brand", label: "Brand" }, { key: "links", label: "Links (one per line)", area: true }, { key: "cta", label: "Button" }],
    defaults: { brand: "Brand", links: "Home\nFeatures\nPricing\nContact", cta: "Get started" },
    render: (f) =>
      `<nav class="nav"><div class="wrap nav-in"><a class="brand" href="#">${esc(f.brand)}</a><div class="nav-links">${lines(f.links).map((l) => `<a href="#">${esc(l)}</a>`).join("")}</div><a class="btn" href="#">${esc(f.cta)}</a></div></nav>`,
  },
  {
    type: "hero",
    name: "Hero",
    fields: [{ key: "eyebrow", label: "Eyebrow" }, { key: "title", label: "Heading" }, { key: "subtitle", label: "Subheading", area: true }, { key: "cta", label: "Primary button" }, { key: "cta2", label: "Secondary button" }],
    defaults: { eyebrow: "New", title: "A headline that sells your idea", subtitle: "One or two clear sentences about what you offer and why it matters.", cta: "Start now", cta2: "Learn more" },
    render: (f) =>
      `<header class="hero"><div class="wrap hero-in">${f.eyebrow ? `<span class="eyebrow">${esc(f.eyebrow)}</span>` : ""}<h1>${esc(f.title)}</h1><p class="lead">${esc(f.subtitle)}</p><div class="actions">${f.cta ? `<a class="btn" href="#">${esc(f.cta)}</a>` : ""}${f.cta2 ? `<a class="btn ghost" href="#">${esc(f.cta2)}</a>` : ""}</div></div></header>`,
  },
  {
    type: "features",
    name: "Features",
    fields: [{ key: "title", label: "Section title" }, { key: "items", label: "Features — “Title | description”, one per line", area: true }],
    defaults: { title: "What you get", items: "Fast | Built for speed from the first byte.\nSimple | A calm interface that stays out of your way.\nReliable | Tested, monitored and dependable." },
    render: (f) =>
      `<section class="sec"><div class="wrap"><h2>${esc(f.title)}</h2><div class="grid3">${lines(f.items).map((l) => { const [t, d] = l.split("|"); return `<div class="card"><h3>${esc((t || "").trim())}</h3><p>${esc((d || "").trim())}</p></div>`; }).join("")}</div></div></section>`,
  },
  {
    type: "about",
    name: "About",
    fields: [{ key: "title", label: "Title" }, { key: "body", label: "Body", area: true }],
    defaults: { title: "About us", body: "Tell your story here: who you are, what you believe, and why people should trust you. Keep it human and specific." },
    render: (f) => `<section class="sec narrow"><div class="wrap"><h2>${esc(f.title)}</h2>${lines(f.body).map((p) => `<p class="body">${esc(p)}</p>`).join("")}</div></section>`,
  },
  {
    type: "gallery",
    name: "Gallery",
    fields: [{ key: "title", label: "Title" }, { key: "captions", label: "Captions (one per line)", area: true }],
    defaults: { title: "Our work", captions: "Project one\nProject two\nProject three\nProject four\nProject five\nProject six" },
    render: (f) =>
      `<section class="sec"><div class="wrap"><h2>${esc(f.title)}</h2><div class="grid3 gallery">${lines(f.captions).map((c, i) => `<figure class="tile tile${(i % 4) + 1}"><figcaption>${esc(c)}</figcaption></figure>`).join("")}</div></div></section>`,
  },
  {
    type: "stats",
    name: "Stats",
    fields: [{ key: "items", label: "Stats — “Number | label”, one per line", area: true }],
    defaults: { items: "10k+ | Customers\n99.9% | Uptime\n4.9/5 | Rating\n24/7 | Support" },
    render: (f) => `<section class="sec stats"><div class="wrap grid4">${lines(f.items).map((l) => { const [n, lb] = l.split("|"); return `<div class="stat"><div class="num">${esc((n || "").trim())}</div><div class="lbl">${esc((lb || "").trim())}</div></div>`; }).join("")}</div></section>`,
  },
  {
    type: "testimonial",
    name: "Testimonial",
    fields: [{ key: "quote", label: "Quote", area: true }, { key: "name", label: "Name" }, { key: "role", label: "Role" }],
    defaults: { quote: "This changed how our whole team works. We shipped in days what used to take months.", name: "Alex Doe", role: "CEO, Example Co" },
    render: (f) => `<section class="sec narrow"><div class="wrap"><blockquote class="quote">“${esc(f.quote)}”</blockquote><div class="cite"><strong>${esc(f.name)}</strong>${f.role ? ` · ${esc(f.role)}` : ""}</div></div></section>`,
  },
  {
    type: "pricing",
    name: "Pricing",
    fields: [{ key: "title", label: "Title" }, { key: "plans", label: "Plans — “Name | price | features (semicolons)”, one per line", area: true }],
    defaults: { title: "Pricing", plans: "Starter | $0 | 1 project; Community support; Basic features\nPro | $19/mo | Unlimited projects; Priority support; All features\nTeam | $49/mo | Everything in Pro; Seats; SSO" },
    render: (f) =>
      `<section class="sec"><div class="wrap"><h2>${esc(f.title)}</h2><div class="grid3">${lines(f.plans).map((l, i) => { const [n, p, feats] = l.split("|"); return `<div class="card price${i === 1 ? " featured" : ""}"><h3>${esc((n || "").trim())}</h3><div class="amount">${esc((p || "").trim())}</div><ul>${(feats || "").split(";").map((x) => x.trim()).filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join("")}</ul><a class="btn" href="#">Choose</a></div>`; }).join("")}</div></div></section>`,
  },
  {
    type: "cta",
    name: "Call to action",
    fields: [{ key: "title", label: "Title" }, { key: "subtitle", label: "Subtitle", area: true }, { key: "cta", label: "Button" }],
    defaults: { title: "Ready to start?", subtitle: "Join thousands already using our product.", cta: "Get started free" },
    render: (f) => `<section class="sec cta"><div class="wrap"><h2>${esc(f.title)}</h2><p class="lead">${esc(f.subtitle)}</p><a class="btn" href="#">${esc(f.cta)}</a></div></section>`,
  },
  {
    type: "contact",
    name: "Contact",
    fields: [{ key: "title", label: "Title" }, { key: "subtitle", label: "Subtitle", area: true }, { key: "button", label: "Button" }],
    defaults: { title: "Get in touch", subtitle: "Send a message and we’ll reply within one business day.", button: "Send message" },
    render: (f) =>
      `<section class="sec narrow"><div class="wrap"><h2>${esc(f.title)}</h2><p class="body">${esc(f.subtitle)}</p><form class="form" onsubmit="return false"><input placeholder="Your name" aria-label="Your name"><input placeholder="Email" aria-label="Email" type="email"><textarea placeholder="Message" aria-label="Message" rows="4"></textarea><button class="btn" type="submit">${esc(f.button)}</button></form></div></section>`,
  },
  {
    type: "footer",
    name: "Footer",
    fields: [{ key: "brand", label: "Brand" }, { key: "note", label: "Note" }],
    defaults: { brand: "Brand", note: "© 2026 Brand. All rights reserved." },
    render: (f) => `<footer class="footer"><div class="wrap foot-in"><span class="brand">${esc(f.brand)}</span><span class="note">${esc(f.note)}</span></div></footer>`,
  },
];

const DEF = (t: BlockType) => DEFS.find((d) => d.type === t)!;
const FONTS: Record<string, string> = { Sans: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", Serif: "Georgia, 'Times New Roman', serif", Rounded: "'Trebuchet MS', 'Segoe UI', sans-serif" };

function styleSheet(t: Theme): string {
  const font = FONTS[t.font] ?? FONTS.Sans;
  return `*{box-sizing:border-box;margin:0;padding:0}body{font-family:${font};color:#1a1d24;background:#fff;line-height:1.6}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}a{color:inherit;text-decoration:none}
h1{font-size:clamp(34px,6vw,60px);line-height:1.05;letter-spacing:-.02em}h2{font-size:clamp(24px,3.5vw,38px);letter-spacing:-.01em;margin-bottom:28px;text-align:center}h3{font-size:19px;margin-bottom:8px}
.btn{display:inline-block;background:${t.accent};color:#fff;padding:12px 22px;border-radius:12px;font-weight:600;border:0;cursor:pointer;font-size:15px}.btn.ghost{background:transparent;color:${t.accent};border:1px solid ${t.accent}}
.nav{border-bottom:1px solid #eceef2;position:sticky;top:0;background:rgba(255,255,255,.85);backdrop-filter:blur(8px);z-index:5}.nav-in{display:flex;align-items:center;gap:20px;height:66px}.brand{font-weight:800;font-size:18px}.nav-links{display:flex;gap:22px;margin-left:auto;font-size:15px;color:#555}
.hero{padding:90px 0 80px;background:linear-gradient(180deg,#f7f8fb,#fff)}.hero-in{text-align:center;max-width:760px;margin:0 auto}.eyebrow{display:inline-block;background:${t.accent}18;color:${t.accent};padding:5px 12px;border-radius:999px;font-size:13px;font-weight:600;margin-bottom:18px}.lead{font-size:clamp(16px,2vw,20px);color:#555;margin:18px 0 28px}.actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.sec{padding:72px 0}.sec.narrow .wrap{max-width:720px}.body{color:#555;margin-bottom:14px;font-size:16px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:20px}
.card{background:#fff;border:1px solid #eceef2;border-radius:16px;padding:26px}.card p{color:#555}
.price .amount{font-size:30px;font-weight:800;margin:6px 0 14px}.price ul{list-style:none;margin:0 0 20px}.price li{padding:6px 0;border-bottom:1px solid #f1f2f5;color:#555;font-size:14px}.price.featured{border-color:${t.accent};box-shadow:0 10px 40px ${t.accent}22}
.gallery .tile{aspect-ratio:4/3;border-radius:16px;display:flex;align-items:flex-end;padding:16px;color:#fff;font-weight:600}.tile1{background:linear-gradient(135deg,${t.accent},#8b5cf6)}.tile2{background:linear-gradient(135deg,#06b6d4,${t.accent})}.tile3{background:linear-gradient(135deg,#f59e0b,#ef4444)}.tile4{background:linear-gradient(135deg,#10b981,#06b6d4)}
.stats{background:#0f1320;color:#fff}.stat{text-align:center}.num{font-size:40px;font-weight:800;color:#fff}.lbl{color:#9aa3b2;margin-top:4px}
.quote{font-size:clamp(20px,3vw,28px);text-align:center;line-height:1.4;font-weight:500}.cite{text-align:center;color:#777;margin-top:18px}
.cta{background:${t.accent};color:#fff;text-align:center}.cta h2,.cta .lead{color:#fff}.cta .lead{opacity:.92}.cta .btn{background:#fff;color:${t.accent};margin-top:8px}
.form{display:grid;gap:12px;max-width:460px;margin:8px auto 0}.form input,.form textarea{padding:12px 14px;border:1px solid #d9dce3;border-radius:12px;font:inherit;font-size:15px}
.footer{border-top:1px solid #eceef2;padding:30px 0}.foot-in{display:flex;justify-content:space-between;align-items:center;gap:12px}.note{color:#888;font-size:14px}
@media(max-width:860px){.grid3,.grid4{grid-template-columns:1fr 1fr}.nav-links{display:none}}@media(max-width:560px){.grid3,.grid4{grid-template-columns:1fr}.foot-in{flex-direction:column}}`;
}

function buildHtml(blocks: Block[], t: Theme, title: string): string {
  const body = blocks.map((b) => DEF(b.type).render(b.fields, t)).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${styleSheet(t)}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

const ACCENTS = ["#4f46e5", "#0ea5e9", "#059669", "#db2777", "#ea580c", "#7c3aed"];
const widths: Record<"desktop" | "tablet" | "mobile", string> = { desktop: "100%", tablet: "768px", mobile: "390px" };
const iconBtn = "inline-flex h-8 w-8 items-center justify-center rounded-lg text-s-ink-3 transition hover:bg-s-hover hover:text-s-ink disabled:opacity-30 disabled:hover:bg-transparent";

export function BuilderPanel({ ws }: { ws: WorkspaceKey }) {
  const { user, integrations } = useApp();
  const { notify } = useStudio();
  const params = useSearchParams();
  const base = WORKSPACES[ws].base;
  const signedOut = integrations.supabase && !user;

  const [blocks, setBlocks] = useState<Block[]>(() =>
    ["navbar", "hero", "features", "cta", "footer"].map((type) => ({ id: crypto.randomUUID(), type: type as BlockType, fields: { ...DEF(type as BlockType).defaults } })),
  );
  const [theme, setTheme] = useState<Theme>({ accent: ACCENTS[0], font: "Sans" });
  const [title, setTitle] = useState("My website");
  const [selected, setSelected] = useState<string | null>(null);
  const [device, setDevice] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const itemId = params.get("item");
  const [loaded, setLoaded] = useState(!itemId);
  const dragFrom = useRef<number | null>(null);

  useEffect(() => {
    if (!itemId) return;
    let alive = true;
    fetch(`/api/workspaces/${ws}/items/${itemId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((j: { item: { title: string; data: { blocks?: Block[]; theme?: Theme } } }) => {
        if (!alive) return;
        setSavedId(itemId);
        setTitle(j.item.title);
        if (Array.isArray(j.item.data.blocks)) setBlocks(j.item.data.blocks);
        if (j.item.data.theme) setTheme(j.item.data.theme);
      })
      .catch(() => alive && setError("That saved layout couldn’t be loaded."))
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [itemId, ws]);

  const html = useMemo(() => buildHtml(blocks, theme, title), [blocks, theme, title]);

  const add = (type: BlockType) => {
    const b: Block = { id: crypto.randomUUID(), type, fields: { ...DEF(type).defaults } };
    setBlocks((bs) => [...bs, b]);
    setSelected(b.id);
  };
  const move = (i: number, dir: -1 | 1) =>
    setBlocks((bs) => {
      const j = i + dir;
      if (j < 0 || j >= bs.length) return bs;
      const next = bs.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const reorder = (from: number, to: number) =>
    setBlocks((bs) => {
      if (from === to) return bs;
      const next = bs.slice();
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      return next;
    });
  const remove = (id: string) => {
    setBlocks((bs) => bs.filter((b) => b.id !== id));
    setSelected((s) => (s === id ? null : s));
  };
  const setField = (id: string, key: string, val: string) => setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, fields: { ...b.fields, [key]: val } } : b)));

  const download = () => {
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "website"}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const save = async () => {
    const data = { blocks, theme };
    try {
      if (savedId) {
        await fetch(`/api/workspaces/${ws}/items/${savedId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, data }) });
        notify("Saved.");
      } else {
        const r = await fetch(`/api/workspaces/${ws}/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "builder", title, data }) });
        if (!r.ok) throw new Error();
        setSavedId(((await r.json()) as { item: { id: string } }).item.id);
        notify("Saved to projects.");
      }
    } catch {
      setError("Couldn’t save. Please try again.");
    }
  };

  const sel = blocks.find((b) => b.id === selected) ?? null;

  if (!loaded)
    return (
      <>
        <StudioHeader>
          <Back base={base} />
        </StudioHeader>
        <div className="flex flex-1 items-center justify-center text-s-ink-3">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      </>
    );

  return (
    <>
      <StudioHeader>
        <Back base={base} />
        <div className="ml-1 hidden min-w-0 flex-1 items-center gap-2 sm:flex">
          <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Page title" className="min-w-0 max-w-[220px] flex-1 rounded-lg bg-transparent px-1.5 py-1 text-[14px] font-medium text-s-ink outline-none hover:bg-s-hover focus:bg-s-hover" />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="hidden items-center gap-0.5 rounded-xl border border-s-line p-0.5 md:flex">
            {(["desktop", "tablet", "mobile"] as const).map((d) => {
              const Icon = d === "desktop" ? Monitor : d === "tablet" ? Tablet : Smartphone;
              return (
                <button key={d} type="button" onClick={() => setDevice(d)} aria-label={d} aria-pressed={device === d} className={cn("inline-flex h-8 w-8 items-center justify-center rounded-lg transition", device === d ? "bg-s-accent text-s-accent-ink" : "text-s-ink-3 hover:bg-s-hover hover:text-s-ink")}>
                  <Icon className="h-4 w-4" />
                </button>
              );
            })}
          </div>
          <button type="button" onClick={download} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-s-line-strong px-3 text-[13.5px] font-medium transition hover:bg-s-hover">
            <Download className="h-4 w-4" /> <span className="hidden sm:inline">HTML</span>
          </button>
          <button type="button" onClick={save} disabled={signedOut} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-s-accent px-3 text-[13.5px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-50">
            <Save className="h-4 w-4" /> <span className="hidden sm:inline">{savedId ? "Save" : "Save to projects"}</span>
          </button>
        </div>
      </StudioHeader>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_1fr]">
        {/* Left: blocks + editor */}
        <aside className="s-scroll min-h-0 overflow-y-auto border-b border-s-line p-4 lg:border-b-0 lg:border-r">
          {error && <p role="alert" className="mb-3 text-[13px] text-s-danger">{error}</p>}
          {signedOut && <p className="mb-3 text-[12.5px] text-s-ink-3"><Link href={`/login?next=${base}`} className="text-s-accent hover:underline">Sign in</Link> to save layouts.</p>}

          <div className="mb-4">
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-s-ink-3">Add a block</h2>
            <div className="grid grid-cols-2 gap-1.5">
              {DEFS.map((d) => (
                <button key={d.type} type="button" onClick={() => add(d.type)} className="inline-flex items-center gap-1.5 rounded-lg border border-s-line px-2.5 py-1.5 text-left text-[12.5px] font-medium transition hover:border-s-line-strong hover:bg-s-hover">
                  <Plus className="h-3.5 w-3.5 shrink-0 text-s-ink-3" /> <span className="truncate">{d.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mb-4">
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-s-ink-3">Theme</h2>
            <div className="flex flex-wrap items-center gap-1.5">
              {ACCENTS.map((c) => (
                <button key={c} type="button" onClick={() => setTheme((t) => ({ ...t, accent: c }))} aria-label={`Accent ${c}`} aria-pressed={theme.accent === c} className={cn("h-7 w-7 rounded-full ring-offset-2 ring-offset-s-bg transition", theme.accent === c && "ring-2 ring-s-ink")} style={{ background: c }} />
              ))}
              <select value={theme.font} onChange={(e) => setTheme((t) => ({ ...t, font: e.target.value }))} aria-label="Font" className="glass ml-1 h-8 rounded-lg px-2 text-[13px] text-s-ink outline-none">
                {Object.keys(FONTS).map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
          </div>

          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-s-ink-3">Page ({blocks.length})</h2>
          <ol className="space-y-1">
            {blocks.map((b, i) => (
              <li
                key={b.id}
                draggable
                onDragStart={() => (dragFrom.current = i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom.current !== null) reorder(dragFrom.current, i);
                  dragFrom.current = null;
                }}
                className={cn("flex items-center gap-1 rounded-lg border px-2 py-1.5 transition", selected === b.id ? "border-s-line-strong bg-s-hover" : "border-transparent hover:bg-s-hover")}
              >
                <button type="button" onClick={() => setSelected(selected === b.id ? null : b.id)} className="min-w-0 flex-1 cursor-grab truncate text-left text-[13px] font-medium active:cursor-grabbing">
                  {DEF(b.type).name}
                </button>
                <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className={iconBtn}><ChevronUp className="h-3.5 w-3.5" /></button>
                <button type="button" aria-label="Move down" disabled={i === blocks.length - 1} onClick={() => move(i, 1)} className={iconBtn}><ChevronDown className="h-3.5 w-3.5" /></button>
                <button type="button" aria-label="Remove block" onClick={() => remove(b.id)} className={cn(iconBtn, "hover:text-s-danger")}><Trash2 className="h-3.5 w-3.5" /></button>
              </li>
            ))}
            {!blocks.length && <li className="rounded-lg border border-dashed border-s-line px-3 py-6 text-center text-[12.5px] text-s-ink-3">Add a block to start.</li>}
          </ol>

          {sel && (
            <div className="mt-4 border-t border-s-line pt-4">
              <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-s-ink-3">Edit · {DEF(sel.type).name}</h2>
              <div className="space-y-2.5">
                {DEF(sel.type).fields.map((fld) => (
                  <label key={fld.key} className="block">
                    <span className="mb-1 block text-[12px] text-s-ink-2">{fld.label}</span>
                    {fld.area ? (
                      <textarea value={sel.fields[fld.key] ?? ""} onChange={(e) => setField(sel.id, fld.key, e.target.value)} rows={4} className="glass w-full rounded-lg p-2 text-[13px] text-s-ink outline-none focus:border-s-line-strong" />
                    ) : (
                      <input value={sel.fields[fld.key] ?? ""} onChange={(e) => setField(sel.id, fld.key, e.target.value)} className="glass h-9 w-full rounded-lg px-2 text-[13px] text-s-ink outline-none focus:border-s-line-strong" />
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* Right: live preview */}
        <div className="min-h-0 overflow-auto bg-s-panel-2 p-4">
          <div className="mx-auto h-full bg-white shadow-sm transition-all" style={{ maxWidth: widths[device], borderRadius: device === "desktop" ? 0 : 16, overflow: "hidden" }}>
            <iframe title="Website preview" srcDoc={html} className="h-full min-h-[60vh] w-full border-0" sandbox="allow-same-origin" />
          </div>
        </div>
      </div>
    </>
  );
}

function Back({ base }: { base: string }) {
  return (
    <Link href={`${base}/tools`} className="inline-flex h-9 items-center gap-1 rounded-xl pl-1.5 pr-2.5 text-[13.5px] text-s-ink-2 transition hover:bg-s-hover hover:text-s-ink">
      <ChevronLeft className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Tools</span>
    </Link>
  );
}
