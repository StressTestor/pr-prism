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
  /** "open" | "closed" | "merged"; absent for callers with no state (triage). */
  state?: string;
}

function createdMs(item: CanonicalCandidate): number {
  const t = item.createdAt ? Date.parse(item.createdAt) : Number.NaN;
  // Missing/unparseable date is never "earliest" — it must not win an issue cluster.
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** Top-two PR-score gap below which the canonical pick is treated as a coin flip. */
export const TIE_MARGIN = 0.05;
/** Issue reports filed within this window of each other are an ambiguous "original" (a near-tie). */
export const ISSUE_TIE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CanonicalDecision<T> {
  canonical: T;
  /** The rule-runner-up (2nd in the SAME total order selectCanonical uses), or null for a lone item. */
  runnerUp: T | null;
  /** True when canonical and runnerUp are a near-tie under the active mode's rule. */
  contested: boolean;
}

/**
 * Rank a PR by lifecycle state: a merged PR is already in main = the true source
 * of truth, so it outranks open, which outranks a closed-unmerged PR. Absent state
 * (a triage DupeMatch has none) is 0, below every real state, so a stateless set
 * all ties here and falls through to the score/date rules unchanged.
 */
function statePriority(state: string | undefined): number {
  switch (state) {
    case "merged":
      return 3;
    case "open":
      return 2;
    case "closed":
      return 1;
    default:
      return 0;
  }
}

function isNearTie<T extends CanonicalCandidate>(mode: "issue" | "pr", canonical: T, runnerUp: T): boolean {
  if (mode === "pr") {
    // A different lifecycle state decided the pick (e.g. merged over open) -> a
    // clear winner, not a coin flip. Only a same-state pair is a score near-tie.
    if (statePriority(canonical.state) !== statePriority(runnerUp.state)) return false;
    return canonical.score - runnerUp.score < TIE_MARGIN;
  }
  // The pick is on createdAt, so nearness is a time window (a huge score gap
  // between two issues filed minutes apart does NOT make the original clear).
  const a = createdMs(canonical);
  const b = createdMs(runnerUp);
  const aFinite = Number.isFinite(a);
  const bFinite = Number.isFinite(b);
  if (!aFinite && !bFinite) return true; // both undated -> resolved by score/number, a coin flip
  if (aFinite !== bFinite) return false; // exactly one dated -> that original is a clear winner
  return Math.abs(a - b) <= ISSUE_TIE_WINDOW_MS;
}

/**
 * Decide a cluster's canonical item, its rule-runner-up, and whether the two are
 * a near-tie (contested). The runner-up is the second element of the SAME total
 * order that picks the canonical, so contested reflects the actual selection - not
 * an independent score sort. Does not mutate the input; deterministic (ties bottom
 * out at item number).
 */
export function decideCanonical<T extends CanonicalCandidate>(
  items: readonly T[],
  opts?: { mode?: "issue" | "pr" },
): CanonicalDecision<T> {
  if (items.length === 0) {
    throw new Error("decideCanonical: empty candidate list");
  }

  const issueCount = items.filter((i) => i.type === "issue").length;
  const mode = opts?.mode ?? (issueCount > items.length / 2 ? "issue" : "pr");

  const compare = (a: T, b: T): number => {
    if (mode === "issue") {
      const d = createdMs(a) - createdMs(b); // earliest first
      if (d !== 0) return d;
      if (b.score !== a.score) return b.score - a.score;
    } else {
      // Prefer a merged PR (the real source of truth) over open over closed,
      // BEFORE score - a merged fix often does not have the top computed score.
      const sp = statePriority(b.state) - statePriority(a.state);
      if (sp !== 0) return sp;
      if (b.score !== a.score) return b.score - a.score; // then highest score first
      const d = createdMs(a) - createdMs(b);
      if (d !== 0) return d;
      const r = (b.reviewCount ?? 0) - (a.reviewCount ?? 0);
      if (r !== 0) return r;
    }
    return a.number - b.number; // stable, deterministic final tiebreak
  };

  const sorted = [...items].sort(compare);
  const canonical = sorted[0];
  const runnerUp = sorted.length >= 2 ? sorted[1] : null;
  return {
    canonical,
    runnerUp,
    contested: runnerUp ? isNearTie(mode, canonical, runnerUp) : false,
  };
}

/**
 * Pick the canonical item from a non-empty candidate list - the canonical-only
 * view of decideCanonical, so the two can never disagree on the pick.
 */
export function selectCanonical<T extends CanonicalCandidate>(
  items: readonly T[],
  opts?: { mode?: "issue" | "pr" },
): T {
  return decideCanonical(items, opts).canonical;
}
