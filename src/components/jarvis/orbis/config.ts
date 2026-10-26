/**
 * OrbisConfig: the adjustable settings of the ORBIS core (particle counts, link distance, speeds, glow, palette)
 * and the quality tier chosen for this device.
 */

export interface OrbisConfig {
  /** Particles in the cloud. */
  particles: number;
  /** Sphere radius in scene units. */
  radius: number;
  /** Particles closer than this (scene units) may be linked. */
  linkDistance: number;
  /** Most links drawn from one particle, and in total. */
  maxLinksPerParticle: number;
  maxLinks: number;
  /** Recompute links every n frames (they still move with the particles every frame). */
  linkEveryFrames: number;
  /** Device pixel ratio cap. */
  maxPixelRatio: number;
  /** Nearby particles drift away from the pointer. */
  pointer: boolean;
  /** Orbis's brand gradient (violet → magenta → rose, as in the logo), spread across the particles. */
  palette: { gradient: [RGB, RGB, RGB]; core: RGB; link: RGB; grid: RGB; error: RGB; warn: RGB };
}

export type QualityTier = "high" | "medium" | "low";
export type RGB = [number, number, number];

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

const BASE: Omit<OrbisConfig, "particles" | "maxLinks" | "maxPixelRatio" | "linkEveryFrames"> = {
  radius: 10,
  linkDistance: 1.55,
  maxLinksPerParticle: 3,
  pointer: true,
  palette: {
    gradient: [hex("#7c3aed"), hex("#d946ef"), hex("#fb7185")],
    core: hex("#fbeaff"),
    link: hex("#a855f7"),
    grid: hex("#8b5cf6"),
    error: hex("#ff6a3d"),
    warn: hex("#fbbf24"),
  },
};

const TIERS: Record<QualityTier, Pick<OrbisConfig, "particles" | "maxLinks" | "maxPixelRatio" | "linkEveryFrames">> = {
  high: { particles: 3200, maxLinks: 5200, maxPixelRatio: 1.75, linkEveryFrames: 2 },
  medium: { particles: 2000, maxLinks: 3200, maxPixelRatio: 1.5, linkEveryFrames: 3 },
  low: { particles: 1100, maxLinks: 1600, maxPixelRatio: 1.25, linkEveryFrames: 4 },
};

export interface DeviceHints {
  cores?: number;
  memoryGb?: number;
  width: number;
  coarsePointer: boolean;
}

/** A tier from what the browser says about the device; the scene can still step down if frames run slow. */
export function qualityFor(d: DeviceHints): QualityTier {
  const cores = d.cores ?? 4;
  if (d.coarsePointer || d.width < 640 || cores <= 2 || (d.memoryGb !== undefined && d.memoryGb <= 2)) return "low";
  if (cores <= 4 || (d.memoryGb !== undefined && d.memoryGb <= 4) || d.width < 1100) return "medium";
  return "high";
}

export function orbisConfig(tier: QualityTier, overrides: Partial<OrbisConfig> = {}): OrbisConfig {
  return { ...BASE, ...TIERS[tier], ...overrides };
}

export const LOWER: Record<QualityTier, QualityTier | null> = { high: "medium", medium: "low", low: null };
