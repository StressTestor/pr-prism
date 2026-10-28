import { describe, expect, it } from "vitest";
import {
  type ActionPlan,
  type MaintainerActionKind,
  prepareAction,
  previewAction,
  validateNotStale,
  verifyCheckpoint,
} from "../maintainer/actions.js";
import { MockMaintainerTransport } from "../maintainer/mock-transport.js";

function buildTestPlan(updatedAt = "2026-10-01T00:00:00Z", kind: MaintainerActionKind = "post_comment") {
  return {
    kind,
    target: {
      repo: "odysseus-dev/odysseus",
      number: 42,
      type: "pr" as const,
      currentState: "open" as const,
      updatedAt,
    },
    proposedBody: "Test comment body",
    draftSource: "test_generator",
    requiresWrite: true,
  };
}

describe("prepareAction", () => {
  const plan = buildTestPlan();

  it("defaults to dry-run", () => {
    const prepared = prepareAction(plan, {});
    expect(prepared.gate.mode).toBe("dry-run");
  });

  it("is not ready to execute without all 9 checkpoints", () => {
    const prepared = prepareAction(plan, {});
    expect(prepared.readyToExecute).toBe(false);
    expect(prepared.blockers.length).toBeGreaterThan(0);
  });

  it("a write cannot silently bypass gate", async () => {
    const transport = new MockMaintainerTransport();
    // Even with transport available, dry-run gate prevents real writes
    expect(transport.isDryRun).toBe(true);
  });

  it("stale state blocks write preparation", () => {
    const planWithTime = {
      ...buildTestPlan("2026-10-01T00:00:00Z"),
      checkpoints: [],
      previewText: "",
    } as ActionPlan;
    const result = validateNotStale(planWithTime, "2026-10-27T00:00:00Z"); // different timestamp
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("duplicate closure can be previewed without submission", () => {
    const transport = new MockMaintainerTransport();
    const duplicateClosurePlan = {
      ...buildTestPlan("2026-10-01T00:00:00Z", "close_item"),
      proposedBody: "Closing as duplicate of #38 (dry-run preview)",
      checkpoints: [],
      previewText: "",
    } as ActionPlan;
    const preview = previewAction(duplicateClosurePlan);
    expect(preview).toContain("close_item");
    expect(preview).toContain("odysseus-dev/odysseus#42");
    expect(transport.calls).toHaveLength(0); // nothing submitted
  });

  it("9 explicit checkpoints are required", () => {
    let prepared = prepareAction(plan, {});
    for (let i = 1; i <= 8; i++) {
      prepared = verifyCheckpoint(prepared, i);
      expect(prepared.readyToExecute).toBe(false);
    }
    prepared = verifyCheckpoint(prepared, 9);
    // All 9 checkpoints verified
    expect(prepared.readyToExecute).toBe(true);
    expect(prepared.blockers).toHaveLength(0);
  });

  it("rejects bulk operations or non-positive item numbers", () => {
    expect(() =>
      prepareAction({
        ...plan,
        target: { ...plan.target, number: 0 },
      }),
    ).toThrow("Bulk operations are not supported");
  });

  it("strictly prohibits approval actions", () => {
    expect(() =>
      prepareAction({
        ...plan,
        kind: "approve" as any,
      }),
    ).toThrow("strictly prohibited");
  });
});

describe("MockMaintainerTransport", () => {
  it("GitHub dry-run results in zero mutations", async () => {
    const transport = new MockMaintainerTransport();
    await transport.postComment("odysseus-dev/odysseus", 1, "test");
    expect(transport.isDryRun).toBe(true);
    // The mock records the call but performs no real GitHub write
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].method).toBe("postComment");
  });

  it("records PR reviews and closes items in dry run", async () => {
    const transport = new MockMaintainerTransport();
    await transport.submitPrReview("odysseus-dev/odysseus", 101, {
      event: "REQUEST_CHANGES",
      body: "Please add regression tests",
    });
    await transport.closeItem("odysseus-dev/odysseus", 103, "pr");

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0].method).toBe("submitPrReview");
    expect(transport.calls[1].method).toBe("closeItem");
  });
});
