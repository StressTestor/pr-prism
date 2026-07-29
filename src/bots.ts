// Bot authorship.
//
// Automation reuses PR titles for unrelated content: dependabot files
// "chore(deps): bump the npm group with 2 updates" every week, and embedding
// title+body reads consecutive ones as near-identical. Measured on
// odysseus-dev/odysseus, every false positive among the extra clusters a
// high-recall model found was a recurring bot PR. They are noise for
// duplicate detection specifically, not low-quality contributions.

import type { PRItem } from "./types.js";

/**
 * Logins GitHub reports without the `[bot]` suffix. The GraphQL API returns
 * the bare login (`dependabot`) while REST returns the app form
 * (`dependabot[bot]`) for the same account, so a suffix check alone misses
 * everything the GraphQL path scanned.
 */
const KNOWN_BOT_LOGINS: ReadonlySet<string> = new Set([
  "dependabot",
  "dependabot-preview",
  "renovate",
  "github-actions",
  "greenkeeper",
  "snyk-bot",
  "imgbot",
  "allcontributors",
  "codecov",
  "mergify",
  "pre-commit-ci",
]);

/**
 * Whether an item was filed by automation.
 *
 * Prefers the account type GitHub itself reports, which the scan records when
 * available. Falls back to the login only for rows scanned before that field
 * existed — matching how `closesIssues` treats absent as unknown rather than
 * as a negative answer.
 */
export function isBotAuthor(
  item: Pick<PRItem, "author" | "authorIsBot">,
  extraBotLogins?: ReadonlySet<string>,
): boolean {
  if (item.authorIsBot !== undefined) return item.authorIsBot;

  const login = normalizeLogin(item.author);
  // The `[bot]` suffix REST appends is conclusive on its own.
  if (login.endsWith("[bot]")) return true;
  if (KNOWN_BOT_LOGINS.has(login)) return true;
  if (!extraBotLogins) return false;
  for (const configured of extraBotLogins) {
    if (normalizeLogin(configured) === login) return true;
  }
  return false;
}

/**
 * Strips the `app/` prefix the gh CLI displays and lowercases, so a configured
 * login matches whatever spelling the scan happened to record. Whole logins
 * only: "dependabot-fan" is a person.
 */
function normalizeLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/^app\//, "");
}
