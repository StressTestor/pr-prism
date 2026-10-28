import { createWriteGate, resolveWriteMode, type WriteGate, type WriteMode } from "../write-gate.js";

export type MaintainerActionKind =
  | "post_comment"
  | "request_changes" // formal GitHub PR review (REQUEST_CHANGES)
  | "submit_pr_review_comment" // formal GitHub PR review (COMMENT)
  | "close_item"
  | "apply_label";

export interface MaintainerActionTarget {
  repo: string;
  number: number;
  type: "pr" | "issue";
  currentState: "open" | "closed" | "merged";
  updatedAt: string; // for staleness check
}

export interface ActionPlan {
  kind: MaintainerActionKind;
  target: MaintainerActionTarget;
  proposedBody?: string; // comment/review body
  proposedLabels?: string[];
  draftSource: string; // which draft generator produced this
  previewText: string; // human-readable preview of the exact action
  requiresWrite: boolean; // always true for real writes
  checkpoints: ActionCheckpoint[]; // which 9 steps have been confirmed
}

export interface ActionCheckpoint {
  step: number; // 1–9
  description: string;
  verified: boolean;
  verifiedAt?: string; // ISO timestamp
}

export const ACTION_CHECKPOINTS: Record<number, string> = {
  1: "Owner has explicitly selected this item",
  2: "Exact GitHub target and action are displayed",
  3: "Final text/action has been previewed",
  4: "Fresh remote state has been verified",
  5: "Evidence is not stale",
  6: "Owner has explicitly approved this action",
  7: "Write-scoped authorization is confirmed",
  8: "Post-write readback will be performed",
  9: "Audit record will be appended",
};

export interface PreparedAction {
  plan: ActionPlan;
  gate: WriteGate;
  readyToExecute: boolean; // all 9 checkpoints verified
  blockers: string[]; // human-readable list of unmet checkpoints
}

/** Internal tracking key for requested write mode across checkpoint transitions */
const REQUESTED_MODE = Symbol("requestedMode");

interface InternalPreparedAction extends PreparedAction {
  [REQUESTED_MODE]?: WriteMode;
}

/**
 * Format human-readable preview text for an action plan.
 */
export function previewAction(plan: ActionPlan): string {
  const parts: string[] = [
    "=== MAINTAINER ACTION PREVIEW ===",
    `Action: ${plan.kind}`,
    `Target: ${plan.target.repo}#${plan.target.number} (${plan.target.type.toUpperCase()})`,
    `Current State: ${plan.target.currentState} (updatedAt: ${plan.target.updatedAt})`,
    `Draft Source: ${plan.draftSource}`,
    `Requires Write: ${plan.requiresWrite ? "YES" : "NO"}`,
  ];

  if (plan.proposedLabels && plan.proposedLabels.length > 0) {
    parts.push(`Labels to Apply: ${plan.proposedLabels.join(", ")}`);
  }

  if (plan.proposedBody !== undefined && plan.proposedBody !== "") {
    parts.push(`Proposed Body:\n${plan.proposedBody}`);
  }

  if (plan.checkpoints && plan.checkpoints.length > 0) {
    const verifiedCount = plan.checkpoints.filter((c) => c.verified).length;
    parts.push(`Checkpoints: ${verifiedCount}/${plan.checkpoints.length} verified`);
  }

  return parts.join("\n");
}

/**
 * Validate that remote item has not changed since the action plan was formulated.
 */
export function validateNotStale(plan: ActionPlan, currentUpdatedAt: string): { valid: boolean; reason?: string } {
  if (!currentUpdatedAt) {
    return {
      valid: false,
      reason: "Current remote updatedAt timestamp is empty or missing",
    };
  }
  if (!plan.target.updatedAt) {
    return {
      valid: false,
      reason: "Plan target updatedAt timestamp is empty or missing",
    };
  }
  if (plan.target.updatedAt === currentUpdatedAt) {
    return { valid: true };
  }

  const planTime = new Date(plan.target.updatedAt).getTime();
  const currentTime = new Date(currentUpdatedAt).getTime();
  if (!Number.isNaN(planTime) && !Number.isNaN(currentTime) && planTime === currentTime) {
    return { valid: true };
  }

  return {
    valid: false,
    reason: `Target state has changed: plan recorded updatedAt "${plan.target.updatedAt}", but remote state is "${currentUpdatedAt}".`,
  };
}

/**
 * Check whether a prepared action is completely ready to execute (all 9 checkpoints verified).
 */
export function isReadyToExecute(prepared: PreparedAction): boolean {
  if (!prepared.readyToExecute) return false;
  if (!prepared.plan.checkpoints || prepared.plan.checkpoints.length !== 9) return false;
  return prepared.plan.checkpoints.every((c) => c.verified);
}

/**
 * Prepare a maintainer action plan.
 *
 * Invariants:
 * - Default: dry-run always (gate is dry-run unless all 9 checkpoints are verified).
 * - Bulk operations are never supported (one item only).
 * - Never approve/merge PRs (only COMMENT and REQUEST_CHANGES allowed).
 */
export function prepareAction(
  plan: Omit<ActionPlan, "checkpoints" | "previewText"> & {
    checkpoints?: ActionCheckpoint[];
    previewText?: string;
  },
  opts?: { mode?: WriteMode },
): PreparedAction {
  // Validate single item invariant (bulk operations are never supported)
  if (!plan.target || typeof plan.target.number !== "number" || plan.target.number <= 0) {
    throw new Error("Bulk operations are not supported: target must specify a single valid item number");
  }
  if (!plan.target.repo || typeof plan.target.repo !== "string" || !plan.target.repo.trim()) {
    throw new Error("Target repo must be specified");
  }

  // Validate action kind invariants: never approve or merge PRs
  const forbiddenKinds = ["approve", "merge", "bulk", "batch"];
  if (forbiddenKinds.includes((plan.kind as string).toLowerCase())) {
    throw new Error(
      `Action kind '${plan.kind}' is strictly prohibited. Only COMMENT, REQUEST_CHANGES, CLOSE, and APPLY_LABEL are permitted.`,
    );
  }

  if ((plan.kind === "request_changes" || plan.kind === "submit_pr_review_comment") && plan.target.type !== "pr") {
    throw new Error(`Action kind '${plan.kind}' can only be performed on PR targets`);
  }

  // Initialize checkpoints 1 to 9 if not provided
  const checkpoints: ActionCheckpoint[] = [];
  for (let step = 1; step <= 9; step++) {
    const existing = plan.checkpoints?.find((c) => c.step === step);
    if (existing) {
      checkpoints.push({ ...existing });
    } else {
      checkpoints.push({
        step,
        description: ACTION_CHECKPOINTS[step],
        verified: false,
      });
    }
  }

  const allVerified = checkpoints.length === 9 && checkpoints.every((c) => c.verified);
  const unmetCheckpoints = checkpoints.filter((c) => !c.verified);
  const blockers = unmetCheckpoints.map((c) => `Step ${c.step}: ${c.description}`);

  // Determine requested mode; defaults to dry-run
  const requestedMode = opts?.mode ?? resolveWriteMode();

  // Invariant: prepareAction ALWAYS creates gate in dry-run unless all 9 checkpoints are verified
  const effectiveMode: WriteMode = allVerified && requestedMode === "apply" && plan.requiresWrite ? "apply" : "dry-run";
  const gate = createWriteGate(effectiveMode);

  const fullPlan: ActionPlan = {
    ...plan,
    checkpoints,
    previewText: "",
  };
  fullPlan.previewText = plan.previewText || previewAction(fullPlan);

  const prepared: InternalPreparedAction = {
    plan: fullPlan,
    gate,
    readyToExecute: allVerified,
    blockers,
    [REQUESTED_MODE]: requestedMode,
  };

  return prepared;
}

/**
 * Verify a checkpoint step (1–9). Returns a new PreparedAction with that checkpoint verified.
 */
export function verifyCheckpoint(prepared: PreparedAction, step: number): PreparedAction {
  if (step < 1 || step > 9) {
    throw new Error(`Invalid checkpoint step ${step}: must be between 1 and 9`);
  }

  const newCheckpoints = prepared.plan.checkpoints.map((c) => {
    if (c.step === step) {
      return {
        ...c,
        verified: true,
        verifiedAt: c.verifiedAt ?? new Date().toISOString(),
      };
    }
    return { ...c };
  });

  const allVerified = newCheckpoints.length === 9 && newCheckpoints.every((c) => c.verified);
  const blockers = newCheckpoints.filter((c) => !c.verified).map((c) => `Step ${c.step}: ${c.description}`);

  const internal = prepared as InternalPreparedAction;
  const requestedMode: WriteMode = internal[REQUESTED_MODE] ?? (prepared.plan.requiresWrite ? "apply" : "dry-run");

  // Invariant: gate is dry-run unless all 9 checkpoints are verified
  const effectiveMode: WriteMode =
    allVerified && requestedMode === "apply" && prepared.plan.requiresWrite ? "apply" : "dry-run";
  const gate = createWriteGate(effectiveMode);

  const newPlan: ActionPlan = {
    ...prepared.plan,
    checkpoints: newCheckpoints,
  };
  newPlan.previewText = previewAction(newPlan);

  const newPrepared: InternalPreparedAction = {
    plan: newPlan,
    gate,
    readyToExecute: allVerified,
    blockers,
    [REQUESTED_MODE]: requestedMode,
  };

  return newPrepared;
}
