import { describe, it, expect, vi } from "vitest";
import { applyLabelActions, type LabelAction } from "../labels.js";

describe("applyLabelActions", () => {
  it("returns actions without calling github in dry run mode", async () => {
    const mockGithub = {
      applyLabel: vi.fn(),
      removeLabel: vi.fn(),
    } as any;

    const actions: LabelAction[] = [
      { number: 1, action: "add", label: "test", reason: "test" },
      { number: 2, action: "remove", label: "test", reason: "test" },
    ];

    const result = await applyLabelActions(mockGithub, actions, true);
    expect(result).toEqual(actions);
    expect(mockGithub.applyLabel).not.toHaveBeenCalled();
    expect(mockGithub.removeLabel).not.toHaveBeenCalled();
  });

  it("calls github methods when not dry run", async () => {
    const mockGithub = {
      applyLabel: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
    } as any;

    const actions: LabelAction[] = [
      { number: 1, action: "add", label: "test-label", reason: "reason" },
      { number: 2, action: "remove", label: "old-label", reason: "reason" },
    ];

    await applyLabelActions(mockGithub, actions, false);
    expect(mockGithub.applyLabel).toHaveBeenCalledWith(1, "test-label");
    expect(mockGithub.removeLabel).toHaveBeenCalledWith(2, "old-label");
  });
});
