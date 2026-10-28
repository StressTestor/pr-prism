/**
 * Normalize a close timestamp across both API shapes. REST returns snake_case
 * `closed_at`, GraphQL returns `closedAt`; an item still open has neither.
 * Needed so incident windows can tell a bulk auto-close apart from a
 * maintainer's deliberate close (see src/incident.ts).
 */
export function itemClosedAt(raw: { closed_at?: string | null; closedAt?: string | null }): string | undefined {
  return raw.closed_at ?? raw.closedAt ?? undefined;
}
