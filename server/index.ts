import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { parseWebhookEvent, verifyWebhookSignature } from "./webhook.js";
import { triageNewItem } from "./triage.js";
import type { TriageConfig } from "./triage.js";
import { runBacklogScan } from "./scheduler.js";
import type { BacklogScanConfig } from "./scheduler.js";
import { isRepoScanning, queueWebhook } from "./db.js";

const app = new Hono();

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);

const triageConfig: TriageConfig = {
  dataDir: process.env.PRISM_DATA_DIR ?? "./data",
  jinaApiKey: process.env.JINA_API_KEY ?? "",
  similarityThreshold: Number.parseFloat(process.env.PRISM_SIMILARITY_THRESHOLD ?? "0.8"),
  autoClose: process.env.PRISM_AUTO_CLOSE === "true",
  autoCloseThreshold: Number.parseFloat(process.env.PRISM_AUTO_CLOSE_THRESHOLD ?? "0.95"),
};

const backlogConfig: BacklogScanConfig = {
  dataDir: triageConfig.dataDir,
  jinaApiKey: triageConfig.jinaApiKey,
  githubToken: GITHUB_TOKEN,
  similarityThreshold: triageConfig.similarityThreshold,
};

// placeholder postComment — logs to stdout until Task 8 adds real GitHub App auth
async function postComment(repo: string, number: number, body: string): Promise<void> {
  console.log(`[triage] would post comment on ${repo}#${number}:\n${body}`);
}

// placeholder closeIssue — logs to stdout until Task 8 adds real GitHub App auth
async function closeIssue(repo: string, number: number): Promise<void> {
  console.log(`[triage] would close ${repo}#${number}`);
}

// placeholder postIssue — logs to stdout until Task 8 adds real GitHub App auth
async function postIssue(repo: string, title: string, body: string): Promise<void> {
  console.log(`[backlog] would create issue on ${repo}: ${title}\n${body.slice(0, 200)}...`);
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

app.post("/webhook", async (c) => {
  const body = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? "";

  if (!WEBHOOK_SECRET) {
    console.error("[webhook] GITHUB_WEBHOOK_SECRET is not set");
    return c.json({ error: "server misconfigured" }, 500);
  }

  if (!verifyWebhookSignature(body, signature, WEBHOOK_SECRET)) {
    return c.json({ error: "invalid signature" }, 401);
  }

  const eventName = c.req.header("x-github-event") ?? "";

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  // --- handle installation events (App installed or repos added) ---
  if (eventName === "installation" || eventName === "installation_repositories") {
    const installRepos = parseInstallationRepos(eventName, payload);

    if (installRepos.length === 0) {
      return c.json({ ignored: true, reason: "no repos to scan" });
    }

    console.log(
      `[webhook] ${eventName} event: ${installRepos.map((r) => r.fullName).join(", ")}`,
    );

    if (!backlogConfig.jinaApiKey || !backlogConfig.githubToken) {
      console.warn("[backlog] JINA_API_KEY or GITHUB_TOKEN not set, skipping backlog scan");
      return c.json({ received: true, event: eventName, repos: installRepos.length, skipped: true });
    }

    // kick off backlog scans in the background (don't block webhook response)
    for (const { owner, repo, fullName } of installRepos) {
      runBacklogScan(owner, repo, backlogConfig, postIssue)
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
  if (triageConfig.jinaApiKey) {
    triageNewItem(event, triageConfig, postComment, closeIssue)
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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`pr-prism webhook server listening on port ${info.port}`);
});

export { app };
