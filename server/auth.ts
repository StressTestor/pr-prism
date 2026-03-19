import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

// Cache installation tokens (they last 1 hour)
const tokenCache = new Map<number, { token: string; expiresAt: Date }>();

export function createAppOctokit(appId: string, privateKey: string): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey },
  });
}

export async function getInstallationOctokit(
  appId: string,
  privateKey: string,
  installationId: number,
): Promise<Octokit> {
  // Check cache
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > new Date()) {
    return new Octokit({ auth: cached.token });
  }

  // Create new installation token
  const appOctokit = createAppOctokit(appId, privateKey);
  const { data } = await appOctokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
  });

  tokenCache.set(installationId, {
    token: data.token,
    expiresAt: new Date(data.expires_at),
  });

  return new Octokit({ auth: data.token });
}

// Helper functions that use the installation token

export async function postComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}

export async function closeIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  await octokit.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    state: "closed",
    state_reason: "not_planned",
  });
}

export async function createIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  title: string,
  body: string,
): Promise<number> {
  const { data } = await octokit.rest.issues.create({
    owner,
    repo,
    title,
    body,
  });
  return data.number;
}

export async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
    if ("content" in data && data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get a raw installation access token string.
 * Useful for passing to clients that don't use Octokit (e.g., GitHubClient).
 */
export async function getInstallationToken(
  appId: string,
  privateKey: string,
  installationId: number,
): Promise<string> {
  // Check cache
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > new Date()) {
    return cached.token;
  }

  // Create new installation token
  const appOctokit = createAppOctokit(appId, privateKey);
  const { data } = await appOctokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
  });

  tokenCache.set(installationId, {
    token: data.token,
    expiresAt: new Date(data.expires_at),
  });

  return data.token;
}

/**
 * Clear the token cache. Exposed for testing.
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/**
 * Get the raw token cache. Exposed for testing.
 */
export function getTokenCache(): Map<number, { token: string; expiresAt: Date }> {
  return tokenCache;
}
