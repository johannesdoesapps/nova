/**
 * Just enough semver to compare npm ranges with installed versions: ^ ~ >= > <= < =, x-ranges, hyphen ranges,
 * partial versions and || alternatives, with npm's rule that a prerelease only satisfies a range that names a
 * prerelease of the same major.minor.patch. Anything that isn't a version range (git URLs, file:, tags such as
 * "latest") returns null: "can't tell", never a guess.
 */

export type Ver = { major: number; minor: number; patch: number; pre: string | null };

export function parseVersion(v: string): Ver | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(v);
  return m ? { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, pre: m[4] ?? null } : null;
}

export function compare(a: Ver, b: Ver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const pa = a.pre.split(".");
  const pb = b.pre.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]!) ? +pa[i]! : null;
    const nb = /^\d+$/.test(pb[i]!) ? +pb[i]! : null;
    if (na !== null && nb !== null && na !== nb) return na - nb;
    if (na !== null && nb === null) return -1;
    if (na === null && nb !== null) return 1;
    if (pa[i]! !== pb[i]!) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}

type Cmp = { op: "<" | "<=" | ">" | ">=" | "="; v: Ver };

/** "1", "1.2", "1.x", "*" → the parts given (x/* = undefined). */
function partial(s: string): { major?: number; minor?: number; patch?: number; pre: string | null } | null {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) return null;
  const n = (x?: string) => (x === undefined || /^[xX*]$/.test(x) ? undefined : +x);
  return { major: n(m[1]), minor: n(m[2]), patch: n(m[3]), pre: m[4] ?? null };
}

const v = (major: number, minor: number, patch: number, pre: string | null = null): Ver => ({ major, minor, patch, pre });

function comparators(part: string): Cmp[] | null {
  const out: Cmp[] = [];
  const hy = /^(\S+)\s+-\s+(\S+)$/.exec(part.trim());
  if (hy) {
    const a = partial(hy[1]!);
    const b = partial(hy[2]!);
    if (!a || !b) return null;
    out.push({ op: ">=", v: v(a.major ?? 0, a.minor ?? 0, a.patch ?? 0, a.pre) });
    if (b.major === undefined) return out;
    if (b.minor === undefined) out.push({ op: "<", v: v(b.major + 1, 0, 0, "0") });
    else if (b.patch === undefined) out.push({ op: "<", v: v(b.major, b.minor + 1, 0, "0") });
    else out.push({ op: "<=", v: v(b.major, b.minor, b.patch, b.pre) });
    return out;
  }
  for (const tok of part.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(\^|~>?|>=|<=|>|<|=)?\s*(.+)$/.exec(tok);
    if (!m) return null;
    const op = m[1] ?? "";
    const p = partial(m[2]!);
    if (!p) return null;
    const { major, minor, patch, pre } = p;
    if (major === undefined) {
      if (op === "<" || op === ">") out.push({ op: "<", v: v(0, 0, 0, "0") });
      continue; // "*" matches everything
    }
    if (op === "^") {
      const lo = v(major, minor ?? 0, patch ?? 0, pre);
      const hi = major > 0 || minor === undefined ? v(major + 1, 0, 0, "0") : minor > 0 || patch === undefined ? v(0, minor + 1, 0, "0") : v(0, 0, patch + 1, "0");
      out.push({ op: ">=", v: lo }, { op: "<", v: hi });
    } else if (op === "~" || op === "~>") {
      out.push({ op: ">=", v: v(major, minor ?? 0, patch ?? 0, pre) }, { op: "<", v: minor === undefined ? v(major + 1, 0, 0, "0") : v(major, minor + 1, 0, "0") });
    } else if (op === "" || op === "=") {
      if (minor === undefined) out.push({ op: ">=", v: v(major, 0, 0) }, { op: "<", v: v(major + 1, 0, 0, "0") });
      else if (patch === undefined) out.push({ op: ">=", v: v(major, minor, 0) }, { op: "<", v: v(major, minor + 1, 0, "0") });
      else out.push({ op: "=", v: v(major, minor, patch, pre) });
    } else if (op === ">") {
      out.push({
        op: minor === undefined ? ">=" : patch === undefined ? ">=" : ">",
        v: minor === undefined ? v(major + 1, 0, 0) : patch === undefined ? v(major, minor + 1, 0) : v(major, minor, patch, pre),
      });
    } else if (op === ">=") out.push({ op: ">=", v: v(major, minor ?? 0, patch ?? 0, pre) });
    else if (op === "<") out.push({ op: "<", v: v(major, minor ?? 0, patch ?? 0, pre ?? (minor === undefined || patch === undefined ? "0" : null)) });
    else if (op === "<=")
      out.push(minor === undefined ? { op: "<", v: v(major + 1, 0, 0, "0") } : patch === undefined ? { op: "<", v: v(major, minor + 1, 0, "0") } : { op: "<=", v: v(major, minor, patch, pre) });
  }
  return out;
}

const test = (c: Cmp, x: Ver) => {
  const r = compare(x, c.v);
  return c.op === "=" ? r === 0 : c.op === ">" ? r > 0 : c.op === ">=" ? r >= 0 : c.op === "<" ? r < 0 : r <= 0;
};

/** Is this a version range we can evaluate (not a URL, path, tag or alias we can't resolve)? */
export function isRange(range: string): boolean {
  return range.trim() === "" || range.split("||").every((p) => comparators(p) !== null);
}

/** Does `version` satisfy `range`? null when either can't be evaluated. */
export function satisfies(version: string, range: string): boolean | null {
  const x = parseVersion(version);
  if (!x) return null;
  const r = range.trim();
  if (r === "" || r === "*" || r === "x" || r === "X") return x.pre === null;
  const alts = r.split("||").map((p) => comparators(p));
  if (alts.some((a) => a === null)) return null;
  return alts.some((set) => {
    if (!set!.every((c) => test(c, x))) return false;
    if (x.pre === null) return true;
    // A prerelease only matches when a comparator names a prerelease of the same version.
    return set!.some((c) => c.v.pre !== null && c.v.pre !== "0" && c.v.major === x.major && c.v.minor === x.minor && c.v.patch === x.patch);
  });
}

/** Lowest major version a range allows, for messages ("expects React 18"). */
export function rangeMajors(range: string): string {
  const majors = new Set<number>();
  for (const p of range.split("||")) {
    const c = comparators(p);
    const lo = c?.find((x) => x.op === ">=" || x.op === "=");
    if (lo) majors.add(lo.v.major);
  }
  return [...majors].sort((a, b) => a - b).join(" or ");
}
