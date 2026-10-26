"use client";

import { motion, useReducedMotion, useSpring } from "framer-motion";
import React, { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import confetti from "canvas-confetti";
import Link from "next/link";
import { Check, Star as LucideStar } from "lucide-react";
import NumberFlow from "@number-flow/react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
 * Pricing section (starfield, Monthly/Annual switch, plan cards), adapted from the shadcn-style component to Orbis:
 * colours use Orbis's own tokens (so it follows the site's dark/light switch, not only the OS setting), the
 * stars are placed after hydration (no server/client mismatch), motion and confetti respect reduced motion, the
 * switch is a radio group, and each card can carry its own call to action (e.g. a checkout button) instead of a link.
 */

// --- UTILITIES ---

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const result = matchMedia(query);
      result.addEventListener("change", onChange);
      return () => result.removeEventListener("change", onChange);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

// --- BASE UI COMPONENTS (BUTTON) ---

export const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-full text-sm font-medium ring-offset-bg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-fg hover:brightness-110",
        destructive: "bg-danger text-bg hover:brightness-110",
        outline: "border border-border-strong bg-transparent text-fg hover:bg-panel-2",
        secondary: "bg-panel-2 text-fg hover:bg-panel",
        ghost: "text-fg hover:bg-panel-2",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3",
        lg: "h-12 px-8 text-[15px]",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
});
Button.displayName = "Button";

// --- INTERACTIVE STARFIELD ---

type Pointer = { x: number | null; y: number | null };
type StarSeed = { top: number; left: number; size: number; duration: number; delay: number };

function Star({ seed, mousePosition, containerRef }: { seed: StarSeed; mousePosition: Pointer; containerRef: React.RefObject<HTMLDivElement | null> }) {
  const springConfig = { stiffness: 100, damping: 15, mass: 0.1 };
  const springX = useSpring(0, springConfig);
  const springY = useSpring(0, springConfig);

  useEffect(() => {
    if (!containerRef.current || mousePosition.x === null || mousePosition.y === null) {
      springX.set(0);
      springY.set(0);
      return;
    }

    const containerRect = containerRef.current.getBoundingClientRect();
    const starX = containerRect.left + (seed.left / 100) * containerRect.width;
    const starY = containerRect.top + (seed.top / 100) * containerRect.height;

    const deltaX = mousePosition.x - starX;
    const deltaY = mousePosition.y - starY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    const radius = 600; // Radius of magnetic influence

    if (distance < radius) {
      const force = 1 - distance / radius;
      springX.set(deltaX * force * 0.5);
      springY.set(deltaY * force * 0.5);
    } else {
      springX.set(0);
      springY.set(0);
    }
  }, [mousePosition, seed, containerRef, springX, springY]);

  return (
    <motion.div
      className="absolute rounded-full bg-fg"
      style={{ top: `${seed.top}%`, left: `${seed.left}%`, width: `${seed.size}px`, height: `${seed.size}px`, x: springX, y: springY }}
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 1, 0] }}
      transition={{ duration: seed.duration, repeat: Infinity, delay: seed.delay }}
    />
  );
}

function InteractiveStarfield({ mousePosition, containerRef, count = 150 }: { mousePosition: Pointer; containerRef: React.RefObject<HTMLDivElement | null>; count?: number }) {
  // Random positions are made in the browser after hydration, so the server and client render the same markup.
  const [seeds, setSeeds] = useState<StarSeed[]>([]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- placed once, after hydration, on purpose
    setSeeds(
      Array.from({ length: count }, () => ({
        top: Math.random() * 100,
        left: Math.random() * 100,
        size: 1 + Math.random() * 2,
        duration: 2 + Math.random() * 3,
        delay: Math.random() * 5,
      })),
    );
  }, [count]);

  return (
    <div className="pointer-events-none absolute inset-0 h-full w-full overflow-hidden" aria-hidden>
      {seeds.map((seed, i) => (
        <Star key={i} seed={seed} mousePosition={mousePosition} containerRef={containerRef} />
      ))}
    </div>
  );
}

// --- PRICING COMPONENT LOGIC ---

export interface PricingPlan {
  name: string;
  /** Price per month, billed monthly. */
  price: string | number;
  /** Price per month, billed annually. */
  yearlyPrice: string | number;
  period: string;
  features: string[];
  description: string;
  buttonText?: string;
  href?: string;
  /** Replaces the button: e.g. a checkout button that knows the chosen interval. */
  cta?: ReactNode | ((isMonthly: boolean) => ReactNode);
  /** Small line under the price; defaults to "Billed Monthly" / "Billed Annually". */
  billingNote?: string | ((isMonthly: boolean) => string);
  isPopular?: boolean;
  /** Pill on the popular card. @default "Most Popular" */
  badge?: string;
  /** Pill shown in the card's corner, e.g. "Your plan". */
  tag?: string;
  id?: string;
}

interface PricingSectionProps {
  plans: PricingPlan[];
  /** Pass null to leave the heading out (when the page has its own). */
  title?: string | null;
  description?: string | null;
  /** Shown on the Annual option, e.g. "Save 10%". Omit to hide. */
  annualSaving?: string | null;
  /** Controlled interval; omit to let the section keep its own. */
  isMonthly?: boolean;
  onIntervalChange?: (isMonthly: boolean) => void;
  /** Shown above the switch (e.g. a note for the store apps). */
  notice?: ReactNode;
  className?: string;
}

const PricingContext = createContext<{ isMonthly: boolean; setIsMonthly: (value: boolean) => void; annualSaving: string | null }>({
  isMonthly: true,
  setIsMonthly: () => {},
  annualSaving: null,
});

export function PricingSection({
  plans,
  title = "Simple, Transparent Pricing",
  description = "Choose the plan that's right for you. All plans include our core features and support.",
  annualSaving = "Save 20%",
  isMonthly: controlled,
  onIntervalChange,
  notice,
  className,
}: PricingSectionProps) {
  const [own, setOwn] = useState(true);
  const isMonthly = controlled ?? own;
  const setIsMonthly = (v: boolean) => {
    if (controlled === undefined) setOwn(v);
    onIntervalChange?.(v);
  };
  const containerRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [mousePosition, setMousePosition] = useState<Pointer>({ x: null, y: null });
  const frame = useRef(0);

  // One update per animation frame at most: every star reacts to the pointer.
  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const { clientX, clientY } = event;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setMousePosition({ x: clientX, y: clientY }));
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return (
    <PricingContext.Provider value={{ isMonthly, setIsMonthly, annualSaving }}>
      <div
        ref={containerRef}
        onMouseMove={reduce ? undefined : handleMouseMove}
        onMouseLeave={() => setMousePosition({ x: null, y: null })}
        className={cn("relative w-full py-20 sm:py-24", className)}
      >
        {!reduce && <InteractiveStarfield mousePosition={mousePosition} containerRef={containerRef} />}
        <div className="container relative z-10 mx-auto px-4 md:px-6">
          {(title || description) && (
            <div className="mx-auto mb-12 max-w-3xl space-y-4 text-center">
              {title && <h2 className="text-4xl font-bold tracking-tighter text-fg sm:text-5xl">{title}</h2>}
              {description && <p className="whitespace-pre-line text-lg text-muted">{description}</p>}
            </div>
          )}
          {notice}
          <PricingToggle />
          <div className="mt-12 grid grid-cols-1 items-start gap-8 lg:grid-cols-3">
            {plans.map((plan, index) => (
              <PricingCard key={plan.id ?? index} plan={plan} index={index} />
            ))}
          </div>
        </div>
      </div>
    </PricingContext.Provider>
  );
}

const CONFETTI = ["#a59cf0", "#e6e4ec", "#7dd3c0", "#f2c879"];

function PricingToggle() {
  const { isMonthly, setIsMonthly, annualSaving } = useContext(PricingContext);
  const monthlyBtnRef = useRef<HTMLButtonElement>(null);
  const annualBtnRef = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();
  const [pillStyle, setPillStyle] = useState({});

  useEffect(() => {
    const btnRef = isMonthly ? monthlyBtnRef : annualBtnRef;
    if (btnRef.current) {
      setPillStyle({ width: btnRef.current.offsetWidth, transform: `translateX(${btnRef.current.offsetLeft}px)` });
    }
  }, [isMonthly]);

  const handleToggle = (monthly: boolean) => {
    if (isMonthly === monthly) return;
    setIsMonthly(monthly);

    if (!monthly && !reduce) {
      const rect = annualBtnRef.current?.getBoundingClientRect();
      if (!rect) return;
      confetti({
        particleCount: 80,
        spread: 80,
        origin: { x: (rect.left + rect.width / 2) / window.innerWidth, y: (rect.top + rect.height / 2) / window.innerHeight },
        colors: CONFETTI,
        ticks: 300,
        gravity: 1.2,
        decay: 0.94,
        startVelocity: 30,
        disableForReducedMotion: true,
      });
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    handleToggle(!isMonthly);
    (isMonthly ? annualBtnRef : monthlyBtnRef).current?.focus();
  };

  const option = (monthly: boolean) =>
    cn(
      "relative z-10 rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:px-6",
      isMonthly === monthly ? "text-accent-fg" : "text-muted hover:text-fg",
    );

  return (
    <div className="flex justify-center">
      <div role="radiogroup" aria-label="Billing period" onKeyDown={onKey} className="relative flex w-fit items-center rounded-full border border-border bg-panel-2 p-1">
        <motion.div className="absolute left-0 top-0 h-full rounded-full bg-accent p-1" style={pillStyle} transition={{ type: "spring", stiffness: 500, damping: 40 }} />
        <button ref={monthlyBtnRef} type="button" role="radio" aria-checked={isMonthly} tabIndex={isMonthly ? 0 : -1} onClick={() => handleToggle(true)} className={option(true)}>
          Monthly
        </button>
        <button ref={annualBtnRef} type="button" role="radio" aria-checked={!isMonthly} tabIndex={isMonthly ? -1 : 0} onClick={() => handleToggle(false)} className={option(false)}>
          Annual
          {annualSaving && <span className={cn("hidden sm:inline", !isMonthly ? "text-accent-fg/80" : "")}> ({annualSaving})</span>}
        </button>
      </div>
    </div>
  );
}

function PricingCard({ plan, index }: { plan: PricingPlan; index: number }) {
  const { isMonthly } = useContext(PricingContext);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const reduce = useReducedMotion();
  const note = typeof plan.billingNote === "function" ? plan.billingNote(isMonthly) : (plan.billingNote ?? (isMonthly ? "Billed Monthly" : "Billed Annually"));
  const cta = typeof plan.cta === "function" ? plan.cta(isMonthly) : plan.cta;

  return (
    <motion.div
      id={plan.id}
      initial={reduce ? false : { y: 50, opacity: 0 }}
      whileInView={{ y: plan.isPopular && isDesktop ? -20 : 0, opacity: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 0.6, type: "spring", stiffness: 100, damping: 20, delay: index * 0.15 }}
      className={cn("relative flex scroll-mt-24 flex-col rounded-2xl bg-bg-elev/70 p-8 backdrop-blur-sm", plan.isPopular ? "border-2 border-accent shadow-xl" : "border border-border")}
    >
      {plan.isPopular && (
        <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2">
          <div className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-1.5">
            <LucideStar className="h-4 w-4 fill-current text-accent-fg" aria-hidden />
            <span className="text-sm font-semibold text-accent-fg">{plan.badge ?? "Most Popular"}</span>
          </div>
        </div>
      )}
      {plan.tag && <span className="absolute right-4 top-4 rounded-full bg-accent/15 px-2.5 py-0.5 text-[11.5px] font-medium text-accent">{plan.tag}</span>}
      <div className="flex flex-1 flex-col text-center">
        <h3 className="text-xl font-semibold text-fg">{plan.name}</h3>
        <p className="mt-2 text-sm text-muted">{plan.description}</p>
        <div className="mt-6 flex items-baseline justify-center gap-x-1">
          <span className="text-5xl font-bold tracking-tight text-fg">
            <NumberFlow
              value={isMonthly ? Number(plan.price) : Number(plan.yearlyPrice)}
              format={{ style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 }}
              className="tabular-nums"
            />
          </span>
          <span className="text-sm font-semibold leading-6 tracking-wide text-muted">/ {plan.period}</span>
        </div>
        <p className="mt-2 min-h-4 text-xs text-muted">{note}</p>

        <ul role="list" className="mt-8 space-y-3 text-left text-sm leading-6 text-muted">
          {plan.features.map((feature) => (
            <li key={feature} className="flex gap-x-3">
              <Check className="h-6 w-5 flex-none text-accent" aria-hidden="true" />
              {feature}
            </li>
          ))}
        </ul>

        <div className="mt-auto pt-8">
          {cta ??
            (plan.href && (
              <Link href={plan.href} className={cn(buttonVariants({ variant: plan.isPopular ? "default" : "outline", size: "lg" }), "w-full")}>
                {plan.buttonText}
              </Link>
            ))}
        </div>
      </div>
    </motion.div>
  );
}
