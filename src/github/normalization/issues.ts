/**
 * GraphQL closingIssuesReferences -> same-repo issue numbers. Cross-repo closing
 * refs are dropped: keeping only the bare number would alias another repo's issue
 * onto this repo's numbering and fabricate closing edges. A fetched PR with no
 * refs is known-empty ([]), never undefined — undefined is reserved for
 * pre-upgrade rows where the field was never scanned.
 */
export function mapClosingIssues(
  refs: { nodes?: Array<{ number: number; repository?: { nameWithOwner: string } }> } | null | undefined,
  repoFull: string,
): number[] {
  return (refs?.nodes || []).filter((n) => n.repository?.nameWithOwner === repoFull).map((n) => n.number);
}
