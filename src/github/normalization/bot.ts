/**
 * Whether a GitHub account is an app, from whichever field the API used:
 * GraphQL reports `__typename`, REST reports `type`.
 *
 * Returns undefined when GitHub gave no account (a deleted user) or no type,
 * because that is unknown, not "human" — recording false would suppress the
 * login fallback in src/bots.ts and assert something never observed.
 */
export function accountIsBot(account: { __typename?: string; type?: string } | null | undefined): boolean | undefined {
  const kind = account?.__typename ?? account?.type;
  if (kind === undefined) return undefined;
  return kind === "Bot";
}
