import type { GitHubWriteContext } from "../types.js";

export async function applyLabel(context: GitHubWriteContext, number: number, label: string): Promise<void> {
  await context.gate.guard({
    kind: "label",
    target: `#${number} +${label}`,
    run: () =>
      context.withBackoff(() =>
        context.octokit.issues.addLabels({
          owner: context.owner,
          repo: context.repo,
          issue_number: number,
          labels: [label],
        }),
      ),
  });
}

export async function removeLabel(context: GitHubWriteContext, number: number, label: string): Promise<void> {
  try {
    await context.gate.guard({
      kind: "label",
      target: `#${number} -${label}`,
      run: () =>
        context.withBackoff(() =>
          context.octokit.issues.removeLabel({
            owner: context.owner,
            repo: context.repo,
            issue_number: number,
            name: label,
          }),
        ),
    });
  } catch {
    // Label might not exist
  }
}

export async function ensureLabel(
  context: GitHubWriteContext,
  label: string,
  color: string,
  description: string,
): Promise<void> {
  try {
    await context.octokit.issues.getLabel({
      owner: context.owner,
      repo: context.repo,
      name: label,
    });
  } catch {
    await context.gate.guard({
      kind: "label-ensure",
      target: label,
      run: () =>
        context.octokit.issues.createLabel({
          owner: context.owner,
          repo: context.repo,
          name: label,
          color,
          description,
        }),
    });
  }
}
