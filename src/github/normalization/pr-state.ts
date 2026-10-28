/**
 * Normalize a REST PR's state to open/closed/merged. The REST `state` field is
 * only "open"|"closed" and never "merged", so a merged PR looks "closed" unless
 * we consult `merged_at`. (The GraphQL path already returns MERGED directly.)
 */
export function restPRState(pr: { state: string; merged_at?: string | null }): string {
  return pr.merged_at ? "merged" : pr.state;
}
