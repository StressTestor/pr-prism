import type { PrismConfig } from "./config.js";
import type { GitHubClient } from "./github.js";

const LABEL_COLORS: Record<string, { color: string; description: string }> = {
  duplicate: { color: "d93f0b", description: "Duplicate or near-duplicate of another PR" },
  aligned: { color: "0e8a16", description: "Aligned with project vision" },
  drifting: { color: "fbca04", description: "Partially aligned — may need refocusing" },
  off_vision: { color: "e11d48", description: "Does not align with project vision" },
  top_pick: { color: "5319e7", description: "Best PR in its duplicate cluster" },
};

export async function ensureLabelsExist(github: GitHubClient, config: PrismConfig): Promise<void> {
  for (const [key, labelName] of Object.entries(config.labels)) {
    const meta = LABEL_COLORS[key];
    if (!meta) continue;
    await github.ensureLabel(labelName, meta.color, meta.description);
  }
}

export interface LabelAction {
  number: number;
  action: "add" | "remove";
  label: string;
  reason: string;
}

export async function applyLabelActions(
  github: GitHubClient,
  actions: LabelAction[],
  dryRun = false,
): Promise<LabelAction[]> {
  if (dryRun) return actions;

  for (const action of actions) {
    if (action.action === "add") {
      await github.applyLabel(action.number, action.label);
    } else {
      await github.removeLabel(action.number, action.label);
    }
    // Rate limit: 200ms between label API calls
    await new Promise((r) => setTimeout(r, 200));
  }

  return actions;
}
