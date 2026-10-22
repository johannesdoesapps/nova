/**
 * Keeping a Code project and its GitHub repository in step, without losing
 * anyone's work. Each imported project remembers the git blob id of every
 * file as it was on GitHub ("base"). Comparing GitHub now, the project now and
 * that base tells who changed what:
 *
 * - only GitHub changed a file → take GitHub's version;
 * - only Orbis changed it → keep Orbis's;
 * - both changed it differently → keep Orbis's and report it (a conflict);
 * - a file GitHub deleted is deleted here only if Orbis didn't change it.
 *
 * "Push to GitHub" sends only what Orbis changed since the base, so a push
 * never undoes changes made on GitHub in the meantime.
 */

/** path → git blob id */
export type Shas = Record<string, string>;

export interface UpdatePlan {
  /** Files to download from GitHub: new there, or changed only there. */
  take: string[];
  /** Files GitHub deleted that Orbis hadn't changed. */
  remove: string[];
  /** Changed in both places (or deleted on one side, changed on the other): Orbis's version is kept. */
  conflicts: string[];
  /** Changed only in Orbis: kept. */
  keptLocal: number;
  /** The new base: GitHub's id for every file now in step; the old one where Orbis keeps its own version. */
  base: Shas;
}

export function planUpdate(input: { base: Shas | null; local: Shas; remote: Shas }): UpdatePlan {
  const base = input.base ?? {};
  const { local, remote } = input;
  const plan: UpdatePlan = { take: [], remove: [], conflicts: [], keptLocal: 0, base: {} };
  const paths = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  const keep = (p: string, sha: string | undefined) => {
    if (sha !== undefined) plan.base[p] = sha;
  };
  for (const p of [...paths].sort()) {
    const b = base[p],
      l = local[p],
      r = remote[p];
    if (r === undefined) {
      // Not on GitHub: gone on both sides, or a file made in Orbis → nothing to do.
      if (l === undefined || b === undefined) continue;
      if (l === b)
        plan.remove.push(p); // GitHub deleted it, Orbis didn't touch it
      else {
        plan.conflicts.push(p); // GitHub deleted it, Orbis changed it: keep Orbis's
        keep(p, b);
      }
    } else if (l === r) {
      keep(p, r); // already the same
    } else if (l === undefined && b !== undefined) {
      if (r !== b) plan.conflicts.push(p); // deleted in Orbis, changed on GitHub
      keep(p, b); // either way it stays deleted here
    } else if (l === undefined || l === b) {
      plan.take.push(p); // new on GitHub, or changed only there
      keep(p, r);
    } else if (r === b) {
      plan.keptLocal++; // changed only in Orbis
      keep(p, b);
    } else {
      plan.conflicts.push(p); // changed in both: keep Orbis's
      keep(p, b);
    }
  }
  return plan;
}

/** What "Push to GitHub" should send: files new or changed in Orbis since the base (all files when there is no base). */
export function changedSinceBase(base: Shas | null, local: Shas): string[] {
  if (!base) return Object.keys(local);
  return Object.keys(local).filter((p) => base[p] !== local[p]);
}

/** Files Orbis changed that GitHub has also changed since the base: pushing them would undo GitHub's change. */
export function pushConflicts(base: Shas | null, local: Shas, remote: Shas): string[] {
  if (!base) return [];
  return changedSinceBase(base, local).filter((p) => base[p] !== undefined && remote[p] !== base[p] && remote[p] !== local[p]);
}
