import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadServerConfig, loadRepoConfig, DEFAULT_REPO_CONFIG } from "./config.js";
import { parseWebhookEvent, verifyWebhookSignature } from "./webhook.js";
import { triageNewItem } from "./triage.js";
import type { TriageConfig } from "./triage.js";
import { runBacklogScan, startWeeklyDigest } from "./scheduler.js";
import type { BacklogScanConfig } from "./scheduler.js";
import { getRepoStatus, isRepoScanning, queueWebhook } from "./db.js";
import {
  getInstallationOctokit,
  getInstallationToken,
  postComment as ghPostComment,
  closeIssue as ghCloseIssue,
  createIssue as ghCreateIssue,
  fetchFileContent as ghFetchFileContent,
} from "./auth.js";

const serverConfig = loadServerConfig();

// Read the GitHub App private key from disk at startup
const privateKey = readFileSync(serverConfig.githubPrivateKeyPath, "utf-8");

const app = new Hono();

/**
 * Build a TriageConfig for a specific repo by merging server-level
 * settings with per-repo settings from config.json.
 */
function triageConfigFor(owner: string, repo: string): TriageConfig {
  const repoConfig = loadRepoConfig(serverConfig.dataDir, owner, repo);
  return {
    dataDir: serverConfig.dataDir,
    jinaApiKey: serverConfig.jinaApiKey,
    similarityThreshold: repoConfig.similarityThreshold,
    autoClose: repoConfig.autoClose,
    autoCloseThreshold: repoConfig.autoCloseThreshold,
  };
}

/**
 * Get an authenticated Octokit for the given installation ID.
 * Tokens are cached for ~1 hour by the auth module.
 */
async function getOctokit(installationId: number) {
  return getInstallationOctokit(serverConfig.githubAppId, privateKey, installationId);
}

/**
 * Build callback functions bound to a specific installation.
 * These closures match the signatures expected by triageNewItem, runBacklogScan, and startWeeklyDigest.
 */
function buildCallbacks(installationId: number) {
  const postComment = async (fullName: string, number: number, body: string): Promise<void> => {
    const [owner, repo] = fullName.split("/");
    const octokit = await getOctokit(installationId);
    await ghPostComment(octokit, owner, repo, number, body);
    console.log(`[github] posted comment on ${fullName}#${number}`);
  };

  const closeIssue = async (fullName: string, number: number): Promise<void> => {
    const [owner, repo] = fullName.split("/");
    const octokit = await getOctokit(installationId);
    await ghCloseIssue(octokit, owner, repo, number);
    console.log(`[github] closed ${fullName}#${number}`);
  };

  const postIssue = async (fullName: string, title: string, body: string): Promise<void> => {
    const [owner, repo] = fullName.split("/");
    const octokit = await getOctokit(installationId);
    const num = await ghCreateIssue(octokit, owner, repo, title, body);
    console.log(`[github] created issue ${fullName}#${num}: ${title.slice(0, 80)}`);
  };

  const fetchFileContent = async (fullName: string, path: string): Promise<string | null> => {
    const [owner, repo] = fullName.split("/");
    const octokit = await getOctokit(installationId);
    return ghFetchFileContent(octokit, owner, repo, path);
  };

  return { postComment, closeIssue, postIssue, fetchFileContent };
}

/**
 * Extract the installation ID from a webhook payload.
 * Every GitHub App webhook includes installation.id.
 */
function extractInstallationId(payload: Record<string, unknown>): number | null {
  const installation = payload.installation as Record<string, unknown> | undefined;
  if (!installation || typeof installation.id !== "number") return null;
  return installation.id;
}

/**
 * Parse repos from installation webhook payloads.
 * Returns array of { owner, repo, fullName } objects.
 */
function parseInstallationRepos(
  eventName: string,
  payload: Record<string, unknown>,
): Array<{ owner: string; repo: string; fullName: string }> {
  const repos: Array<{ owner: string; repo: string; fullName: string }> = [];

  if (eventName === "installation" && payload.action === "created") {
    // App first installed — all repos from the installation
    const installRepos = (payload.repositories ?? []) as Array<Record<string, unknown>>;
    for (const r of installRepos) {
      const fullName = r.full_name as string;
      if (!fullName) continue;
      const [owner, repo] = fullName.split("/");
      repos.push({ owner, repo, fullName });
    }
  } else if (eventName === "installation_repositories" && payload.action === "added") {
    // Repos added to existing installation
    const added = (payload.repositories_added ?? []) as Array<Record<string, unknown>>;
    for (const r of added) {
      const fullName = r.full_name as string;
      if (!fullName) continue;
      const [owner, repo] = fullName.split("/");
      repos.push({ owner, repo, fullName });
    }
  }

  return repos;
}

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

app.get("/status/:owner/:repo", (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");

  const status = getRepoStatus(serverConfig.dataDir, owner, repo);
  const scanning = isRepoScanning(owner, repo);

  return c.json({
    repo: `${owner}/${repo}`,
    status: status.lastSyncTime ? "ready" : "pending",
    totalItems: status.itemCount,
    embeddingCount: status.embeddingCount,
    lastSync: status.lastSyncTime ?? null,
    scanning,
  });
});

app.post("/webhook", async (c) => {
  const body = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? "";

  if (!verifyWebhookSignature(body, signature, serverConfig.githubWebhookSecret)) {
    return c.json({ error: "invalid signature" }, 401);
  }

  const eventName = c.req.header("x-github-event") ?? "";

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  // extract installation ID (present on every GitHub App webhook)
  const installationId = extractInstallationId(payload);
  if (!installationId) {
    return c.json({ error: "missing installation.id in payload" }, 400);
  }

  const callbacks = buildCallbacks(installationId);

  // --- handle installation events (App installed or repos added) ---
  if (eventName === "installation" || eventName === "installation_repositories") {
    const installRepos = parseInstallationRepos(eventName, payload);

    if (installRepos.length === 0) {
      return c.json({ ignored: true, reason: "no repos to scan" });
    }

    console.log(
      `[webhook] ${eventName} event: ${installRepos.map((r) => r.fullName).join(", ")}`,
    );

    // get a raw installation token for the backlog scan's GitHubClient (REST)
    const installToken = await getInstallationToken(
      serverConfig.githubAppId, privateKey, installationId,
    );

    // kick off backlog scans in the background (don't block webhook response)
    for (const { owner, repo, fullName } of installRepos) {
      const repoConfig = loadRepoConfig(serverConfig.dataDir, owner, repo);
      const backlogConfig: BacklogScanConfig = {
        dataDir: serverConfig.dataDir,
        jinaApiKey: serverConfig.jinaApiKey,
        githubToken: installToken,
        similarityThreshold: repoConfig.similarityThreshold,
      };

      runBacklogScan(owner, repo, backlogConfig, callbacks.postIssue, {
          postComment: callbacks.postComment,
          closeIssue: callbacks.closeIssue,
          fetchFileContent: callbacks.fetchFileContent,
        })
        .then(() => {
          console.log(`[backlog] ${fullName}: backlog scan completed successfully`);
        })
        .catch((err) => {
          console.error(`[backlog] ${fullName}: backlog scan failed:`, err);
        });
    }

    return c.json({ received: true, event: eventName, repos: installRepos.length });
  }

  // --- handle issue/PR opened events ---
  const event = parseWebhookEvent(eventName, payload);

  if (!event) {
    return c.json({ ignored: true });
  }

  // if repo is mid-scan, queue the event instead of triaging immediately
  if (isRepoScanning(event.repo.owner, event.repo.name)) {
    queueWebhook(event.repo.owner, event.repo.name, event);
    console.log(
      `[webhook] ${event.eventType}#${event.number} in ${event.repo.fullName} queued (backlog scan in progress)`,
    );
    return c.json({ received: true, queued: true, event: event.eventType, number: event.number });
  }

  console.log(
    `[webhook] ${event.eventType}#${event.number} opened in ${event.repo.fullName} by ${event.sender}`,
  );

  // triage in the background so the webhook responds quickly
  const triageConfig = triageConfigFor(event.repo.owner, event.repo.name);

  if (triageConfig.jinaApiKey) {
    triageNewItem(event, triageConfig, callbacks.postComment, callbacks.closeIssue, callbacks.fetchFileContent)
      .then((result) => {
        if (result.commented) {
          console.log(
            `[triage] ${event.repo.fullName}#${event.number}: ${result.matches.length} dupes found, commented in ${result.elapsedMs.toFixed(0)}ms`,
          );
        } else {
          console.log(
            `[triage] ${event.repo.fullName}#${event.number}: no dupes above threshold`,
          );
        }
      })
      .catch((err) => {
        console.error(`[triage] error processing ${event.repo.fullName}#${event.number}:`, err);
      });
  } else {
    console.warn("[triage] JINA_API_KEY not set, skipping triage");
  }

  return c.json({ received: true, event: event.eventType, number: event.number });
});

// start weekly digest cron using default repo config thresholds
// weekly digest doesn't have an installation context at cron time,
// so we log a warning instead of posting if no installation is available
startWeeklyDigest(
  {
    dataDir: serverConfig.dataDir,
    similarityThreshold: DEFAULT_REPO_CONFIG.similarityThreshold,
    autoClose: DEFAULT_REPO_CONFIG.autoClose,
  },
  async (fullName: string, title: string, body: string): Promise<void> => {
    // the weekly digest fires on a cron, not from a webhook, so we don't have
    // an installation ID in context. we need to look it up from cached tokens
    // or use the app-level API to find the installation for this repo.
    const [owner, repo] = fullName.split("/");
    try {
      const { Octokit } = await import("@octokit/rest");
      const { createAppAuth } = await import("@octokit/auth-app");
      const appOctokit = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId: serverConfig.githubAppId, privateKey },
      });
      const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({
        owner,
        repo,
      });
      const octokit = await getOctokit(installation.id);
      const num = await ghCreateIssue(octokit, owner, repo, title, body);
      console.log(`[digest] created issue ${fullName}#${num}: ${title.slice(0, 80)}`);
    } catch (err) {
      console.error(`[digest] failed to post issue to ${fullName}:`, err);
    }
  },
);

serve({ fetch: app.fetch, port: serverConfig.port }, (info) => {
  console.log(`pr-prism webhook server listening on port ${info.port}`);
});

export { app };
