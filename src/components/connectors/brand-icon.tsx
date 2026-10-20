import { BRAND_PATHS } from "@/lib/connectors/brand-paths";
import { cn } from "@/lib/utils";

const SLUG: Record<string, string> = {
  google_drive: "googledrive",
  gmail: "gmail",
  google_calendar: "googlecalendar",
  notion: "notion",
  github: "github",
  figma: "figma",
  hubspot: "hubspot",
  wikipedia: "wikipedia",
};

/** Services without a mark in Simple Icons get a lettered tile in their brand colour. */
const TILES: Record<string, { letter: string; bg: string }> = {
  slack: { letter: "S", bg: "#4A154B" },
  onedrive: { letter: "O", bg: "#0364B8" },
  outlook: { letter: "O", bg: "#0F6CBD" },
};

export function BrandIcon({ id, size = 40, className }: { id: string; size?: number; className?: string }) {
  const slug = SLUG[id];
  const brand = slug ? BRAND_PATHS[slug] : null;
  // A white tile, like an app icon, so every mark keeps its own colours in light and dark themes.
  const box = cn("grid shrink-0 place-items-center rounded-xl border border-black/10 bg-white", className);
  if (brand) {
    return (
      <span className={box} style={{ width: size, height: size }} aria-hidden>
        <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} fill={brand.hex}>
          <path d={brand.path} />
        </svg>
      </span>
    );
  }
  const tile = TILES[id];
  return (
    <span className={cn("grid shrink-0 place-items-center rounded-xl font-semibold text-white", className)} style={{ width: size, height: size, background: tile?.bg ?? "#6b7280", fontSize: size * 0.42 }} aria-hidden>
      {tile?.letter ?? id.slice(0, 1).toUpperCase()}
    </span>
  );
}
