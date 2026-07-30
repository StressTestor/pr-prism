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
const ISO_8601_ABSOLUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * A bound must be a full ISO-8601 instant carrying an explicit offset. This
 * lives here rather than only in the CLI's zod schema because the App path
 * reaches this function directly from a hand-edited config.json: the same
 * string that the CLI rejects was being accepted there and parsed in the host
 * timezone, so one window meant different instants on a laptop and on a server.
 */
function requireAbsoluteInstant(value: unknown, label: string, field: string): number {
  if (typeof value !== "string") {
    throw new Error(`${label}: ${field} must be a string, got ${typeof value}`);
  }
  if (!ISO_8601_ABSOLUTE.test(value.trim())) {
    throw new Error(
      `${label}: ${field} ${JSON.stringify(value)} must be an ISO-8601 instant with an explicit UTC offset (e.g. 2026-07-23T00:00:00Z or +02:00)`,
    );
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${label}: ${field} ${JSON.stringify(value)} is not a parseable ISO-8601 timestamp`);
  }
  return parsed;
}

export function compileIncidentWindows(windows: readonly IncidentWindow[]): CompiledIncidentWindow[] {
  if (!Array.isArray(windows)) {
    throw new Error("incidents must be a list of {start, end, reason} objects");
  }
  return windows.map((w, index) => {
    if (typeof w !== "object" || w === null) {
      throw new Error(`incidents[${index}] must be an object with start, end and reason`);
    }
    // The reason is quoted so the offending entry is findable in a long list;
    // the index covers an entry whose reason is itself missing.
    const label = w.reason ? `incident window ${JSON.stringify(w.reason)}` : `incidents[${index}]`;
    const start = requireAbsoluteInstant(w.start, label, "start");
    const end = requireAbsoluteInstant(w.end, label, "end");
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
