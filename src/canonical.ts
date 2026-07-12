// Single source of truth for picking a cluster's canonical item (the "source of
// truth" / bestPick). Before this, three call sites chose it three different
// ways (cluster.ts by quality score only, cli.ts by an issue-aware rule, the
// triage bot by similarity), so the report, the starmap payload, and the live
// triage comment could each name a different canonical for the same cluster.
//
// Semantics (the cli.ts rule, now shared):
//   - issue-majority cluster  -> the earliest report is canonical (the original
//     bug), quality score then item number as tiebreaks.
//   - PR-majority cluster      -> the highest-quality item is canonical, then
//     earliest, then most-reviewed, then item number.
// `mode` lets a caller pin the rule instead of deriving it from the set — the
// triage bot passes the incoming item's type so its behavior is unchanged.

/** Minimal shape selectCanonical needs; ScoredPR and a mapped DupeMatch both satisfy it. */
export interface CanonicalCandidate {
  type: "pr" | "issue";
  /** ISO timestamp; may be absent (triage's DupeMatch) — absent sorts as never-earliest. */
  createdAt?: string;
  /** Quality score, or similarity when a caller has no quality score to offer. */
  score: number;
  reviewCount?: number;
  number: number;
}

function createdMs(item: CanonicalCandidate): number {
  const t = item.createdAt ? Date.parse(item.createdAt) : Number.NaN;
  // Missing/unparseable date is never "earliest" — it must not win an issue cluster.
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Pick the canonical item from a non-empty candidate list. Does not mutate the
 * input. Fully deterministic: every comparison bottoms out at item number.
 */
export function selectCanonical<T extends CanonicalCandidate>(
  items: readonly T[],
  opts?: { mode?: "issue" | "pr" },
): T {
  if (items.length === 0) {
    throw new Error("selectCanonical: empty candidate list");
  }

  const issueCount = items.filter((i) => i.type === "issue").length;
  const mode = opts?.mode ?? (issueCount > items.length / 2 ? "issue" : "pr");

  const compare = (a: T, b: T): number => {
    if (mode === "issue") {
      const d = createdMs(a) - createdMs(b); // earliest first
      if (d !== 0) return d;
      if (b.score !== a.score) return b.score - a.score;
    } else {
      if (b.score !== a.score) return b.score - a.score; // highest score first
      const d = createdMs(a) - createdMs(b);
      if (d !== 0) return d;
      const r = (b.reviewCount ?? 0) - (a.reviewCount ?? 0);
      if (r !== 0) return r;
    }
    return a.number - b.number; // stable, deterministic final tiebreak
  };

  return [...items].sort(compare)[0];
}
