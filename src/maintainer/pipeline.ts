import type { WriteMode } from "../write-gate.js";
import {
  type ActionPlan,
  isReadyToExecute,
  type PreparedAction,
  prepareAction,
  validateNotStale,
  verifyCheckpoint,
} from "./actions.js";
import { type ActionAuditRecord, appendAuditRecord, generateAuditId } from "./audit.js";
import type { MaintainerGitHubTransport, RemoteState } from "./github-transport.js";

export interface PipelineExecuteResult {
  success: boolean;
  dryRun: boolean;
  auditRecord: ActionAuditRecord;
  readbackState?: RemoteState;
  error?: string;
}

/**
 * Higher-level maintainer action execution pipeline.
 *
 * Implements the 9-checkpoint invariant:
 * - Refuses execution unless all 9 checkpoints are verified.
 * - Always defaults to dry-run.
 * - Checks remote staleness against original plan.
 * - Dispatches guarded actions through MaintainerGitHubTransport.
 * - Performs post-write readback.
 * - Appends audit log record.
 */
export class MaintainerActionPipeline {
  private transport: MaintainerGitHubTransport;
  private auditPath?: string;

  constructor(transport: MaintainerGitHubTransport, opts?: { auditPath?: string }) {
    this.transport = transport;
    this.auditPath = opts?.auditPath;
  }

  prepare(plan: Omit<ActionPlan, "checkpoints" | "previewText">, opts?: { mode?: WriteMode }): PreparedAction {
    return prepareAction(plan, opts);
  }

  verifyCheckpoint(prepared: PreparedAction, step: number): PreparedAction {
    return verifyCheckpoint(prepared, step);
  }

  async execute(prepared: PreparedAction, opts?: { auditPath?: string }): Promise<PipelineExecuteResult> {
    const auditPath = opts?.auditPath ?? this.auditPath;
    const verifiedSteps = prepared.plan.checkpoints.filter((c) => c.verified).map((c) => c.step);

    // 1. Guard readiness: all 9 checkpoints must be verified
    if (!isReadyToExecute(prepared)) {
      const record: ActionAuditRecord = {
        id: generateAuditId(),
        timestamp: new Date().toISOString(),
        repo: prepared.plan.target.repo,
        number: prepared.plan.target.number,
        type: prepared.plan.target.type,
        actionKind: prepared.plan.kind,
        dryRun: prepared.gate.mode === "dry-run",
        checkpointsVerified: verifiedSteps,
        proposedBody: prepared.plan.proposedBody,
        result: "blocked",
        resultDetail: `Execution blocked by unmet checkpoints: ${prepared.blockers.join("; ")}`,
      };
      if (auditPath) {
        appendAuditRecord(auditPath, record);
      }
      return {
        success: false,
        dryRun: prepared.gate.mode === "dry-run",
        auditRecord: record,
        error: record.resultDetail,
      };
    }

    // 2. Fresh remote state & staleness verification (Checkpoints 4 & 5)
    let freshState: RemoteState;
    try {
      freshState = await this.transport.getCurrentState(
        prepared.plan.target.repo,
        prepared.plan.target.number,
        prepared.plan.target.type,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const record: ActionAuditRecord = {
        id: generateAuditId(),
        timestamp: new Date().toISOString(),
        repo: prepared.plan.target.repo,
        number: prepared.plan.target.number,
        type: prepared.plan.target.type,
        actionKind: prepared.plan.kind,
        dryRun: prepared.gate.mode === "dry-run",
        checkpointsVerified: verifiedSteps,
        proposedBody: prepared.plan.proposedBody,
        result: "error",
        resultDetail: `Failed to fetch remote state: ${message}`,
      };
      if (auditPath) appendAuditRecord(auditPath, record);
      return {
        success: false,
        dryRun: prepared.gate.mode === "dry-run",
        auditRecord: record,
        error: record.resultDetail,
      };
    }

    const staleness = validateNotStale(prepared.plan, freshState.updatedAt);
    if (!staleness.valid) {
      const record: ActionAuditRecord = {
        id: generateAuditId(),
        timestamp: new Date().toISOString(),
        repo: prepared.plan.target.repo,
        number: prepared.plan.target.number,
        type: prepared.plan.target.type,
        actionKind: prepared.plan.kind,
        dryRun: prepared.gate.mode === "dry-run",
        checkpointsVerified: verifiedSteps,
        proposedBody: prepared.plan.proposedBody,
        result: "blocked",
        resultDetail: `Staleness check failed: ${staleness.reason}`,
        observedState: freshState,
      };
      if (auditPath) appendAuditRecord(auditPath, record);
      return {
        success: false,
        dryRun: prepared.gate.mode === "dry-run",
        auditRecord: record,
        error: record.resultDetail,
      };
    }

    // 3. Dry-run mode execution
    const isDryRun = prepared.gate.mode === "dry-run" || this.transport.isDryRun;
    if (isDryRun) {
      try {
        await this.dispatchTransportAction(prepared);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const record: ActionAuditRecord = {
          id: generateAuditId(),
          timestamp: new Date().toISOString(),
          repo: prepared.plan.target.repo,
          number: prepared.plan.target.number,
          type: prepared.plan.target.type,
          actionKind: prepared.plan.kind,
          dryRun: true,
          checkpointsVerified: verifiedSteps,
          proposedBody: prepared.plan.proposedBody,
          result: "error",
          resultDetail: `Dry-run execution failed: ${message}`,
          observedState: freshState,
        };
        if (auditPath) appendAuditRecord(auditPath, record);
        return {
          success: false,
          dryRun: true,
          auditRecord: record,
          error: record.resultDetail,
        };
      }

      const record: ActionAuditRecord = {
        id: generateAuditId(),
        timestamp: new Date().toISOString(),
        repo: prepared.plan.target.repo,
        number: prepared.plan.target.number,
        type: prepared.plan.target.type,
        actionKind: prepared.plan.kind,
        dryRun: true,
        checkpointsVerified: verifiedSteps,
        proposedBody: prepared.plan.proposedBody,
        result: "dry_run",
        resultDetail: "Action simulated under dry-run mode (no remote changes made)",
        observedState: freshState,
      };
      if (auditPath) appendAuditRecord(auditPath, record);
      return {
        success: true,
        dryRun: true,
        auditRecord: record,
        readbackState: freshState,
      };
    }

    // 4. Apply write execution
    try {
      await this.dispatchTransportAction(prepared);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const record: ActionAuditRecord = {
        id: generateAuditId(),
        timestamp: new Date().toISOString(),
        repo: prepared.plan.target.repo,
        number: prepared.plan.target.number,
        type: prepared.plan.target.type,
        actionKind: prepared.plan.kind,
        dryRun: false,
        checkpointsVerified: verifiedSteps,
        proposedBody: prepared.plan.proposedBody,
        result: "error",
        resultDetail: `Execution failed: ${message}`,
      };
      if (auditPath) appendAuditRecord(auditPath, record);
      return {
        success: false,
        dryRun: false,
        auditRecord: record,
        error: record.resultDetail,
      };
    }

    // 5. Post-write readback (Checkpoint 8)
    let readbackState: RemoteState | undefined;
    try {
      readbackState = await this.transport.getCurrentState(
        prepared.plan.target.repo,
        prepared.plan.target.number,
        prepared.plan.target.type,
      );
    } catch {
      // Best-effort readback
    }

    // 6. Audit append (Checkpoint 9)
    const record: ActionAuditRecord = {
      id: generateAuditId(),
      timestamp: new Date().toISOString(),
      repo: prepared.plan.target.repo,
      number: prepared.plan.target.number,
      type: prepared.plan.target.type,
      actionKind: prepared.plan.kind,
      dryRun: false,
      checkpointsVerified: verifiedSteps,
      proposedBody: prepared.plan.proposedBody,
      result: "success",
      resultDetail: `Successfully executed ${prepared.plan.kind}`,
      observedState: readbackState,
    };
    if (auditPath) {
      appendAuditRecord(auditPath, record);
    }

    return {
      success: true,
      dryRun: false,
      auditRecord: record,
      readbackState,
    };
  }

  private async dispatchTransportAction(prepared: PreparedAction): Promise<void> {
    const { repo, number, type } = prepared.plan.target;
    switch (prepared.plan.kind) {
      case "post_comment":
        await this.transport.postComment(repo, number, prepared.plan.proposedBody ?? "");
        break;
      case "request_changes":
        await this.transport.submitPrReview(repo, number, {
          event: "REQUEST_CHANGES",
          body: prepared.plan.proposedBody ?? "",
        });
        break;
      case "submit_pr_review_comment":
        await this.transport.submitPrReview(repo, number, {
          event: "COMMENT",
          body: prepared.plan.proposedBody ?? "",
        });
        break;
      case "close_item":
        await this.transport.closeItem(repo, number, type);
        break;
      case "apply_label":
        for (const label of prepared.plan.proposedLabels ?? []) {
          await this.transport.applyLabel(repo, number, label);
        }
        break;
      default:
        throw new Error(`Unsupported action kind: ${(prepared.plan as { kind: string }).kind}`);
    }
  }
}
