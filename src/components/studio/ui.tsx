"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/* Icon button ------------------------------------------------------------ */

export function IconButton({
  label,
  size = "md",
  active,
  className,
  children,
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "sm" | "md" | "lg"; active?: boolean; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-xl text-s-ink-2 transition duration-200 hover:bg-s-hover hover:text-s-ink active:scale-95 disabled:pointer-events-none disabled:opacity-40",
        size === "sm" && "h-8 w-8 rounded-lg [&_svg]:h-[15px] [&_svg]:w-[15px]",
        size === "md" && "h-9 w-9 [&_svg]:h-[18px] [&_svg]:w-[18px]",
        size === "lg" && "h-11 w-11 [&_svg]:h-5 [&_svg]:w-5",
        active && "bg-s-hover text-s-ink",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* Menu ------------------------------------------------------------------- */

export const iconButtonClass = (size: "sm" | "md" = "md") =>
  cn(
    "inline-grid shrink-0 place-items-center text-s-ink-2 transition duration-200 hover:bg-s-hover hover:text-s-ink active:scale-95 disabled:pointer-events-none disabled:opacity-40",
    size === "sm" ? "h-8 w-8 rounded-lg [&_svg]:h-[15px] [&_svg]:w-[15px]" : "h-9 w-9 rounded-xl [&_svg]:h-[18px] [&_svg]:w-[18px]",
  );

const ITEM_SELECTOR = '[role^="menuitem"]:not([disabled])';
const MenuCtx = createContext<() => void>(() => {});

/**
 * Floating glass menu with its own trigger button. Rendered in a portal inside
 * the studio root so scroll containers never clip it. Items close it on click.
 */
export function Menu({
  label,
  button,
  buttonLabel,
  buttonClassName,
  buttonTitle,
  disabled,
  children,
  align = "start",
  side = "bottom",
  width = 232,
}: {
  label: string;
  button: ReactNode;
  buttonLabel?: string;
  buttonClassName?: string;
  buttonTitle?: string;
  disabled?: boolean;
  children: ReactNode;
  align?: "start" | "end";
  side?: "top" | "bottom" | "auto";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const restoreFocus = useRef(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    restoreFocus.current = true;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  const toggle = () => {
    if (open) return setOpen(false);
    const r = triggerRef.current!.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - 16);
    const up = side === "top" || (side === "auto" && r.bottom > vh * 0.58);
    const left = Math.max(8, Math.min(align === "start" ? r.left : r.right - w, vw - w - 8));
    setStyle({
      position: "fixed",
      width: w,
      left,
      ...(up ? { bottom: vh - r.top + 6 } : { top: r.bottom + 6 }),
      maxHeight: up ? r.top - 16 : vh - r.bottom - 16,
      transformOrigin: `${align === "start" ? "left" : "right"} ${up ? "bottom" : "top"}`,
      ["--s-pop-y" as string]: up ? "4px" : "-4px",
    });
    setLayer(document.getElementById("studio-layer") ?? document.body);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus({ preventScroll: true });
    const dismiss = () => setOpen(false);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !triggerRef.current?.contains(t)) dismiss();
    };
    const onScroll = (e: Event) => {
      if (!panelRef.current?.contains(e.target as Node)) dismiss();
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={buttonLabel}
        title={buttonTitle ?? buttonLabel}
        className={buttonClassName}
      >
        {button}
      </button>
      {open &&
        layer &&
        createPortal(
          <MenuCtx value={close}>
            <div
              ref={panelRef}
              role="menu"
              aria-label={label}
              style={style}
              onKeyDown={onKeyDown}
              className="glass-strong glass-solid glass-edge s-pop s-scroll z-50 overflow-y-auto rounded-2xl p-1.5"
            >
              {children}
            </div>
          </MenuCtx>,
          layer,
        )}
    </>
  );
}

export function MenuItem({
  icon,
  children,
  hint,
  right,
  danger,
  role = "menuitem",
  checked,
  className,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  hint?: ReactNode;
  right?: ReactNode;
  danger?: boolean;
  role?: "menuitem" | "menuitemradio" | "menuitemcheckbox";
  checked?: boolean;
}) {
  const close = useContext(MenuCtx);
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === "menuitem" ? undefined : !!checked}
      onClick={(e) => {
        close();
        onClick?.(e);
      }}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left text-[13.5px] text-s-ink outline-none transition-colors hover:bg-s-hover focus-visible:bg-s-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent",
        danger && "text-s-danger",
        className,
      )}
      {...rest}
    >
      {icon && <span className={cn("mt-px shrink-0 [&_svg]:h-4 [&_svg]:w-4", danger ? "text-s-danger" : "text-s-ink-2")}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {hint && <span className="mt-0.5 block text-[12px] leading-snug text-s-ink-3">{hint}</span>}
      </span>
      {right && <span className="mt-px shrink-0 text-s-ink-3 [&_svg]:h-4 [&_svg]:w-4">{right}</span>}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-s-ink-3">{children}</div>;
}

export function MenuSeparator() {
  return <div role="separator" className="mx-2 my-1.5 h-px bg-s-line" />;
}

/* Dialog ----------------------------------------------------------------- */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="studio-dialog m-auto"
      aria-labelledby="studio-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="glass-strong glass-solid glass-edge s-scroll max-h-[86dvh] overflow-y-auto rounded-[24px] p-5 text-s-ink sm:p-6" style={{ width: `min(calc(100vw - 32px), ${width}px)` }}>
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 id="studio-dialog-title" className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
              {description && <p className="mt-1 text-[13.5px] text-s-ink-2">{description}</p>}
            </div>
            <IconButton label="Close" size="sm" onClick={onClose} className="-mr-1.5 -mt-1">
              <X />
            </IconButton>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

/* Form controls ---------------------------------------------------------- */

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border transition-colors duration-200 disabled:opacity-40",
        checked ? "border-transparent bg-s-accent" : "border-s-line-strong bg-s-hover",
      )}
    >
      <span
        className={cn(
          "absolute left-[2px] h-4 w-4 rounded-full shadow-sm transition-transform duration-200",
          checked ? "translate-x-4 bg-s-accent-ink" : "translate-x-0 bg-s-ink-3",
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: ReactNode }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-xl border border-s-line bg-s-hover p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[13px] transition-all duration-200 [&_svg]:h-3.5 [&_svg]:w-3.5",
            value === o.value ? "bg-s-glass-strong text-s-ink shadow-[var(--s-shadow-sm)]" : "text-s-ink-2 hover:text-s-ink",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-s-line-strong px-1 font-sans text-[11px] text-s-ink-3">{children}</kbd>
  );
}

export function OrbisMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="currentColor" />
      <circle cx="16" cy="16" r="7" fill="none" stroke="var(--s-bg)" strokeWidth="2.4" />
      <circle cx="20.95" cy="11.05" r="2.9" fill="var(--s-brand)" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
