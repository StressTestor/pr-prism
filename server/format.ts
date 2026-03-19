import type { OwnerSuggestion } from "./routing.js";

export interface DupeMatch {
  number: number;
  type: "pr" | "issue";
  title: string;
  similarity: number;
  author?: string;
  createdAt?: string;
}

function issueUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${number}`;
}

function pct(value: number): string {
  return (value * 100).toFixed(1);
}

/**
 * Format a triage comment listing duplicate matches for a new issue/PR.
 * Optionally includes suggested reviewers from CODEOWNERS.
 */
export function formatTriageComment(
  repo: string,
  matches: DupeMatch[],
  source: DupeMatch,
  elapsedMs: number,
  owners?: OwnerSuggestion[],
): string {
  const rows = matches
    .map(
      (m) =>
        `| [#${m.number}](${issueUrl(repo, m.number)}) | ${pct(m.similarity)}% | ${m.title} |`,
    )
    .join("\n");

  const elapsed = (elapsedMs / 1000).toFixed(1);

  let comment = `## pr-prism triage

this issue is similar to existing items:

| # | similarity | title |
|---|-----------|-------|
${rows}

**source of truth:** [#${source.number}](${issueUrl(repo, source.number)}) — close this as duplicate if appropriate.`;

  if (owners && owners.length > 0) {
    const ownerList = owners
      .map((o) => `@${o.login} (${o.reason})`)
      .join(", ");
    comment += `\n\n**suggested reviewers:** ${ownerList}`;
  }

  comment += `\n\n*triaged by [pr-prism](https://github.com/StressTestor/pr-prism) in ${elapsed}s*`;

  return comment;
}

/**
 * Format the auto-close comment posted when similarity exceeds the auto-close threshold.
 */
export function formatAutoCloseComment(
  repo: string,
  source: DupeMatch,
  similarity: number,
): string {
  return `closing as duplicate of [#${source.number}](${issueUrl(repo, source.number)}) (${pct(similarity)}% similar).

*auto-closed by [pr-prism](https://github.com/StressTestor/pr-prism)*`;
}
