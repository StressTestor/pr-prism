/**
 * Incident awareness.
 *
 * A repository-wide event (a visibility flip, a bulk close, a migration) can
 * close large numbers of pull requests for reasons unrelated to their quality.
 * Lifecycle state is a ranking signal here, so without this the affected items
 * are indistinguishable from ones a maintainer closed deliberately, and they
 * rank as though they had been rejected.
 */

export interface IncidentWindow {
  /** ISO-8601 timestamp; inclusive. */
  start: string;
  /** ISO-8601 timestamp; exclusive. */
  end: string;
  reason: string;
}

/** Accepts null as well as undefined: a SQLite row round-trips a missing
 * close timestamp as null, while PRItem uses undefined. */
export interface IncidentClosable {
  state: string;
  closedAt?: string | null;
}

export function isIncidentClosed(item: IncidentClosable, windows: readonly IncidentWindow[]): boolean {
  if (item.state !== "closed" || !item.closedAt) return false;
  const closed = Date.parse(item.closedAt);
  if (Number.isNaN(closed)) return false;
  return windows.some((w) => {
    const start = Date.parse(w.start);
    const end = Date.parse(w.end);
    if (Number.isNaN(start) || Number.isNaN(end)) return false;
    return closed >= start && closed < end;
  });
}
