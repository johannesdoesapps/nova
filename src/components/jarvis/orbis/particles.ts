import type { OrbisConfig } from "./config";
import type { Visual } from "./state";

/**
 * ParticleSystem: the ORBIS core's particles and links, as plain arrays (no rendering here).
 *
 * - Particles fill a sphere, denser toward the centre, with an uneven edge and small clusters, so it reads as a
 *   network rather than a ball.
 * - Each frame they drift on smooth, never-repeating sine sums, ride a slow wave outward from the centre,
 *   breathe, swell with audio, rotate, and step aside from the pointer.
 * - Links join particles closer than the link distance. Neighbours are found with a uniform grid (only the 27
 *   surrounding cells are checked, never every pair) every few frames; between searches the links follow their
 *   particles and fade as they separate, so connections appear and dissolve smoothly.
 */

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Frame {
  /** Seconds since start. */
  t: number;
  dt: number;
  /** Rotation so far (radians, about the vertical axis). */
  angle: number;
  visual: Visual;
  /** Microphone or speech level, 0–1. */
  audio: number;
  /** A point in scene space that particles step away from, or null. */
  pointer: { x: number; y: number; z: number } | null;
}

const TILT = 0.32;

export class ParticleSystem {
  readonly count: number;
  /** Particles drawn and linked (lowered when frames run slow). */
  active: number;
  readonly radius: number;
  readonly base: Float32Array;
  readonly phase: Float32Array;
  readonly size: Float32Array;
  readonly bright: Float32Array;
  readonly flash: Float32Array;
  /** Distance of each particle's resting place from the centre, 0–1 (used for light waves from the centre). */
  readonly radial: Float32Array;
  readonly positions: Float32Array;
  /** Linked pairs (indices) and how many there are. */
  readonly pairs: Int32Array;
  linkCount = 0;

  private readonly cfg: OrbisConfig;
  private readonly rand: () => number;
  private readonly perLink: Uint8Array;
  private readonly cellOf: Int32Array;
  private readonly order: Int32Array;
  private readonly grid: number;
  private readonly cellStart: Int32Array;
  private readonly cellCount: Int32Array;
  private readonly bound: number;
  private frame = 0;
  private flashDebt = 0;

  constructor(cfg: OrbisConfig, seed = 7) {
    this.cfg = cfg;
    this.count = this.active = cfg.particles;
    this.radius = cfg.radius;
    this.rand = mulberry32(seed);
    const n = cfg.particles;
    this.base = new Float32Array(n * 3);
    this.phase = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.bright = new Float32Array(n);
    this.flash = new Float32Array(n);
    this.radial = new Float32Array(n);
    this.positions = new Float32Array(n * 3);
    this.pairs = new Int32Array(cfg.maxLinks * 2);
    this.perLink = new Uint8Array(n);
    this.cellOf = new Int32Array(n);
    this.order = new Int32Array(n);
    this.bound = cfg.radius * 1.6;
    this.grid = Math.max(1, Math.ceil((this.bound * 2) / cfg.linkDistance));
    this.cellStart = new Int32Array(this.grid ** 3 + 1);
    this.cellCount = new Int32Array(this.grid ** 3);
    this.seed();
    this.positions.set(this.base);
    this.computeLinks();
  }

  private gauss() {
    const u = Math.max(1e-9, this.rand());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand());
  }

  private seed() {
    const R = this.radius;
    const seeds: [number, number, number][] = [];
    for (let s = 0; s < 46; s++) {
      const [x, y, z] = this.direction();
      const r = R * Math.pow(this.rand(), 0.5) * 0.92;
      seeds.push([x * r, y * r, z * r]);
    }
    for (let i = 0; i < this.count; i++) {
      let x: number, y: number, z: number;
      if (this.rand() < 0.24) {
        // A small cluster: knots of activity inside the network.
        const s = seeds[Math.floor(this.rand() * seeds.length)]!;
        const sigma = R * 0.075;
        [x, y, z] = [s[0] + this.gauss() * sigma, s[1] + this.gauss() * sigma, s[2] + this.gauss() * sigma];
      } else {
        const [dx, dy, dz] = this.direction();
        // Denser toward the centre (a uniform volume would be u^(1/3)), with an uneven outer edge.
        const edge = 1 + 0.13 * Math.sin(3.1 * dx + 1.7) * Math.sin(2.3 * dy + 0.4) * Math.sin(2.9 * dz + 2.2) + 0.06 * Math.sin(7 * dx + 5 * dz);
        const r = R * Math.pow(this.rand(), 0.62) * edge;
        [x, y, z] = [dx * r, dy * r, dz * r];
      }
      this.base.set([x, y, z], i * 3);
      this.phase.set([this.rand() * 6.283, this.rand() * 6.283, this.rand() * 6.283], i * 3);
      this.size[i] = 0.5 + Math.pow(this.rand(), 3.2) * 2.4;
      this.bright[i] = 0.32 + this.rand() * 0.68;
      this.radial[i] = Math.min(1.4, Math.hypot(x, y, z) / R);
    }
  }

  private direction(): [number, number, number] {
    const x = this.gauss();
    const y = this.gauss();
    const z = this.gauss();
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  }

  /** Move every particle for this frame, fade flashes and start new ones. */
  update(f: Frame) {
    const { t, dt, visual: v } = f;
    const R = this.radius;
    const scale = 1 + v.breathe * Math.sin(2 * Math.PI * v.breatheRate * t) + v.audio * f.audio;
    const ns = v.noiseSpeed;
    const amp = v.noise * R;
    const wave = v.wave * R;
    const wt = t * v.waveSpeed * Math.PI;
    const ca = Math.cos(f.angle);
    const sa = Math.sin(f.angle);
    const ct = Math.cos(TILT);
    const st = Math.sin(TILT);
    const p = f.pointer;
    const reach = R * 0.32;
    const decay = Math.exp(-dt * 2.6);
    for (let i = 0; i < this.active; i++) {
      const o = i * 3;
      const bx = this.base[o]!;
      const by = this.base[o + 1]!;
      const bz = this.base[o + 2]!;
      const px = this.phase[o]!;
      const py = this.phase[o + 1]!;
      const pz = this.phase[o + 2]!;
      // Smooth drift: two incommensurate sines per axis, so the motion never visibly repeats.
      let x = bx + amp * (Math.sin(t * ns * 1.31 + px + by * 0.31) + 0.5 * Math.sin(t * ns * 0.53 + pz * 1.7 + bz * 0.17));
      let y = by + amp * (Math.sin(t * ns * 1.07 + py + bz * 0.29) + 0.5 * Math.sin(t * ns * 0.61 + px * 1.3 + bx * 0.19));
      let z = bz + amp * (Math.sin(t * ns * 0.93 + pz + bx * 0.33) + 0.5 * Math.sin(t * ns * 0.47 + py * 1.9 + by * 0.21));
      // A slow wave travelling out from the centre.
      const r = this.radial[i]! * R;
      if (wave > 0 && r > 0.001) {
        const w = (wave * Math.sin(r * 0.55 - wt)) / r;
        x += bx * w;
        y += by * w;
        z += bz * w;
      }
      x *= scale;
      y *= scale;
      z *= scale;
      // Turn about the vertical axis, then tilt toward the viewer a little.
      const rx = x * ca + z * sa;
      const rz = -x * sa + z * ca;
      const ry = y * ct - rz * st;
      const fz = y * st + rz * ct;
      let X = rx;
      let Y = ry;
      let Z = fz;
      if (p) {
        const dx = X - p.x;
        const dy = Y - p.y;
        const dz = Z - p.z;
        const d = Math.hypot(dx, dy, dz);
        if (d < reach && d > 1e-4) {
          const push = ((1 - d / reach) ** 2 * R * 0.06) / d;
          X += dx * push;
          Y += dy * push;
          Z += dz * push;
        }
      }
      this.positions[o] = X;
      this.positions[o + 1] = Y;
      this.positions[o + 2] = Z;
      this.flash[i] = this.flash[i]! * decay;
    }
    // Occasional particles flash brighter than the rest.
    this.flashDebt += v.flashRate * dt;
    while (this.flashDebt >= 1) {
      this.flashDebt -= 1;
      this.flash[Math.floor(this.rand() * this.active)] = 1;
    }
    if (++this.frame % this.cfg.linkEveryFrames === 0) this.computeLinks();
  }

  private cell(x: number) {
    return Math.min(this.grid - 1, Math.max(0, Math.floor((x + this.bound) / this.cfg.linkDistance)));
  }

  /** Find links with the grid: count particles per cell, order them by cell, then check neighbouring cells only. */
  computeLinks() {
    const { linkDistance, maxLinksPerParticle, maxLinks } = this.cfg;
    const G = this.grid;
    const n = this.active;
    const pos = this.positions;
    this.cellCount.fill(0);
    for (let i = 0; i < n; i++) {
      const c = this.cell(pos[i * 3]!) + G * (this.cell(pos[i * 3 + 1]!) + G * this.cell(pos[i * 3 + 2]!));
      this.cellOf[i] = c;
      this.cellCount[c]!++;
    }
    let acc = 0;
    for (let c = 0; c < G ** 3; c++) {
      this.cellStart[c] = acc;
      acc += this.cellCount[c]!;
    }
    this.cellStart[G ** 3] = acc;
    const fill = this.cellCount;
    fill.fill(0);
    for (let i = 0; i < n; i++) {
      const c = this.cellOf[i]!;
      this.order[this.cellStart[c]! + fill[c]!++] = i;
    }
    this.perLink.fill(0);
    const L2 = linkDistance * linkDistance;
    let count = 0;
    outer: for (let i = 0; i < n; i++) {
      if (this.perLink[i]! >= maxLinksPerParticle) continue;
      const c = this.cellOf[i]!;
      const cx = c % G;
      const cy = Math.floor(c / G) % G;
      const cz = Math.floor(c / (G * G));
      const xi = pos[i * 3]!;
      const yi = pos[i * 3 + 1]!;
      const zi = pos[i * 3 + 2]!;
      for (let dz = -1; dz <= 1; dz++) {
        const z = cz + dz;
        if (z < 0 || z >= G) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const y = cy + dy;
          if (y < 0 || y >= G) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const x = cx + dx;
            if (x < 0 || x >= G) continue;
            const nc = x + G * (y + G * z);
            for (let k = this.cellStart[nc]!; k < this.cellStart[nc + 1]!; k++) {
              const j = this.order[k]!;
              if (j <= i || this.perLink[j]! >= maxLinksPerParticle) continue;
              const ddx = pos[j * 3]! - xi;
              const ddy = pos[j * 3 + 1]! - yi;
              const ddz = pos[j * 3 + 2]! - zi;
              if (ddx * ddx + ddy * ddy + ddz * ddz >= L2) continue;
              this.pairs[count * 2] = i;
              this.pairs[count * 2 + 1] = j;
              this.perLink[i]!++;
              this.perLink[j]!++;
              if (++count >= maxLinks) break outer;
              if (this.perLink[i]! >= maxLinksPerParticle) continue outer;
            }
          }
        }
      }
    }
    this.linkCount = count;
  }

  /**
   * Write the links for drawing: two points per link, with colours that fade as the pair separates (drawn with
   * additive blending, darker means more transparent). Returns the number of links written.
   */
  writeLinks(out: Float32Array, colors: Float32Array, rgb: readonly [number, number, number], opacity: number): number {
    const L = this.cfg.linkDistance * 1.12;
    const pos = this.positions;
    for (let k = 0; k < this.linkCount; k++) {
      const i = this.pairs[k * 2]!;
      const j = this.pairs[k * 2 + 1]!;
      const o = k * 6;
      out[o] = pos[i * 3]!;
      out[o + 1] = pos[i * 3 + 1]!;
      out[o + 2] = pos[i * 3 + 2]!;
      out[o + 3] = pos[j * 3]!;
      out[o + 4] = pos[j * 3 + 1]!;
      out[o + 5] = pos[j * 3 + 2]!;
      const d = Math.hypot(out[o + 3]! - out[o]!, out[o + 4]! - out[o + 1]!, out[o + 5]! - out[o + 2]!);
      const fade = Math.max(0, 1 - d / L) ** 1.6 * opacity;
      // Links near the centre glow a little more.
      const ci = Math.max(0, 1.15 - this.radial[i]!) * fade;
      const cj = Math.max(0, 1.15 - this.radial[j]!) * fade;
      colors[o] = rgb[0] * ci;
      colors[o + 1] = rgb[1] * ci;
      colors[o + 2] = rgb[2] * ci;
      colors[o + 3] = rgb[0] * cj;
      colors[o + 4] = rgb[1] * cj;
      colors[o + 5] = rgb[2] * cj;
    }
    return this.linkCount;
  }

  /** Draw fewer particles (when frames run slow). Links follow on the next search. */
  setActive(n: number) {
    this.active = Math.max(200, Math.min(this.count, Math.floor(n)));
    this.computeLinks();
  }
}
