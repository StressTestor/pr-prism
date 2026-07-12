// One chokepoint for every GitHub mutation. pr-prism is read-only by default;
// a write only happens when a caller explicitly opts in (--apply / PRISM_APPLY /
// config applyWrites). Before this, three ad-hoc gates disagreed - the CLI honored
// --apply-labels but ensureLabelsExist created labels even under --dry-run, and the
// server wrote unconditionally. Everything now funnels through one WriteGate.

export type WriteMode = "apply" | "dry-run";

export type WriteKind = "label" | "label-ensure" | "comment" | "close" | "create-issue";

export interface WriteIntent {
  kind: WriteKind;
  /** Human-readable target for the dry-run log/journal, e.g. "#5 +bug". */
  target: string;
}

export interface WriteGate {
  readonly mode: WriteMode;
  /** In dry-run, the intents that were skipped (for logging/assertions). */
  readonly journal: ReadonlyArray<WriteIntent>;
  guard<T>(op: WriteIntent & { run: () => Promise<T> }): Promise<{ applied: boolean; result: T | null }>;
}

function envOptsIn(): boolean {
  const apply = process.env.PRISM_APPLY;
  if (apply && apply !== "0" && apply.toLowerCase() !== "false") return true;
  return process.env.PRISM_WRITE === "apply";
}

/**
 * Resolve the effective write mode. Precedence (default dry-run): an explicit
 * dryRun beats everything, then an apply flag, then the PRISM_APPLY/PRISM_WRITE
 * env opt-in, else dry-run.
 */
export function resolveWriteMode(opts?: { apply?: boolean; dryRun?: boolean }): WriteMode {
  if (opts?.dryRun) return "dry-run";
  if (opts?.apply) return "apply";
  if (envOptsIn()) return "apply";
  return "dry-run";
}

export function createWriteGate(mode: WriteMode): WriteGate {
  const journal: WriteIntent[] = [];
  return {
    mode,
    journal,
    async guard(op) {
      if (mode === "dry-run") {
        journal.push({ kind: op.kind, target: op.target });
        return { applied: false, result: null };
      }
      const result = await op.run();
      return { applied: true, result };
    },
  };
}
