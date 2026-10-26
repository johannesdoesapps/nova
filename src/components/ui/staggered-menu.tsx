"use client";
/**
 * StaggeredMenu from React Bits (reactbits.dev, JavaScript + CSS variant), ported to TypeScript for Orbis.
 * Coloured layers slide in one after another, then a panel whose links rise into place.
 *
 * Changes from the original:
 * - Only the toggle renders where you place it; the layers and panel go to `portalContainer` (default: the
 *   body), so they cover the page even from inside a header with backdrop-filter (which would otherwise trap a
 *   fixed element). Put them in the same stacking context as the page's own header and the header (z-index above
 *   30) stays on top with its logo and this toggle. The original's built-in header and logo are gone.
 * - Reopening while it's still closing works (the original could get stuck showing "Close" on a closed menu).
 * - Closed links can't be tabbed to (inert). Opening moves focus to the first link; Escape closes and returns it.
 *   Choosing a link closes the menu. The page behind doesn't scroll while it's open.
 * - prefers-reduced-motion: no sliding or spinning, the menu simply appears.
 * - Internal links use next/link; `footer` adds content (such as sign-in buttons) to the bottom of the panel.
 */
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { gsap } from "gsap";
import "./staggered-menu.css";

export type StaggeredMenuItem = { label: string; ariaLabel?: string; link: string };
export type StaggeredMenuSocialItem = { label: string; link: string };

type Props = {
  position?: "left" | "right";
  /** Colours of the layers that slide in before the panel (up to 4; with 3 or more the middle one is skipped, as in the original). */
  colors?: string[];
  items?: StaggeredMenuItem[];
  socialItems?: StaggeredMenuSocialItem[];
  displaySocials?: boolean;
  displayItemNumbering?: boolean;
  className?: string;
  toggleClassName?: string;
  /** Leave unset to use the surrounding text colour. */
  menuButtonColor?: string;
  openMenuButtonColor?: string;
  accentColor?: string;
  changeMenuColorOnOpen?: boolean;
  closeOnClickAway?: boolean;
  /** CSS selector of the element the layers and panel are rendered into. Default: the body. */
  portalContainer?: string;
  /** The current page's link, marked aria-current. */
  activeHref?: string;
  footer?: ReactNode;
  onMenuOpen?: () => void;
  onMenuClose?: () => void;
};

const subscribeNothing = () => () => {};
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function StaggeredMenu({
  position = "right",
  colors = ["#B497CF", "#5227FF"],
  items = [],
  socialItems = [],
  displaySocials = true,
  displayItemNumbering = true,
  className,
  toggleClassName,
  menuButtonColor,
  openMenuButtonColor,
  accentColor = "#5227FF",
  changeMenuColorOnOpen = true,
  closeOnClickAway = true,
  portalContainer,
  activeHref,
  footer,
  onMenuOpen,
  onMenuClose,
}: Props) {
  const isClient = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const panelRef = useRef<HTMLElement>(null);
  const preLayersRef = useRef<HTMLDivElement>(null);
  const preLayerElsRef = useRef<HTMLElement[]>([]);
  const plusHRef = useRef<HTMLSpanElement>(null);
  const plusVRef = useRef<HTMLSpanElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const textInnerRef = useRef<HTMLSpanElement>(null);
  const toggleBtnRef = useRef<HTMLButtonElement>(null);
  const [textLines, setTextLines] = useState(["Menu", "Close"]);

  const openTlRef = useRef<gsap.core.Timeline | null>(null);
  const closeTweenRef = useRef<gsap.core.Tween | null>(null);
  const spinTweenRef = useRef<gsap.core.Tween | null>(null);
  const textCycleAnimRef = useRef<gsap.core.Tween | null>(null);
  const colorTweenRef = useRef<gsap.core.Tween | null>(null);

  const offscreen = position === "left" ? -100 : 100;

  useLayoutEffect(() => {
    if (!isClient) return;
    const ctx = gsap.context(() => {
      const panel = panelRef.current;
      const preContainer = preLayersRef.current;
      const plusH = plusHRef.current;
      const plusV = plusVRef.current;
      const icon = iconRef.current;
      const textInner = textInnerRef.current;
      if (!panel || !plusH || !plusV || !icon || !textInner) return;

      const preLayers = preContainer ? Array.from(preContainer.querySelectorAll<HTMLElement>(".sm-prelayer")) : [];
      preLayerElsRef.current = preLayers;

      gsap.set([panel, ...preLayers], { xPercent: offscreen, opacity: 1 });
      if (preContainer) gsap.set(preContainer, { xPercent: 0, opacity: 1 });
      gsap.set(plusH, { transformOrigin: "50% 50%", rotate: 0 });
      gsap.set(plusV, { transformOrigin: "50% 50%", rotate: 90 });
      gsap.set(icon, { rotate: 0, transformOrigin: "50% 50%" });
      gsap.set(textInner, { yPercent: 0 });
    });
    return () => ctx.revert();
  }, [isClient, offscreen]);

  const hideContents = useCallback((panel: HTMLElement) => {
    const itemEls = panel.querySelectorAll(".sm-panel-itemLabel");
    const numberEls = panel.querySelectorAll(".sm-panel-list[data-numbering] .sm-panel-item");
    const socialTitle = panel.querySelector(".sm-socials-title");
    const socialLinks = panel.querySelectorAll(".sm-socials-link, .sm-footer");
    if (itemEls.length) gsap.set(itemEls, { yPercent: 140, rotate: 10 });
    if (numberEls.length) gsap.set(numberEls, { "--sm-num-opacity": 0 });
    if (socialTitle) gsap.set(socialTitle, { opacity: 0 });
    if (socialLinks.length) gsap.set(socialLinks, { y: 25, opacity: 0 });
  }, []);

  const playOpen = useCallback(() => {
    const panel = panelRef.current;
    const layers = preLayerElsRef.current;
    if (!panel) return;
    openTlRef.current?.kill();
    closeTweenRef.current?.kill();
    closeTweenRef.current = null;

    const itemEls = Array.from(panel.querySelectorAll(".sm-panel-itemLabel"));
    const numberEls = Array.from(panel.querySelectorAll(".sm-panel-list[data-numbering] .sm-panel-item"));
    const socialTitle = panel.querySelector(".sm-socials-title");
    const socialLinks = Array.from(panel.querySelectorAll(".sm-socials-link, .sm-footer"));
    hideContents(panel);

    const tl = gsap.timeline({ paused: true });
    // Start each layer from wherever it is, so reopening mid-close doesn't jump.
    layers.forEach((el, i) => {
      tl.fromTo(el, { xPercent: Number(gsap.getProperty(el, "xPercent")) }, { xPercent: 0, duration: 0.5, ease: "power4.out" }, i * 0.07);
    });
    const lastTime = layers.length ? (layers.length - 1) * 0.07 : 0;
    const panelInsertTime = lastTime + (layers.length ? 0.08 : 0);
    const panelDuration = 0.65;
    tl.fromTo(panel, { xPercent: Number(gsap.getProperty(panel, "xPercent")) }, { xPercent: 0, duration: panelDuration, ease: "power4.out" }, panelInsertTime);

    if (itemEls.length) {
      const itemsStart = panelInsertTime + panelDuration * 0.15;
      tl.to(itemEls, { yPercent: 0, rotate: 0, duration: 1, ease: "power4.out", stagger: { each: 0.1, from: "start" } }, itemsStart);
      if (numberEls.length) {
        tl.to(numberEls, { duration: 0.6, ease: "power2.out", "--sm-num-opacity": 1, stagger: { each: 0.08, from: "start" } }, itemsStart + 0.1);
      }
    }
    if (socialTitle || socialLinks.length) {
      const socialsStart = panelInsertTime + panelDuration * 0.4;
      if (socialTitle) tl.to(socialTitle, { opacity: 1, duration: 0.5, ease: "power2.out" }, socialsStart);
      if (socialLinks.length) {
        tl.to(
          socialLinks,
          { y: 0, opacity: 1, duration: 0.55, ease: "power3.out", stagger: { each: 0.08, from: "start" }, onComplete: () => void gsap.set(socialLinks, { clearProps: "opacity" }) },
          socialsStart + 0.04,
        );
      }
    }
    openTlRef.current = tl;
    if (reducedMotion()) tl.progress(1);
    else tl.play(0);
  }, [hideContents]);

  const playClose = useCallback(() => {
    openTlRef.current?.kill();
    openTlRef.current = null;
    const panel = panelRef.current;
    if (!panel) return;
    closeTweenRef.current?.kill();
    closeTweenRef.current = gsap.to([...preLayerElsRef.current, panel], {
      xPercent: offscreen,
      duration: reducedMotion() ? 0 : 0.32,
      ease: "power3.in",
      overwrite: "auto",
      onComplete: () => hideContents(panel),
    });
  }, [offscreen, hideContents]);

  const animateIcon = useCallback((opening: boolean) => {
    const icon = iconRef.current;
    if (!icon) return;
    spinTweenRef.current?.kill();
    const d = reducedMotion() ? 0 : 1;
    spinTweenRef.current = opening
      ? gsap.to(icon, { rotate: 225, duration: 0.8 * d, ease: "power4.out", overwrite: "auto" })
      : gsap.to(icon, { rotate: 0, duration: 0.35 * d, ease: "power3.inOut", overwrite: "auto" });
  }, []);

  const animateColor = useCallback(
    (opening: boolean) => {
      const btn = toggleBtnRef.current;
      if (!btn || !menuButtonColor) return;
      colorTweenRef.current?.kill();
      if (changeMenuColorOnOpen && openMenuButtonColor) {
        colorTweenRef.current = gsap.to(btn, { color: opening ? openMenuButtonColor : menuButtonColor, delay: 0.18, duration: 0.3, ease: "power2.out" });
      } else {
        gsap.set(btn, { color: menuButtonColor });
      }
    },
    [openMenuButtonColor, menuButtonColor, changeMenuColorOnOpen],
  );

  useEffect(() => {
    const btn = toggleBtnRef.current;
    if (!btn || !menuButtonColor) return;
    gsap.set(btn, { color: changeMenuColorOnOpen && openMenuButtonColor && openRef.current ? openMenuButtonColor : menuButtonColor });
  }, [changeMenuColorOnOpen, menuButtonColor, openMenuButtonColor]);

  const animateText = useCallback((opening: boolean) => {
    const inner = textInnerRef.current;
    if (!inner) return;
    textCycleAnimRef.current?.kill();
    const currentLabel = opening ? "Menu" : "Close";
    const targetLabel = opening ? "Close" : "Menu";
    const seq = [currentLabel];
    let last = currentLabel;
    for (let i = 0; i < 3; i++) {
      last = last === "Menu" ? "Close" : "Menu";
      seq.push(last);
    }
    if (last !== targetLabel) seq.push(targetLabel);
    seq.push(targetLabel);
    setTextLines(seq);
    gsap.set(inner, { yPercent: 0 });
    const finalShift = ((seq.length - 1) / seq.length) * 100;
    textCycleAnimRef.current = gsap.to(inner, { yPercent: -finalShift, duration: reducedMotion() ? 0 : 0.5 + seq.length * 0.07, ease: "power4.out" });
  }, []);

  const setMenu = useCallback(
    (target: boolean) => {
      if (openRef.current === target) return;
      openRef.current = target;
      setOpen(target);
      if (target) {
        onMenuOpen?.();
        playOpen();
      } else {
        onMenuClose?.();
        playClose();
      }
      animateIcon(target);
      animateColor(target);
      animateText(target);
    },
    [playOpen, playClose, animateIcon, animateColor, animateText, onMenuOpen, onMenuClose],
  );

  // While open: Escape closes (focus back on the toggle), clicks outside close, and the page doesn't scroll.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("a, button")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(false);
      toggleBtnRef.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || toggleBtnRef.current?.contains(t)) return;
      setMenu(false);
    };
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    if (closeOnClickAway) document.addEventListener("mousedown", onDown);
    return () => {
      root.style.overflow = overflow;
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, closeOnClickAway, setMenu]);

  // Stop any running animation on unmount.
  useEffect(
    () => () => {
      for (const r of [openTlRef, closeTweenRef, spinTweenRef, textCycleAnimRef, colorTweenRef]) r.current?.kill();
    },
    [],
  );

  const layerColors = (() => {
    const arr = colors.length ? colors.slice(0, 4) : ["#1e1e22", "#35353c"];
    if (arr.length >= 3) arr.splice(Math.floor(arr.length / 2), 1);
    return arr;
  })();

  const overlay = (
    <div className={`staggered-menu-wrapper fixed-wrapper${className ? ` ${className}` : ""}`} style={{ "--sm-accent": accentColor } as CSSProperties} data-position={position} data-open={open || undefined}>
      <div ref={preLayersRef} className="sm-prelayers" aria-hidden="true">
        {layerColors.map((c, i) => (
          <div key={i} className="sm-prelayer" style={{ background: c }} />
        ))}
      </div>
      <aside id="staggered-menu-panel" ref={panelRef} className="staggered-menu-panel" aria-label="Menu" aria-hidden={!open} inert={!open}>
        <div className="sm-panel-inner">
          <ul className="sm-panel-list" role="list" data-numbering={displayItemNumbering || undefined}>
            {items.length ? (
              items.map((it, idx) => (
                <li className="sm-panel-itemWrap" key={it.label + idx}>
                  <Link
                    className="sm-panel-item"
                    href={it.link}
                    aria-label={it.ariaLabel}
                    aria-current={activeHref === it.link ? "page" : undefined}
                    data-index={idx + 1}
                    onClick={() => setMenu(false)}
                  >
                    <span className="sm-panel-itemLabel">{it.label}</span>
                  </Link>
                </li>
              ))
            ) : (
              <li className="sm-panel-itemWrap" aria-hidden="true">
                <span className="sm-panel-item">
                  <span className="sm-panel-itemLabel">No items</span>
                </span>
              </li>
            )}
          </ul>
          {displaySocials && socialItems.length > 0 && (
            <div className="sm-socials" aria-label="Social links">
              <h3 className="sm-socials-title">Socials</h3>
              <ul className="sm-socials-list" role="list">
                {socialItems.map((s, i) => (
                  <li key={s.label + i} className="sm-socials-item">
                    <a href={s.link} target="_blank" rel="noopener noreferrer" className="sm-socials-link">
                      {s.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {footer && (
            <div className="sm-footer" onClick={(e) => (e.target as HTMLElement).closest("a") && setMenu(false)}>
              {footer}
            </div>
          )}
        </div>
      </aside>
    </div>
  );

  return (
    <>
      <button
        ref={toggleBtnRef}
        className={`sm-toggle${toggleClassName ? ` ${toggleClassName}` : ""}`}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls="staggered-menu-panel"
        onClick={() => setMenu(!openRef.current)}
        type="button"
      >
        <span className="sm-toggle-textWrap" aria-hidden="true">
          <span ref={textInnerRef} className="sm-toggle-textInner">
            {textLines.map((l, i) => (
              <span className="sm-toggle-line" key={i}>
                {l}
              </span>
            ))}
          </span>
        </span>
        <span ref={iconRef} className="sm-icon" aria-hidden="true">
          <span ref={plusHRef} className="sm-icon-line" />
          <span ref={plusVRef} className="sm-icon-line sm-icon-line-v" />
        </span>
      </button>
      {isClient && createPortal(overlay, (portalContainer && document.querySelector(portalContainer)) || document.body)}
    </>
  );
}

export default StaggeredMenu;
