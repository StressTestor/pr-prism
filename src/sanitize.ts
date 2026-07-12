// Shared sanitizer for every title/theme emit boundary. GitHub titles are
// attacker-influenced free text: a newline breaks a markdown table row (row
// injection), control/ANSI bytes corrupt terminals and downstream renderers,
// and pathological length bloats the JSON contract. One module, routed at every
// place a title or theme is emitted for display, report, or the star-map payload.

// C0 controls (incl newline/return/tab and the ANSI ESC), DEL, and C1 controls.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Replace control chars with a space, collapse whitespace runs, and trim. */
export function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/**
 * For JSON/contract and console emits: control-strip and cap length (default 256,
 * ~GitHub's max title length, so it only clips pathological input).
 */
export function sanitizeTitle(s: string, maxLength = 256): string {
  return stripControlChars(s).slice(0, maxLength);
}

/**
 * For a markdown table cell: control-strip, truncate the RAW text, THEN escape
 * pipes. Truncating before escaping avoids slicing an escaped pipe in half; the
 * trailing-backslash strip stops a title ending in a backslash from escaping the
 * cell delimiter.
 */
export function escapeTableCell(s: string, maxLength = 60): string {
  return stripControlChars(s).slice(0, maxLength).replace(/\|/g, "\\|").replace(/\\+$/, "");
}
