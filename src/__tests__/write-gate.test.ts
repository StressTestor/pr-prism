import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWriteGate, resolveWriteMode } from "../write-gate.js";

describe("resolveWriteMode", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.PRISM_APPLY;
    delete process.env.PRISM_WRITE;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("defaults to dry-run (the read-only ethos)", () => {
    expect(resolveWriteMode()).toBe("dry-run");
    expect(resolveWriteMode({})).toBe("dry-run");
  });

  it("apply flag opts in", () => {
    expect(resolveWriteMode({ apply: true })).toBe("apply");
  });

  it("explicit dryRun wins over apply", () => {
    expect(resolveWriteMode({ apply: true, dryRun: true })).toBe("dry-run");
  });

  it("PRISM_APPLY truthy env opts in when no flags", () => {
    process.env.PRISM_APPLY = "1";
    expect(resolveWriteMode()).toBe("apply");
    process.env.PRISM_APPLY = "false";
    expect(resolveWriteMode()).toBe("dry-run");
    process.env.PRISM_APPLY = "0";
    expect(resolveWriteMode()).toBe("dry-run");
  });

  it("an explicit dryRun flag overrides the env opt-in", () => {
    process.env.PRISM_APPLY = "1";
    expect(resolveWriteMode({ dryRun: true })).toBe("dry-run");
  });
});

describe("createWriteGate", () => {
  it("dry-run does not invoke run, journals the intent, returns not-applied", async () => {
    const gate = createWriteGate("dry-run");
    const run = vi.fn(async () => "done");
    const out = await gate.guard({ kind: "label", target: "#5:bug", run });
    expect(run).not.toHaveBeenCalled();
    expect(out).toEqual({ applied: false, result: null });
    expect(gate.journal).toEqual([{ kind: "label", target: "#5:bug" }]);
  });

  it("apply invokes run once and returns the result", async () => {
    const gate = createWriteGate("apply");
    const run = vi.fn(async () => 42);
    const out = await gate.guard({ kind: "comment", target: "#7", run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ applied: true, result: 42 });
    expect(gate.journal).toEqual([]);
  });
});
