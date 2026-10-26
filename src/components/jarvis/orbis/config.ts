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
  palette: { core: [number, number, number]; particle: [number, number, number]; link: [number, number, number]; error: [number, number, number]; warn: [number, number, number] };
}

export type QualityTier = "high" | "medium" | "low";

const BASE: Omit<OrbisConfig, "particles" | "maxLinks" | "maxPixelRatio" | "linkEveryFrames"> = {
  radius: 10,
  linkDistance: 1.55,
  maxLinksPerParticle: 3,
  pointer: true,
  palette: {
    core: [0.78, 1, 0.8],
    particle: [0.36, 1, 0.48],
    link: [0.22, 0.85, 0.36],
    error: [1, 0.36, 0.22],
    warn: [1, 0.74, 0.25],
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
