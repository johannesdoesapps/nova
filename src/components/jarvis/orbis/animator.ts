import type { OrbisConfig, RGB } from "./config";
import { ease, VISUALS, type Visual } from "./state";

/**
 * OrbisAnimator: the animation state both renderers share (WebGL and the 2D fallback). It eases the look between
 * states, blends the colours of each state, rotates the core and runs the waves of light from the centre.
 */

export type ColorKey = "a" | "p" | "b" | "c" | "l" | "g";
/** Each state's colours: the gradient's three stops (a, p, b), the centre (c), the links (l) and the floor (g). */
export type StatePalette = Record<ColorKey, RGB>;

const scale = (v: RGB, k: number): RGB => [v[0] * k, v[1] * k, v[2] * k];

export function statePalettes(cfg: OrbisConfig): StatePalette[] {
  const pal = cfg.palette;
  const [violet, magenta, rose] = pal.gradient;
  return [
    { a: violet, p: magenta, b: rose, c: pal.core, l: pal.link, g: pal.grid },
    { a: [1, 0.3, 0.22], p: pal.error, b: [1, 0.58, 0.32], c: [1, 0.84, 0.74], l: [0.9, 0.32, 0.2], g: [0.75, 0.25, 0.18] },
    { a: [0.98, 0.62, 0.2], p: pal.warn, b: [1, 0.84, 0.45], c: [1, 0.95, 0.8], l: [0.85, 0.6, 0.22], g: [0.7, 0.5, 0.2] },
    { a: scale(violet, 0.45), p: scale(magenta, 0.4), b: scale(rose, 0.4), c: scale(pal.core, 0.45), l: scale(pal.link, 0.45), g: scale(pal.grid, 0.5) },
  ];
}

export class OrbisAnimator {
  visual: Visual = { ...VISUALS.idle };
  target: Visual = VISUALS.idle;
  /** Weight of each state's colours: 0 Orbis, 1 error, 2 warn, 3 dim. */
  hue = [1, 0, 0, 0];
  angle = 0;
  time = 0;
  pulses: { r: number; s: number }[] = [];
  private nextAutoPulse = 0;

  constructor(
    private readonly palettes: StatePalette[],
    private readonly reducedMotion: boolean,
  ) {}

  setTarget(key: keyof typeof VISUALS) {
    this.target = VISUALS[key];
    if (this.reducedMotion) {
      this.visual = { ...this.target };
      this.hue = this.hue.map((_, i) => (i === this.target.hue ? 1 : 0));
    }
  }

  pulse(strength = 1) {
    if (this.reducedMotion) return;
    if (this.pulses.length >= 3) this.pulses.shift();
    this.pulses.push({ r: 0, s: Math.min(1.2, strength) });
  }

  /** Advance by dt seconds. Returns the smoothing factor used this frame (for other eased values). */
  advance(dt: number): number {
    this.time += dt;
    this.visual = ease(this.visual, this.target, dt);
    const k = 1 - Math.exp(-dt * 2.4);
    this.hue = this.hue.map((h, i) => h + ((i === this.target.hue ? 1 : 0) - h) * k);
    this.angle += this.visual.rotation * dt;
    if (this.target.autoPulse > 0 && this.time >= this.nextAutoPulse) {
      this.pulse(0.7);
      this.nextAutoPulse = this.time + this.target.autoPulse;
    }
    for (const p of this.pulses) {
      p.r += dt * 0.85;
      p.s *= Math.exp(-dt * 0.9);
    }
    this.pulses = this.pulses.filter((p) => p.r < 1.5 && p.s > 0.02);
    return k;
  }

  /** The current colour for a role, blended across the states being eased between. */
  color(which: ColorKey): RGB {
    let r = 0;
    let g = 0;
    let b = 0;
    let sum = 0;
    this.hue.forEach((w, i) => {
      if (w <= 0.001) return;
      const c = this.palettes[i]![which];
      r += c[0] * w;
      g += c[1] * w;
      b += c[2] * w;
      sum += w;
    });
    sum ||= 1;
    return [r / sum, g / sum, b / sum];
  }

  /** How strongly the waves of light brighten a particle at this distance from the centre (0–1 radii). */
  pulseAt(radial: number): number {
    let v = 0;
    for (const p of this.pulses) {
      const d = radial - p.r;
      v += p.s * Math.exp(-d * d * 36);
    }
    return v;
  }
}
