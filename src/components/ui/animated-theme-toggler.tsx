"use client";
import { useRef } from "react";
import { flushSync } from "react-dom";
import { Moon, Sun } from "lucide-react";
import { useDocumentTheme } from "@/hooks/use-document-theme";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { cn } from "@/lib/utils";

const DURATION = 700;

/**
 * Light/dark switch that reveals the new theme as a circle growing out of the button (View Transitions API).
 * Uses the same `data-theme` and saved `orbis:theme` choice as the studio's theme settings, so every theme
 * control stays in step. Browsers without view transitions, and people who prefer reduced motion, get the
 * usual quick colour fade instead.
 */
export function AnimatedThemeToggler({ className }: { className?: string }) {
  const theme = useDocumentTheme();
  // Saving through the shared hook re-renders everything that reads the choice, this button included.
  const [, setStored] = useLocalStorage("orbis:theme");
  const button = useRef<HTMLButtonElement>(null);
  const next = theme === "dark" ? "light" : "dark";

  const toggle = () => {
    const html = document.documentElement;
    const apply = () =>
      flushSync(() => {
        html.dataset.theme = next;
        setStored(next);
      });
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!document.startViewTransition || reduce || !button.current) {
      html.classList.add("theming");
      apply();
      window.setTimeout(() => html.classList.remove("theming"), 400);
      return;
    }
    const { top, left, width, height } = button.current.getBoundingClientRect();
    const x = left + width / 2;
    const y = top + height / 2;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    html.classList.add("theme-wipe");
    const transition = document.startViewTransition(apply);
    transition.ready
      .then(() => {
        html.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          { duration: DURATION, easing: "ease-in-out", pseudoElement: "::view-transition-new(root)" },
        );
      })
      .catch(() => {});
    transition.finished.finally(() => html.classList.remove("theme-wipe"));
  };

  return (
    <button
      ref={button}
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={cn(
        "inline-grid h-10 w-10 place-items-center rounded-lg text-muted transition-colors hover:bg-panel-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        className,
      )}
    >
      {theme === "dark" ? <Sun className="h-5 w-5" aria-hidden /> : <Moon className="h-5 w-5" aria-hidden />}
    </button>
  );
}
