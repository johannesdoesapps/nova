/**
 * Time-zone names: validates IANA identifiers and maps the places and
 * abbreviations people type ("New York", "Zurich", "EST") to IANA zones.
 * Abbreviations map to the region people usually mean; the conversion itself
 * always uses the IANA rules, so daylight saving time is applied correctly.
 */

export function validTimeZone(tz: string | null | undefined): string | null {
  if (!tz || tz.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Places (cities, and countries with a single zone) → IANA zone. Keys are lower case. */
const PLACES: Record<string, string> = {
  // Europe
  zurich: "Europe/Zurich", zürich: "Europe/Zurich", geneva: "Europe/Zurich", bern: "Europe/Zurich", basel: "Europe/Zurich", lausanne: "Europe/Zurich", lucerne: "Europe/Zurich", switzerland: "Europe/Zurich",
  london: "Europe/London", manchester: "Europe/London", edinburgh: "Europe/London", "united kingdom": "Europe/London", uk: "Europe/London", england: "Europe/London", scotland: "Europe/London",
  dublin: "Europe/Dublin", ireland: "Europe/Dublin", lisbon: "Europe/Lisbon", portugal: "Europe/Lisbon",
  paris: "Europe/Paris", france: "Europe/Paris", berlin: "Europe/Berlin", munich: "Europe/Berlin", hamburg: "Europe/Berlin", frankfurt: "Europe/Berlin", germany: "Europe/Berlin",
  vienna: "Europe/Vienna", austria: "Europe/Vienna", rome: "Europe/Rome", milan: "Europe/Rome", italy: "Europe/Rome", madrid: "Europe/Madrid", barcelona: "Europe/Madrid", spain: "Europe/Madrid",
  amsterdam: "Europe/Amsterdam", netherlands: "Europe/Amsterdam", brussels: "Europe/Brussels", belgium: "Europe/Brussels", copenhagen: "Europe/Copenhagen", denmark: "Europe/Copenhagen",
  stockholm: "Europe/Stockholm", sweden: "Europe/Stockholm", oslo: "Europe/Oslo", norway: "Europe/Oslo", helsinki: "Europe/Helsinki", finland: "Europe/Helsinki",
  warsaw: "Europe/Warsaw", poland: "Europe/Warsaw", prague: "Europe/Prague", budapest: "Europe/Budapest", athens: "Europe/Athens", greece: "Europe/Athens",
  istanbul: "Europe/Istanbul", turkey: "Europe/Istanbul", kyiv: "Europe/Kyiv", kiev: "Europe/Kyiv", ukraine: "Europe/Kyiv", moscow: "Europe/Moscow",
  // Americas
  "new york": "America/New_York", nyc: "America/New_York", boston: "America/New_York", washington: "America/New_York", "washington dc": "America/New_York", miami: "America/New_York", atlanta: "America/New_York", philadelphia: "America/New_York", toronto: "America/Toronto", montreal: "America/Toronto",
  chicago: "America/Chicago", dallas: "America/Chicago", houston: "America/Chicago", austin: "America/Chicago", "mexico city": "America/Mexico_City", mexico: "America/Mexico_City",
  denver: "America/Denver", phoenix: "America/Phoenix", "salt lake city": "America/Denver",
  "los angeles": "America/Los_Angeles", la: "America/Los_Angeles", "san francisco": "America/Los_Angeles", seattle: "America/Los_Angeles", "las vegas": "America/Los_Angeles", "san diego": "America/Los_Angeles", vancouver: "America/Vancouver", portland: "America/Los_Angeles",
  anchorage: "America/Anchorage", honolulu: "Pacific/Honolulu", hawaii: "Pacific/Honolulu",
  "sao paulo": "America/Sao_Paulo", "são paulo": "America/Sao_Paulo", "rio de janeiro": "America/Sao_Paulo", "buenos aires": "America/Argentina/Buenos_Aires", argentina: "America/Argentina/Buenos_Aires",
  santiago: "America/Santiago", lima: "America/Lima", bogota: "America/Bogota", "bogotá": "America/Bogota",
  // Asia, Africa, Oceania
  tokyo: "Asia/Tokyo", osaka: "Asia/Tokyo", japan: "Asia/Tokyo", seoul: "Asia/Seoul", korea: "Asia/Seoul", "south korea": "Asia/Seoul",
  beijing: "Asia/Shanghai", shanghai: "Asia/Shanghai", shenzhen: "Asia/Shanghai", china: "Asia/Shanghai", "hong kong": "Asia/Hong_Kong", taipei: "Asia/Taipei", taiwan: "Asia/Taipei",
  singapore: "Asia/Singapore", "kuala lumpur": "Asia/Kuala_Lumpur", bangkok: "Asia/Bangkok", thailand: "Asia/Bangkok", jakarta: "Asia/Jakarta", manila: "Asia/Manila", philippines: "Asia/Manila", "ho chi minh city": "Asia/Ho_Chi_Minh", hanoi: "Asia/Ho_Chi_Minh", vietnam: "Asia/Ho_Chi_Minh",
  mumbai: "Asia/Kolkata", delhi: "Asia/Kolkata", "new delhi": "Asia/Kolkata", bangalore: "Asia/Kolkata", bengaluru: "Asia/Kolkata", india: "Asia/Kolkata", karachi: "Asia/Karachi", pakistan: "Asia/Karachi", dhaka: "Asia/Dhaka",
  dubai: "Asia/Dubai", "abu dhabi": "Asia/Dubai", uae: "Asia/Dubai", riyadh: "Asia/Riyadh", "saudi arabia": "Asia/Riyadh", doha: "Asia/Qatar", qatar: "Asia/Qatar", tehran: "Asia/Tehran", iran: "Asia/Tehran",
  "tel aviv": "Asia/Jerusalem", jerusalem: "Asia/Jerusalem", israel: "Asia/Jerusalem",
  cairo: "Africa/Cairo", egypt: "Africa/Cairo", lagos: "Africa/Lagos", nigeria: "Africa/Lagos", nairobi: "Africa/Nairobi", kenya: "Africa/Nairobi", johannesburg: "Africa/Johannesburg", "cape town": "Africa/Johannesburg", "south africa": "Africa/Johannesburg",
  sydney: "Australia/Sydney", melbourne: "Australia/Melbourne", brisbane: "Australia/Brisbane", perth: "Australia/Perth", adelaide: "Australia/Adelaide", auckland: "Pacific/Auckland", wellington: "Pacific/Auckland", "new zealand": "Pacific/Auckland",
};

/** Common abbreviations → the zone usually meant (upper case keys, matched case-sensitively). */
const ABBREVIATIONS: Record<string, string> = {
  UTC: "UTC", GMT: "Etc/GMT",
  ET: "America/New_York", EST: "America/New_York", EDT: "America/New_York",
  CT: "America/Chicago", CST: "America/Chicago", CDT: "America/Chicago",
  MT: "America/Denver", MST: "America/Denver", MDT: "America/Denver",
  PT: "America/Los_Angeles", PST: "America/Los_Angeles", PDT: "America/Los_Angeles",
  BST: "Europe/London", CET: "Europe/Berlin", CEST: "Europe/Berlin", EET: "Europe/Athens", EEST: "Europe/Athens",
  JST: "Asia/Tokyo", KST: "Asia/Seoul", SGT: "Asia/Singapore", HKT: "Asia/Hong_Kong", IST: "Asia/Kolkata",
  AEST: "Australia/Sydney", AEDT: "Australia/Sydney", NZST: "Pacific/Auckland", NZDT: "Pacific/Auckland",
};

export interface ZoneMention {
  /** The text the user wrote, e.g. "New York" or "EST". */
  label: string;
  zone: string;
  /** Position in the message, for ordering "from … to …". */
  index: number;
}

const PLACE_RE = new RegExp(
  `(?<![\\p{L}])(${Object.keys(PLACES)
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![\\p{L}])`,
  "giu",
);
const ABBR_RE = new RegExp(`\\b(${Object.keys(ABBREVIATIONS).join("|")})\\b`, "g");
const IANA_RE = /\b(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/g;
// Short place keys that are also ordinary words are matched only when written as a name.
const NEEDS_CAPITAL = new Set(["la", "uk", "uae", "nyc"]);

/** Places, abbreviations and IANA names mentioned in a message, in order, without duplicates. */
export function findZones(text: string): ZoneMention[] {
  const found: ZoneMention[] = [];
  for (const m of text.matchAll(IANA_RE)) {
    const zone = validTimeZone(m[0]);
    if (zone) found.push({ label: m[0], zone, index: m.index! });
  }
  for (const m of text.matchAll(PLACE_RE)) {
    const key = m[1]!.toLowerCase();
    if (NEEDS_CAPITAL.has(key) && m[1] !== m[1]!.toUpperCase()) continue;
    if (found.some((f) => m.index! >= f.index && m.index! < f.index + f.label.length)) continue;
    found.push({ label: m[1]!, zone: PLACES[key]!, index: m.index! });
  }
  for (const m of text.matchAll(ABBR_RE)) found.push({ label: m[1]!, zone: ABBREVIATIONS[m[1]!]!, index: m.index! });
  found.sort((a, b) => a.index - b.index);
  return found.filter((f, i) => found.findIndex((g) => g.zone === f.zone && g.label.toLowerCase() === f.label.toLowerCase()) === i);
}
