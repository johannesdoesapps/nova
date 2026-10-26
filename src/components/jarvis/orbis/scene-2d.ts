import { LOWER, orbisConfig, type OrbisConfig, type QualityTier, type RGB } from "./config";
import { ParticleSystem } from "./particles";
import { OrbisAnimator, statePalettes, type ColorKey } from "./animator";
import type { VISUALS } from "./state";
import type { SceneOptions } from "./scene";

/**
 * OrbisScene2D: draws the ORBIS core with the ordinary 2D canvas, for browsers that don't give the page WebGL
 * (hardware acceleration turned off, a blocked GPU driver, some remote desktops and VMs). It shares the particle
 * system and the animation state with the WebGL scene, so the core moves, changes state and pulses the same way;
 * only the drawing differs: a hand-rolled perspective camera, links stroked in a few brightness groups, points
 * stamped from small pre-drawn glow images, and the floor grid drawn once per size and colour.
 *
 * Same public surface as OrbisScene, so OrbisCore can use either.
 */

const FOV = 36;
const BACKGROUND = "#05030b";
const HUE_STEPS = 8;
const WHITE_STEPS = 3;
const LINK_STEPS = 6;
const SPRITE = 32;

export interface Camera {
  /** Camera position (it looks at a point slightly below the centre). */
  y: number;
  z: number;
  /** Downward tilt, radians. */
  pitch: number;
  /** Focal length in device pixels. */
  focal: number;
  cx: number;
  cy: number;
}

/** The camera that frames the core like the WebGL scene: about 76% of the height, and always inside the width. */
export function frameCamera(width: number, height: number, radius: number): Camera {
  const tan = Math.tan(((FOV / 2) * Math.PI) / 180);
  const aspect = width / height;
  const diameter = radius * 2.25;
  const z = Math.max(diameter / (0.76 * 2 * tan), diameter / (0.92 * 2 * tan * aspect));
  const y = radius * 0.1;
  return { y, z, pitch: Math.atan2(y + radius * 0.14, z), focal: height / (2 * tan), cx: width / 2, cy: height / 2 };
}

/** Project a scene point to the canvas. Returns [x, y, distance in front of the camera]; distance ≤ 0 is behind it. */
export function project(cam: Camera, x: number, y: number, z: number, out: Float32Array | number[] = [0, 0, 0], o = 0) {
  const dy = y - cam.y;
  const dz = z - cam.z;
  const c = Math.cos(cam.pitch);
  const s = Math.sin(cam.pitch);
  const ry = dy * c - dz * s;
  const rz = dy * s + dz * c;
  const dist = -rz;
  const k = dist > 1e-3 ? cam.focal / dist : 0;
  out[o] = cam.cx + x * k;
  out[o + 1] = cam.cy - ry * k;
  out[o + 2] = dist;
  return out;
}

const css = (c: RGB, a = 1) => `rgba(${Math.round(Math.min(1, c[0]) * 255)},${Math.round(Math.min(1, c[1]) * 255)},${Math.round(Math.min(1, c[2]) * 255)},${a})`;
const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export class OrbisScene2D {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private cfg: OrbisConfig;
  private tier: QualityTier;
  private system: ParticleSystem;
  private readonly anim: OrbisAnimator;
  private readonly opts: SceneOptions;
  private cam: Camera = frameCamera(1, 1, 10);
  private screen = new Float32Array(0);
  private ratio = 1;
  private width = 1;
  private height = 1;
  /** Glow images: one per gradient step and whiteness step, redrawn when the state's colours move. */
  private sprites: HTMLCanvasElement[] = [];
  private spriteKey = "";
  private grid: HTMLCanvasElement | null = null;
  private gridKey = "";
  private readonly linkPaths: Path2D[] = [];
  private pointerNdc: { x: number; y: number } | null = null;
  private last = 0;
  private raf = 0;
  private running = false;
  private frames = 0;
  private slowFrames = 0;

  constructor(canvasEl: HTMLCanvasElement, opts: SceneOptions) {
    const ctx = canvasEl.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas isn't available");
    this.canvas = canvasEl;
    this.ctx = ctx;
    this.opts = opts;
    // The 2D canvas draws on the CPU here, so it never starts above the middle tier (and steps down if slow).
    this.tier = opts.tier === "high" ? "medium" : opts.tier;
    this.cfg = orbisConfig(this.tier, { pointer: opts.pointer && !opts.reducedMotion, maxPixelRatio: 1.25 });
    this.system = new ParticleSystem(this.cfg);
    this.anim = new OrbisAnimator(statePalettes(this.cfg), opts.reducedMotion);
  }

  get quality(): { tier: QualityTier; particles: number; links: number } {
    return { tier: this.tier, particles: this.system.active, links: this.system.linkCount };
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.ratio = Math.min(window.devicePixelRatio || 1, this.cfg.maxPixelRatio);
    this.canvas.width = Math.round(this.width * this.ratio);
    this.canvas.height = Math.round(this.height * this.ratio);
    this.cam = frameCamera(this.canvas.width, this.canvas.height, this.cfg.radius);
    this.gridKey = "";
    this.render();
  }

  setTarget(key: keyof typeof VISUALS) {
    this.anim.setTarget(key);
    if (this.opts.reducedMotion) this.render();
  }

  pulse(strength = 1) {
    this.anim.pulse(strength);
  }

  setPointer(ndc: { x: number; y: number } | null) {
    this.pointerNdc = this.cfg.pointer ? ndc : null;
  }

  setPointerEnabled(on: boolean) {
    this.cfg = { ...this.cfg, pointer: on && !this.opts.reducedMotion };
    if (!this.cfg.pointer) this.pointerNdc = null;
  }

  start() {
    if (this.running || this.opts.reducedMotion) {
      this.render();
      return;
    }
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt);
      this.adapt(dt);
      this.render();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  step(dt: number) {
    this.anim.advance(dt);
    let pointer: { x: number; y: number; z: number } | null = null;
    if (this.pointerNdc) {
      // Where the pointer's ray meets the plane z = 0 through the centre (the inverse of project()).
      const cam = this.cam;
      const vx = (this.pointerNdc.x * this.canvas.width) / 2 / cam.focal;
      const vy = (this.pointerNdc.y * this.canvas.height) / 2 / cam.focal;
      const c = Math.cos(cam.pitch);
      const s = Math.sin(cam.pitch);
      // Ray direction in the scene: the view direction (vx, vy, -1) turned back by the pitch.
      const dy = vy * c - s;
      const dz = -vy * s - c;
      const t = -cam.z / dz;
      if (t > 0) pointer = { x: vx * t, y: cam.y + dy * t, z: 0 };
    }
    const level = Math.min(1, Math.max(0, this.opts.audioLevel?.() ?? 0));
    this.system.update({ t: this.anim.time, dt, angle: this.anim.angle, visual: this.anim.visual, audio: level, pointer });
  }

  private color(which: ColorKey) {
    return this.anim.color(which);
  }

  /** Small glow images, one per gradient step × whiteness step, in the current state's colours. */
  private ensureSprites() {
    const a = this.color("a");
    const p = this.color("p");
    const b = this.color("b");
    const c = this.color("c");
    const key = [a, p, b, c].map((v) => v.map((x) => Math.round(x * 40)).join(",")).join("|");
    if (key === this.spriteKey) return;
    this.spriteKey = key;
    if (this.sprites.length === 0) for (let i = 0; i < HUE_STEPS * WHITE_STEPS; i++) this.sprites.push(canvas(SPRITE, SPRITE));
    for (let h = 0; h < HUE_STEPS; h++) {
      const t = h / (HUE_STEPS - 1);
      const base = t < 0.5 ? mixRgb(a, p, t * 2) : mixRgb(p, b, t * 2 - 1);
      for (let w = 0; w < WHITE_STEPS; w++) {
        const col = mixRgb(base, c, w / (WHITE_STEPS - 1) * 0.75);
        const sp = this.sprites[h * WHITE_STEPS + w]!;
        const g = sp.getContext("2d")!;
        g.clearRect(0, 0, SPRITE, SPRITE);
        // The WebGL point's profile: a tight core plus a softer halo.
        const grad = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
        for (const r of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
          const d2 = r * r;
          const glow = Math.min(1, Math.exp(-d2 * 26) + 0.38 * Math.exp(-d2 * 6)) * (r === 0.5 ? 0 : 1);
          grad.addColorStop(r * 2, css(col, glow));
        }
        g.fillStyle = grad;
        g.fillRect(0, 0, SPRITE, SPRITE);
      }
    }
  }

  /** The perspective floor, drawn once per size and colour (it doesn't move in this renderer). */
  private ensureGrid() {
    const col = this.color("g");
    const key = `${this.canvas.width}x${this.canvas.height}|${col.map((x) => Math.round(x * 30)).join(",")}`;
    if (key === this.gridKey && this.grid) return;
    this.gridKey = key;
    const W = this.canvas.width;
    const H = this.canvas.height;
    this.grid ??= canvas(W, H);
    this.grid.width = W;
    this.grid.height = H;
    const g = this.grid.getContext("2d")!;
    g.clearRect(0, 0, W, H);
    const R = this.cfg.radius;
    const cell = R * 0.24;
    const floor = -R * 1.42;
    const near = R * 2.6;
    const far = R * 9;
    const cam = this.cam;
    const fade = (x: number, z: number) => {
      const d = Math.hypot(x, z - cam.z);
      const t = Math.min(1, Math.max(0, (far - d) / (far - near)));
      return t * t * (3 - 2 * t);
    };
    const groups: Path2D[] = Array.from({ length: 6 }, () => new Path2D());
    const pa = [0, 0, 0];
    const pb = [0, 0, 0];
    const seg = (x0: number, z0: number, x1: number, z1: number) => {
      const f = fade((x0 + x1) / 2, (z0 + z1) / 2);
      if (f <= 0.02) return;
      project(cam, x0, floor, z0, pa);
      project(cam, x1, floor, z1, pb);
      if (pa[2]! <= 0.5 || pb[2]! <= 0.5) return;
      const path = groups[Math.min(5, Math.floor(f * 6))]!;
      path.moveTo(pa[0]!, pa[1]!);
      path.lineTo(pb[0]!, pb[1]!);
    };
    const n = Math.ceil(far / cell);
    const zMin = cam.z - far;
    const zMax = cam.z - 1;
    for (let i = -n; i <= n; i++) {
      const x = i * cell;
      for (let z = zMin; z < zMax; z += cell) seg(x, z, x, Math.min(zMax, z + cell));
    }
    for (let z = Math.ceil(zMin / cell) * cell; z < zMax; z += cell) for (let i = -n; i < n; i++) seg(i * cell, z, (i + 1) * cell, z);
    g.lineWidth = Math.max(1, this.ratio);
    groups.forEach((path, k) => {
      g.strokeStyle = css(col, ((k + 0.5) / 6) * 0.42);
      g.stroke(path);
    });
  }

  render() {
    const { ctx, cam } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const R = this.cfg.radius;
    const v = this.anim.visual;
    const sys = this.system;
    const n = sys.active;
    if (this.screen.length < sys.count * 3) this.screen = new Float32Array(sys.count * 3);
    const scr = this.screen;
    for (let i = 0; i < n; i++) project(cam, sys.positions[i * 3]!, sys.positions[i * 3 + 1]!, sys.positions[i * 3 + 2]!, scr, i * 3);

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";

    // Atmosphere and floor.
    const centre = project(cam, 0, 0, 0);
    const unit = cam.focal / centre[2]!;
    const glow = (rgb: RGB, radiusWorld: number, alpha: number) => {
      const r = radiusWorld * unit;
      const g = ctx.createRadialGradient(centre[0]!, centre[1]!, 0, centre[0]!, centre[1]!, r);
      g.addColorStop(0, css(rgb, alpha));
      g.addColorStop(0.25, css(rgb, alpha * 0.45));
      g.addColorStop(0.6, css(rgb, alpha * 0.08));
      g.addColorStop(1, css(rgb, 0));
      ctx.fillStyle = g;
      ctx.fillRect(centre[0]! - r, centre[1]! - r, r * 2, r * 2);
    };
    glow(this.color("l"), R * 3.2, 0.1 + 0.06 * v.glow);
    this.ensureGrid();
    if (this.grid) ctx.drawImage(this.grid, 0, 0);
    glow(this.color("p"), R * 1.7, 0.2 * v.glow);

    // Links, in a few brightness groups (one stroke each).
    const lc = this.color("l");
    const L = this.cfg.linkDistance * 1.12;
    for (let k = 0; k < LINK_STEPS; k++) this.linkPaths[k] = new Path2D();
    const pos = sys.positions;
    for (let k = 0; k < sys.linkCount; k++) {
      const i = sys.pairs[k * 2]!;
      const j = sys.pairs[k * 2 + 1]!;
      const d = Math.hypot(pos[j * 3]! - pos[i * 3]!, pos[j * 3 + 1]! - pos[i * 3 + 1]!, pos[j * 3 + 2]! - pos[i * 3 + 2]!);
      const fade = Math.max(0, 1 - d / L) ** 1.6 * v.links;
      const a = fade * (Math.max(0, 1.15 - sys.radial[i]!) + Math.max(0, 1.15 - sys.radial[j]!)) * 0.5;
      if (a < 0.02) continue;
      const path = this.linkPaths[Math.min(LINK_STEPS - 1, Math.floor(a * LINK_STEPS * 1.6))]!;
      path.moveTo(scr[i * 3]!, scr[i * 3 + 1]!);
      path.lineTo(scr[j * 3]!, scr[j * 3 + 1]!);
    }
    // Antialiased canvas lines spread their light thinner than the GPU's 1px lines, hence the stronger alpha.
    ctx.lineWidth = Math.max(1, this.ratio);
    for (let k = 0; k < LINK_STEPS; k++) {
      ctx.strokeStyle = css(lc, Math.min(1, ((k + 0.5) / LINK_STEPS) * 2.4));
      ctx.stroke(this.linkPaths[k]!);
    }

    // Points: stamped glow images, brighter toward the centre and the viewer, lit by flashes and waves.
    this.ensureSprites();
    const nearDist = cam.z - R;
    const pixel = cam.focal;
    for (let i = 0; i < n; i++) {
      const dist = scr[i * 3 + 2]!;
      if (dist <= 0.5) continue;
      const depth = Math.min(1, Math.max(0, (dist - nearDist) / (R * 2)));
      const radial = sys.radial[i]!;
      const pulse = this.anim.pulseAt(radial);
      const flash = sys.flash[i]!;
      const centreness = Math.min(1, Math.max(0, 1 - radial / 1.05));
      const c2 = centreness * centreness * (3 - 2 * centreness);
      let b = sys.bright[i]! * v.brightness * (0.75 + 0.85 * c2) + flash * 1.8 + pulse * 1.2;
      b *= 1.45 + (0.5 - 1.45) * depth;
      const white = Math.min(1, Math.max(0, c2 * 0.35 + (b - 1) * 0.45));
      const size = (0.1 * sys.size[i]! * pixel * (1 + flash * 0.9 + pulse * 0.6)) / dist;
      const sprite = this.sprites[Math.round(sys.hue[i]! * (HUE_STEPS - 1)) * WHITE_STEPS + Math.round(white * (WHITE_STEPS - 1))]!;
      // Stamped up to twice so very bright points can go past full colour, as additive blending does on the GPU.
      for (let rest = b, k = 0; rest > 0.03 && k < 2; rest -= 1, k++) {
        ctx.globalAlpha = Math.min(1, rest);
        ctx.drawImage(sprite, scr[i * 3]! - size / 2, scr[i * 3 + 1]! - size / 2, size, size);
      }
    }
    ctx.globalAlpha = 1;

    // The bright centre.
    const pulseGlow = this.anim.pulses.reduce((a, p) => a + p.s * 0.12, 0);
    glow(this.color("c"), R * 0.55, Math.min(1, 0.5 * v.glow + pulseGlow));
    ctx.globalCompositeOperation = "source-over";
  }

  /** Step down when frames run slow: fewer particles, then a lower tier, then fewer pixels. */
  private adapt(dt: number) {
    this.frames++;
    if (this.frames < 30) return;
    this.slowFrames = dt > 1 / 30 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 0.5);
    if (this.slowFrames < 45) return;
    this.slowFrames = 0;
    if (this.system.active > this.system.count * 0.55) {
      this.system.setActive(this.system.active * 0.75);
      return;
    }
    const lower = LOWER[this.tier];
    if (lower) {
      this.tier = lower;
      this.cfg = orbisConfig(lower, { pointer: this.cfg.pointer, maxPixelRatio: this.cfg.maxPixelRatio });
      this.system = new ParticleSystem(this.cfg);
    } else if (this.cfg.maxPixelRatio > 1) {
      this.cfg = { ...this.cfg, maxPixelRatio: 1 };
    } else return;
    this.resize(this.width, this.height);
  }

  dispose() {
    this.stop();
    this.sprites = [];
    this.grid = null;
  }
}
