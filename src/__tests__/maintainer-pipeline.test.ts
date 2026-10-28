import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTION_CHECKPOINTS,
  type ActionPlan,
  isReadyToExecute,
  prepareAction,
  previewAction,
  validateNotStale,
  verifyCheckpoint,
} from "../maintainer/actions.js";
import { type ActionAuditRecord, appendAuditRecord, generateAuditId, readAuditLog } from "../maintainer/audit.js";
import { MockMaintainerTransport } from "../maintainer/mock-transport.js";
import { MaintainerActionPipeline } from "../maintainer/pipeline.js";

describe("Maintainer Actions & Checkpoints", () => {
  const basePlan: Omit<ActionPlan, "checkpoints" | "previewText"> = {
    kind: "post_comment",
    target: {
      repo: "owner/repo",
      number: 42,
      type: "pr",
      currentState: "open",
      updatedAt: "2026-10-27T10:00:00.000Z",
    },
    proposedBody: "Please rebase on main.",
    draftSource: "jev-review-orchestrator",
    requiresWrite: true,
  };

  it("prepareAction initializes all 9 checkpoints as unverified and enforces dry-run gate", () => {
    const prepared = prepareAction(basePlan, { mode: "apply" });

    expect(prepared.readyToExecute).toBe(false);
    expect(prepared.plan.checkpoints).toHaveLength(9);
    expect(prepared.blockers).toHaveLength(9);
    // Invariant: gate is ALWAYS dry-run unless all 9 checkpoints are verified
    expect(prepared.gate.mode).toBe("dry-run");

    for (let step = 1; step <= 9; step++) {
      const cp = prepared.plan.checkpoints.find((c) => c.step === step);
      expect(cp).toBeDefined();
      expect(cp?.verified).toBe(false);
      expect(cp?.description).toBe(ACTION_CHECKPOINTS[step]);
    }
  });

  it("verifyCheckpoint marks steps verified and unlocks apply mode only after all 9 steps", () => {
    let prepared = prepareAction(basePlan, { mode: "apply" });

    // Verify steps 1 through 8
    for (let step = 1; step <= 8; step++) {
      prepared = verifyCheckpoint(prepared, step);
      expect(prepared.readyToExecute).toBe(false);
      expect(isReadyToExecute(prepared)).toBe(false);
      expect(prepared.gate.mode).toBe("dry-run");
      expect(prepared.blockers).toHaveLength(9 - step);
    }

    // Verify 9th step
    prepared = verifyCheckpoint(prepared, 9);
    expect(prepared.readyToExecute).toBe(true);
    expect(isReadyToExecute(prepared)).toBe(true);
    expect(prepared.blockers).toHaveLength(0);
    // Now apply mode is enabled because mode was requested as "apply" and requiresWrite is true
    expect(prepared.gate.mode).toBe("apply");
  });

  it("stays dry-run if mode was dry-run even after all 9 checkpoints verified", () => {
    let prepared = prepareAction(basePlan, { mode: "dry-run" });

    for (let step = 1; step <= 9; step++) {
      prepared = verifyCheckpoint(prepared, step);
    }

    expect(prepared.readyToExecute).toBe(true);
    expect(prepared.gate.mode).toBe("dry-run");
  });

  it("throws error when verifying invalid checkpoint step", () => {
    const prepared = prepareAction(basePlan);
    expect(() => verifyCheckpoint(prepared, 0)).toThrow("between 1 and 9");
    expect(() => verifyCheckpoint(prepared, 10)).toThrow("between 1 and 9");
  });

  it("rejects bulk operations (invalid target number or missing repo)", () => {
    expect(() =>
      prepareAction({
        ...basePlan,
        target: { ...basePlan.target, number: 0 },
      }),
    ).toThrow(/bulk operations are not supported/i);

    expect(() =>
      prepareAction({
        ...basePlan,
        target: { ...basePlan.target, repo: "" },
      }),
    ).toThrow(/repo must be specified/i);
  });

  it("strictly prohibits APPROVE or merge action kinds", () => {
    expect(() =>
      prepareAction({
        ...basePlan,
        kind: "approve" as any,
      }),
    ).toThrow(/strictly prohibited/i);

    expect(() =>
      prepareAction({
        ...basePlan,
        kind: "merge" as any,
      }),
    ).toThrow(/strictly prohibited/i);
  });

  it("restricts review actions to PR items", () => {
    expect(() =>
      prepareAction({
        ...basePlan,
        kind: "request_changes",
        target: { ...basePlan.target, type: "issue" },
      }),
    ).toThrow(/can only be performed on PR targets/i);

    expect(() =>
      prepareAction({
        ...basePlan,
        kind: "submit_pr_review_comment",
        target: { ...basePlan.target, type: "issue" },
      }),
    ).toThrow(/can only be performed on PR targets/i);
  });

  it("previewAction formats comprehensive human-readable summary", () => {
    const prepared = prepareAction({
      ...basePlan,
      proposedLabels: ["needs-work", "review/blocked"],
    });

    const preview = previewAction(prepared.plan);
    expect(preview).toContain("=== MAINTAINER ACTION PREVIEW ===");
    expect(preview).toContain("Action: post_comment");
    expect(preview).toContain("Target: owner/repo#42 (PR)");
    expect(preview).toContain("Labels to Apply: needs-work, review/blocked");
    expect(preview).toContain("Proposed Body:\nPlease rebase on main.");
    expect(preview).toContain("Checkpoints: 0/9 verified");
  });

  it("validateNotStale checks freshness against remote timestamp", () => {
    const plan: ActionPlan = {
      ...basePlan,
      checkpoints: [],
      previewText: "",
    };

    // Exactly matching timestamp
    expect(validateNotStale(plan, "2026-10-27T10:00:00.000Z").valid).toBe(true);

    // Stale timestamp
    const staleResult = validateNotStale(plan, "2026-10-27T10:05:00.000Z");
    expect(staleResult.valid).toBe(false);
    expect(staleResult.reason).toContain("Target state has changed");

    // Missing timestamp
    expect(validateNotStale(plan, "").valid).toBe(false);
  });
});

describe("MockMaintainerTransport", () => {
  it("records calls and returns expected dry-run results", async () => {
    const transport = new MockMaintainerTransport({
      mockState: {
        number: 42,
        state: "open",
        updatedAt: "2026-10-27T10:00:00.000Z",
      },
    });

    expect(transport.isDryRun).toBe(true);

    // postComment
    const commentRes = await transport.postComment("owner/repo", 42, "Test comment");
    expect(commentRes).toEqual({
      success: true,
      commentId: "mock-comment-1",
      url: "https://github.com/owner/repo/issues/42#issuecomment-1",
      dryRun: true,
    });

    // submitPrReview COMMENT
    const reviewRes = await transport.submitPrReview("owner/repo", 42, {
      event: "COMMENT",
      body: "Looks good overall",
    });
    expect(reviewRes).toEqual({
      success: true,
      reviewId: "mock-review-1",
      url: "https://github.com/owner/repo/pull/42#pullrequestreview-1",
      event: "COMMENT",
      dryRun: true,
    });

    // submitPrReview REQUEST_CHANGES
    const reviewRes2 = await transport.submitPrReview("owner/repo", 42, {
      event: "REQUEST_CHANGES",
      body: "Fix nit",
    });
    expect(reviewRes2).toEqual({
      success: true,
      reviewId: "mock-review-2",
      url: "https://github.com/owner/repo/pull/42#pullrequestreview-2",
      event: "REQUEST_CHANGES",
      dryRun: true,
    });

    // closeItem
    const closeRes = await transport.closeItem("owner/repo", 42, "pr");
    expect(closeRes).toEqual({
      success: true,
      dryRun: true,
    });

    // applyLabel
    const labelRes = await transport.applyLabel("owner/repo", 42, "bug");
    expect(labelRes).toEqual({
      success: true,
      label: "bug",
      dryRun: true,
    });

    // getCurrentState reflects closed state after closeItem
    const state = await transport.getCurrentState("owner/repo", 42, "pr");
    expect(state.state).toBe("closed");

    // verify recorded calls
    expect(transport.calls).toHaveLength(6);
    expect(transport.calls[0].method).toBe("postComment");
    expect(transport.calls[1].method).toBe("submitPrReview");
    expect(transport.calls[2].method).toBe("submitPrReview");
    expect(transport.calls[3].method).toBe("closeItem");
    expect(transport.calls[4].method).toBe("applyLabel");
    expect(transport.calls[5].method).toBe("getCurrentState");
  });

  it("forbids APPROVE event on submitPrReview", async () => {
    const transport = new MockMaintainerTransport();
    await expect(
      transport.submitPrReview("owner/repo", 42, {
        event: "APPROVE" as any,
        body: "Approved",
      }),
    ).rejects.toThrow(/Approval reviews are strictly prohibited/i);
  });
});

describe("Audit Logging", () => {
  let tmpDir: string;
  let auditPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-maintainer-test-"));
    auditPath = path.join(tmpDir, "audit.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generateAuditId generates valid UUID", () => {
    const id = generateAuditId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("appends and reads audit records in JSON Lines format", () => {
    expect(readAuditLog(auditPath)).toEqual([]);

    const record1: ActionAuditRecord = {
      id: generateAuditId(),
      timestamp: "2026-10-27T10:00:00.000Z",
      repo: "owner/repo",
      number: 10,
      type: "pr",
      actionKind: "post_comment",
      dryRun: true,
      checkpointsVerified: [1, 2, 3],
      result: "dry_run",
      resultDetail: "Simulated comment",
    };

    const record2: ActionAuditRecord = {
      id: generateAuditId(),
      timestamp: "2026-10-27T10:05:00.000Z",
      repo: "owner/repo",
      number: 11,
      type: "issue",
      actionKind: "close_item",
      dryRun: false,
      checkpointsVerified: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      result: "success",
      resultDetail: "Closed issue",
      observedState: {
        number: 11,
        state: "closed",
        updatedAt: "2026-10-27T10:05:00.000Z",
      },
    };

    appendAuditRecord(auditPath, record1);
    appendAuditRecord(auditPath, record2);

    const logs = readAuditLog(auditPath);
    expect(logs).toHaveLength(2);
    expect(logs[0].id).toBe(record1.id);
    expect(logs[0].actionKind).toBe("post_comment");
    expect(logs[1].id).toBe(record2.id);
    expect(logs[1].result).toBe("success");
    expect(logs[1].observedState?.state).toBe("closed");
  });
});

describe("MaintainerActionPipeline", () => {
  let tmpDir: string;
  let auditPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-pipeline-test-"));
    auditPath = path.join(tmpDir, "pipeline-audit.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const basePlan: Omit<ActionPlan, "checkpoints" | "previewText"> = {
    kind: "post_comment",
    target: {
      repo: "owner/repo",
      number: 123,
      type: "pr",
      currentState: "open",
      updatedAt: "2026-10-27T10:00:00.000Z",
    },
    proposedBody: "Please rebase.",
    draftSource: "jev-orchestrator",
    requiresWrite: true,
  };

  it("blocks execution if checkpoints are incomplete", async () => {
    const transport = new MockMaintainerTransport();
    const pipeline = new MaintainerActionPipeline(transport, { auditPath });

    const prepared = pipeline.prepare(basePlan);
    const result = await pipeline.execute(prepared);

    expect(result.success).toBe(false);
    expect(result.auditRecord.result).toBe("blocked");
    expect(result.auditRecord.resultDetail).toContain("unmet checkpoints");

    const auditLogs = readAuditLog(auditPath);
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].result).toBe("blocked");
  });

  it("blocks execution if remote state is stale", async () => {
    const transport = new MockMaintainerTransport({
      mockState: {
        number: 123,
        state: "open",
        updatedAt: "2026-10-27T11:00:00.000Z", // differs from plan updatedAt
      },
    });
    const pipeline = new MaintainerActionPipeline(transport, { auditPath });

    let prepared = pipeline.prepare(basePlan);
    for (let step = 1; step <= 9; step++) {
      prepared = pipeline.verifyCheckpoint(prepared, step);
    }

    const result = await pipeline.execute(prepared);
    expect(result.success).toBe(false);
    expect(result.auditRecord.result).toBe("blocked");
    expect(result.auditRecord.resultDetail).toContain("Staleness check failed");
  });

  it("executes simulated dry-run when mode is dry-run", async () => {
    const transport = new MockMaintainerTransport({
      mockState: {
        number: 123,
        state: "open",
        updatedAt: "2026-10-27T10:00:00.000Z",
      },
    });
    const pipeline = new MaintainerActionPipeline(transport, { auditPath });

    let prepared = pipeline.prepare(basePlan, { mode: "dry-run" });
    for (let step = 1; step <= 9; step++) {
      prepared = pipeline.verifyCheckpoint(prepared, step);
    }

    const result = await pipeline.execute(prepared);
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.auditRecord.result).toBe("dry_run");
    expect(transport.calls.some((c) => c.method === "postComment")).toBe(true);

    const auditLogs = readAuditLog(auditPath);
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].result).toBe("dry_run");
  });

  it("executes write, performs readback, and logs audit when all 9 checkpoints verified in apply mode", async () => {
    const transport = new MockMaintainerTransport({
      isDryRun: false,
      mockState: {
        number: 123,
        state: "open",
        updatedAt: "2026-10-27T10:00:00.000Z",
      },
    });
    const pipeline = new MaintainerActionPipeline(transport, { auditPath });

    let prepared = pipeline.prepare(basePlan, { mode: "apply" });
    for (let step = 1; step <= 9; step++) {
      prepared = pipeline.verifyCheckpoint(prepared, step);
    }

    expect(prepared.gate.mode).toBe("apply");
    const result = await pipeline.execute(prepared);

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.auditRecord.result).toBe("success");
    expect(result.readbackState).toBeDefined();

    const auditLogs = readAuditLog(auditPath);
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].result).toBe("success");
    expect(auditLogs[0].dryRun).toBe(false);
  });
});
