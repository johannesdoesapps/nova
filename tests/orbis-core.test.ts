/**
 * The ORBIS core's logic (no GPU): quality tiers, the particle cloud's shape, the grid neighbour search (checked
 * against a brute-force search), link limits and fading, smooth motion, easing between states, and the state
 * store (real activity vs labelled previews, pulses), and the 2D renderer's camera (used when WebGL isn't there).
 */
import { describe, expect, it } from "vitest";
import { orbisConfig, qualityFor } from "@/components/jarvis/orbis/config";
import { ParticleSystem } from "@/components/jarvis/orbis/particles";
import { frameCamera, project } from "@/components/jarvis/orbis/scene-2d";
import { OrbisAnimator, statePalettes } from "@/components/jarvis/orbis/animator";
import { effective, ease, lookFor, orbisStore, pulseOrbis, setOrbisMode, setOrbisState, VISUALS } from "@/components/jarvis/orbis/state";

const cfg = (over = {}) => orbisConfig("low", over);

describe("quality", () => {
  it("picks a tier from the device and keeps sensible counts", () => {
    expect(qualityFor({ cores: 12, memoryGb: 16, width: 1600, coarsePointer: false })).toBe("high");
    expect(qualityFor({ cores: 4, width: 1600, coarsePointer: false })).toBe("medium");
    expect(qualityFor({ cores: 8, width: 390, coarsePointer: true })).toBe("low");
    expect(orbisConfig("high").particles).toBeGreaterThan(orbisConfig("medium").particles);
    expect(orbisConfig("medium").particles).toBeGreaterThan(orbisConfig("low").particles);
  });
});

describe("particles", () => {
  it("fill a sphere, denser toward the centre, with an uneven edge", () => {
    const s = new ParticleSystem(cfg());
    const r = Array.from(s.radial);
    expect(Math.max(...r)).toBeLessThan(1.45);
    const inner = r.filter((x) => x < 0.5).length / r.length;
    // A uniform ball has 12.5% of its volume inside half the radius; the core is deliberately denser.
    expect(inner).toBeGreaterThan(0.25);
    const outer = r.filter((x) => x > 0.8).map((x) => Math.round(x * 20));
    expect(new Set(outer).size).toBeGreaterThan(3);
    expect(r.every(Number.isFinite)).toBe(true);
  });

  it("spread across Orbis's gradient, violet on one side and rose on the other", () => {
    const s = new ParticleSystem(cfg());
    const hue = Array.from(s.hue);
    expect(Math.min(...hue)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...hue)).toBeLessThanOrEqual(1);
    const side = (sign: number) => hue.filter((_, i) => Math.sign(s.base[i * 3]!) === sign && Math.abs(s.base[i * 3]!) > s.radius * 0.4);
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(avg(side(-1))).toBeLessThan(0.4);
    expect(avg(side(1))).toBeGreaterThan(0.6);
    expect(orbisConfig("high").palette.gradient).toEqual([
      [0x7c / 255, 0x3a / 255, 0xed / 255],
      [0xd9 / 255, 0x46 / 255, 0xef / 255],
      [0xfb / 255, 0x71 / 255, 0x85 / 255],
    ]);
  });

  it("finds exactly the links a brute-force search finds", () => {
    const c = cfg({ particles: 500, maxLinksPerParticle: 255, maxLinks: 100_000 });
    const s = new ParticleSystem(c, 3);
    const brute = new Set<string>();
    const p = s.positions;
    for (let i = 0; i < s.active; i++)
      for (let j = i + 1; j < s.active; j++) {
        const d = Math.hypot(p[i * 3]! - p[j * 3]!, p[i * 3 + 1]! - p[j * 3 + 1]!, p[i * 3 + 2]! - p[j * 3 + 2]!);
        if (d < c.linkDistance) brute.add(`${i}-${j}`);
      }
    const grid = new Set<string>();
    for (let k = 0; k < s.linkCount; k++) grid.add(`${s.pairs[k * 2]}-${s.pairs[k * 2 + 1]}`);
    expect(brute.size).toBeGreaterThan(100);
    expect(grid).toEqual(brute);
  });

  it("caps links per particle and in total, and fades them with distance", () => {
    const c = cfg();
    const s = new ParticleSystem(c);
    const per = new Map<number, number>();
    for (let k = 0; k < s.linkCount; k++) for (const i of [s.pairs[k * 2]!, s.pairs[k * 2 + 1]!]) per.set(i, (per.get(i) ?? 0) + 1);
    expect(Math.max(...per.values())).toBeLessThanOrEqual(c.maxLinksPerParticle);
    expect(s.linkCount).toBeLessThanOrEqual(c.maxLinks);
    expect(s.linkCount).toBeGreaterThan(c.particles / 2);
    const pos = new Float32Array(c.maxLinks * 6);
    const col = new Float32Array(c.maxLinks * 6);
    const n = s.writeLinks(pos, col, [0, 1, 0], 1);
    let short = 0;
    let long = 0;
    for (let k = 0; k < n; k++) {
      const d = Math.hypot(pos[k * 6 + 3]! - pos[k * 6]!, pos[k * 6 + 4]! - pos[k * 6 + 1]!, pos[k * 6 + 5]! - pos[k * 6 + 2]!);
      if (d < c.linkDistance * 0.3) short = Math.max(short, col[k * 6 + 1]!);
      if (d > c.linkDistance * 0.9) long = Math.max(long, col[k * 6 + 1]!);
    }
    expect(short).toBeGreaterThan(long);
  });

  it("move smoothly from frame to frame, stay finite, and keep their shape", () => {
    const s = new ParticleSystem(cfg());
    const frame = (t: number) => s.update({ t, dt: 1 / 60, angle: t * 0.05, visual: VISUALS.thinking, audio: 0.5, pointer: { x: 0, y: 0, z: 5 } });
    frame(10);
    const a = Float32Array.from(s.positions);
    frame(10 + 1 / 60);
    let maxStep = 0;
    for (let i = 0; i < a.length; i++) maxStep = Math.max(maxStep, Math.abs(s.positions[i]! - a[i]!));
    expect(maxStep).toBeLessThan(s.radius * 0.02);
    expect(Array.from(s.positions).every(Number.isFinite)).toBe(true);
    let far = 0;
    for (let i = 0; i < s.active; i++) far = Math.max(far, Math.hypot(s.positions[i * 3]!, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]!));
    expect(far).toBeLessThan(s.radius * 1.7);
  });

  it("flash at the configured rate and fade", () => {
    const s = new ParticleSystem(cfg());
    for (let k = 0; k < 60; k++) s.update({ t: k / 60, dt: 1 / 60, angle: 0, visual: { ...VISUALS.idle, flashRate: 30 }, audio: 0, pointer: null });
    const lit = Array.from(s.flash).filter((f) => f > 0.05).length;
    expect(lit).toBeGreaterThan(10);
    expect(lit).toBeLessThan(60);
  });

  it("can draw fewer particles when frames run slow", () => {
    const s = new ParticleSystem(cfg());
    s.setActive(500);
    expect(s.active).toBe(500);
    for (let k = 0; k < s.linkCount * 2; k++) expect(s.pairs[k]).toBeLessThan(500);
  });
});

describe("states", () => {
  it("eases between looks without jumps", () => {
    let v = { ...VISUALS.idle };
    const step = ease(v, VISUALS.thinking, 1 / 60);
    expect(step.rotation).toBeGreaterThan(v.rotation);
    expect(step.rotation - v.rotation).toBeLessThan((VISUALS.thinking.rotation - VISUALS.idle.rotation) * 0.06);
    for (let i = 0; i < 600; i++) v = ease(v, VISUALS.thinking, 1 / 60);
    expect(v.rotation).toBeCloseTo(VISUALS.thinking.rotation, 3);
  });

  it("maps every assistant activity to one of the five looks", () => {
    expect(lookFor("working")).toEqual({ state: "thinking", visual: "thinking" });
    expect(lookFor("approval")).toEqual({ state: "idle", visual: "approval" });
    expect(lookFor("stopped").visual).toBe("stopped");
    expect(VISUALS.error.hue).toBe(1);
  });

  it("follows the assistant in Auto, and marks other choices as previews", () => {
    let calls = 0;
    const off = orbisStore.subscribe(() => calls++);
    setOrbisMode("auto");
    setOrbisState("listening");
    expect(effective(orbisStore.get())).toEqual({ activity: "listening", preview: false });
    setOrbisMode("error");
    expect(effective(orbisStore.get())).toEqual({ activity: "error", preview: true });
    setOrbisState("thinking");
    expect(effective(orbisStore.get()).activity).toBe("error");
    setOrbisMode("auto");
    expect(effective(orbisStore.get())).toEqual({ activity: "thinking", preview: false });
    setOrbisState("thinking");
    expect(calls).toBe(4);
    off();
    const got: number[] = [];
    const offPulse = orbisStore.onPulse((s) => got.push(s));
    pulseOrbis(0.7);
    offPulse();
    pulseOrbis(1);
    expect(got).toEqual([0.7]);
  });
});

describe("2D renderer camera", () => {
  it("frames the whole core inside the canvas, a little above the middle", () => {
    for (const [w, h] of [[1320, 800], [390, 700], [1920, 600]] as const) {
      const cam = frameCamera(w, h, 10);
      const s = new ParticleSystem(cfg());
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      const out = [0, 0, 0];
      for (let i = 0; i < s.active; i++) {
        project(cam, s.positions[i * 3]!, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]!, out);
        expect(out[2]).toBeGreaterThan(0);
        minX = Math.min(minX, out[0]!); maxX = Math.max(maxX, out[0]!);
        minY = Math.min(minY, out[1]!); maxY = Math.max(maxY, out[1]!);
      }
      expect(minX).toBeGreaterThan(0);
      expect(maxX).toBeLessThan(w);
      expect(minY).toBeGreaterThan(0);
      expect(maxY).toBeLessThan(h);
      const c = project(cam, 0, 0, 0);
      expect(c[0]).toBeCloseTo(w / 2, 5);
      expect(c[1]).toBeLessThan(h / 2);
    }
  });

  it("draws nearer points larger, and the floor below the core", () => {
    const cam = frameCamera(1000, 800, 10);
    const near = project(cam, 0, 0, 8);
    const far = project(cam, 0, 0, -8);
    expect(near[2]).toBeLessThan(far[2]!);
    expect(project(cam, 0, -14.2, 0)[1]).toBeGreaterThan(project(cam, 0, -10, 0)[1]!);
  });
});

describe("animator", () => {
  it("blends to the error colours and back, and runs waves of light outward", () => {
    const a = new OrbisAnimator(statePalettes(cfg()), false);
    const violet = a.color("a");
    a.setTarget("error");
    for (let i = 0; i < 300; i++) a.advance(1 / 60);
    const red = a.color("a");
    expect(red[0]).toBeGreaterThan(red[2]);
    expect(violet[2]).toBeGreaterThan(violet[1]);
    a.pulse(1);
    a.advance(0.3);
    expect(a.pulseAt(a.pulses[0]!.r)).toBeGreaterThan(a.pulseAt(a.pulses[0]!.r + 0.5));
    const still = new OrbisAnimator(statePalettes(cfg()), true);
    still.setTarget("error");
    expect(still.hue).toEqual([0, 1, 0, 0]);
    still.pulse(1);
    expect(still.pulses).toHaveLength(0);
  });
});
