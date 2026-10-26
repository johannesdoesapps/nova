"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Globe, Paperclip, Plus } from "lucide-react";
import { Liquid } from "liquid-gooey";
import { GitHubLogo } from "@/components/common/github-logo";
import { cn } from "@/lib/utils";
import { useDocumentTheme } from "./voice-glow";

/** The goo's colour: a solid surface a step above the composer's glass in each theme. */
const FILL = { dark: "#34343c", light: "#e6e5ec" } as const;
const SHADOW = { dark: "0 2px 8px rgba(0,0,0,.35)", light: "0 2px 8px rgba(20,20,24,.10)" } as const;
const STEP = 42;

interface Option {
  key: string;
  label: string;
  /** Where the content goes, shown as the tooltip and read out with the button. */
  hint: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}

/**
 * The composer's "+": its options (upload files, add from GitHub, web search) melt out of it to the right as round
 * buttons (liquid-gooey) and melt back when it closes. Escape or a click elsewhere closes it.
 */
export function GooeyAttach({
  filesAllowed,
  onUpload,
  onGitHub,
  web,
}: {
  filesAllowed: boolean;
  onUpload: () => void;
  onGitHub: () => void;
  web: { on: boolean; enabled: boolean; hint: string; onToggle: (v: boolean) => void };
}) {
  const [open, setOpen] = useState(false);
  const theme = useDocumentTheme();
  const root = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const notForAgent = "Not enabled for this agent";
  const options: Option[] = [
    {
      key: "upload",
      label: "Upload files",
      hint: filesAllowed ? "Text, Markdown, CSV or JSON · up to 3 · sent with your message to the model" : notForAgent,
      icon: <Paperclip />,
      disabled: !filesAllowed,
      onClick: onUpload,
    },
    { key: "github", label: "Add from GitHub", hint: filesAllowed ? "Files from repositories you choose" : notForAgent, icon: <GitHubLogo className="h-4 w-4" />, disabled: !filesAllowed, onClick: onGitHub },
    { key: "web", label: web.on ? "Turn off web search" : "Search the web", hint: web.hint, icon: <Globe />, disabled: !web.enabled, pressed: web.on, onClick: () => web.onToggle(!web.on) },
  ];

  const round = "grid h-9 w-9 place-items-center rounded-full text-s-ink-2 transition hover:text-s-ink focus-visible:outline-2 focus-visible:outline-s-accent [&_svg]:h-4 [&_svg]:w-4";

  return (
    <div ref={root} className={cn("relative h-9 w-9 shrink-0", open && "z-10")}>
      {/* The goo's filter region follows its container, so the layer is as wide as the open cluster; it lets clicks
          through except on the buttons. Every item sits in the same grid cell: they share an origin and only their x
          offset moves them. */}
      <div className="pointer-events-none absolute left-0 top-0" style={{ width: 36 + STEP * 3 }}>
        <Liquid blur={6} contrast={18} fill={FILL[theme]} shadow={SHADOW[theme]} className="grid w-full items-start justify-items-start [&>div]:col-start-1 [&>div]:row-start-1 [&_button]:pointer-events-auto">
          {options.map((o, i) => (
            <Liquid.Item key={o.key} x={open ? STEP * (i + 1) : 0} y={0} transition="bouncy" delay={open ? i * 40 : (options.length - 1 - i) * 30}>
              <button
                type="button"
                id={`${id}-${o.key}`}
                title={o.hint}
                aria-label={o.label}
                aria-describedby={`${id}-${o.key}-hint`}
                aria-pressed={o.pressed}
                disabled={o.disabled}
                inert={!open}
                onClick={() => {
                  setOpen(false);
                  o.onClick();
                }}
                className={cn(round, "disabled:opacity-40", !open && "invisible", o.pressed && "text-s-accent")}
              >
                {o.icon}
                <span id={`${id}-${o.key}-hint`} className="sr-only">
                  {o.hint}
                </span>
              </button>
            </Liquid.Item>
          ))}
          <Liquid.Item x={0} y={0}>
            <button
              type="button"
              aria-label="Add files and tools"
              aria-expanded={open}
              aria-controls={options.map((o) => `${id}-${o.key}`).join(" ")}
              onClick={() => setOpen((v) => !v)}
              className={round}
            >
              <Plus className={cn("transition-transform duration-200", open && "rotate-45")} />
            </button>
          </Liquid.Item>
        </Liquid>
      </div>
    </div>
  );
}
