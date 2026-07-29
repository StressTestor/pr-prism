/**
 * Incident awareness.
 *
 * A repository-wide event (a visibility flip, a bulk close, a migration) can
 * close large numbers of pull requests for reasons unrelated to their quality.
 * Lifecycle state is a ranking signal here, so without this the affected items
 * are indistinguishable from ones a maintainer closed deliberately, and they
 * rank as though they had been rejected.
 */

/** A window as written in `prism.config.yaml`, with bounds still as text. */
export interface IncidentWindow {
  /** ISO-8601 timestamp; inclusive. */
  start: string;
  /** ISO-8601 timestamp; exclusive. */
  end: string;
  reason: string;
}

/** A window with its bounds resolved to epoch milliseconds. */
export interface CompiledIncidentWindow {
  start: number;
  end: number;
  reason: string;
}

/** Accepts null as well as undefined: a SQLite row round-trips a missing
 * close timestamp as null, while PRItem uses undefined. */
export interface IncidentClosable {
  state: string;
  closedAt?: string | null;
}

/**
 * Resolve window bounds once, up front.
 *
 * Two reasons this is not done per item. A malformed window would otherwise
 * match nothing and say nothing, which is the silent no-op the config schema
 * rejects at load; windows reaching a VectorStore from anywhere other than that
 * validated path deserve the same treatment. And bounds are constants, so
 * re-parsing them for every item in a backlog is work with no result.
 */
export function compileIncidentWindows(windows: readonly IncidentWindow[]): CompiledIncidentWindow[] {
  return windows.map((w) => {
    const start = Date.parse(w.start);
    const end = Date.parse(w.end);
    // The reason is quoted so the offending entry is findable in a long list.
    const label = `incident window ${JSON.stringify(w.reason)}`;
    if (Number.isNaN(start)) {
      throw new Error(`${label}: start ${JSON.stringify(w.start)} is not a parseable ISO-8601 timestamp`);
    }
    if (Number.isNaN(end)) {
      throw new Error(`${label}: end ${JSON.stringify(w.end)} is not a parseable ISO-8601 timestamp`);
    }
    if (end <= start) {
      throw new Error(`${label}: end must be after its start`);
    }
    return { start, end, reason: w.reason };
  });
}

/** Half-open `[start, end)`: an item closed exactly at `end` belongs to
 * whatever happened next, not to this incident. */
export function isIncidentClosed(item: IncidentClosable, windows: readonly CompiledIncidentWindow[]): boolean {
  if (item.state !== "closed" || !item.closedAt) return false;
  const closed = Date.parse(item.closedAt);
  if (Number.isNaN(closed)) return false;
  return windows.some((w) => closed >= w.start && closed < w.end);
}
