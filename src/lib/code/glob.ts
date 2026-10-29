/**
 * Glob patterns for project paths, used by the agent's glob tool and by permission rules
 * (edit(src/**), bash(npm test*)). `**` matches any number of folders, `*` anything within one
 * name (or, with `anyChar`, anything at all), `?` one character, `{a,b}` either. Matching is on
 * whole strings and case-sensitive, like paths.
 */

const cache = new Map<string, RegExp>();

/** The pattern as a regular expression. `anyChar`: `*` also crosses "/" (for command rules, which aren't paths). */
export function globToRegExp(pattern: string, anyChar = false): RegExp {
  const key = `${anyChar ? 1 : 0}:${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let re = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // "**/" matches zero or more folders; a trailing "**" matches everything below.
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += anyChar ? ".*" : "[^/]*";
    } else if (ch === "?") re += anyChar ? "." : "[^/]";
    else if (ch === "{") {
      braces++;
      re += "(?:";
    } else if (ch === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (ch === "," && braces > 0) re += "|";
    else re += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  re += ")".repeat(braces);
  const out = new RegExp(`^${re}$`);
  if (cache.size > 500) cache.clear();
  cache.set(key, out);
  return out;
}

export function globMatch(pattern: string, value: string, anyChar = false): boolean {
  return globToRegExp(pattern, anyChar).test(value);
}

/** Paths matching a pattern; a pattern without "/" also matches by file name anywhere ("*.ts"), like most tools. */
export function globPaths(paths: string[], pattern: string): string[] {
  const p = pattern.replace(/^\.\//, "");
  const re = globToRegExp(p);
  const byName = !p.includes("/");
  return paths.filter((path) => re.test(path) || (byName && re.test(path.split("/").pop()!)));
}
