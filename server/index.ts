import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { parseWebhookEvent, verifyWebhookSignature } from "./webhook.js";
import { triageNewItem } from "./triage.js";
import type { TriageConfig } from "./triage.js";

const app = new Hono();

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);

const triageConfig: TriageConfig = {
  dataDir: process.env.PRISM_DATA_DIR ?? "./data",
  jinaApiKey: process.env.JINA_API_KEY ?? "",
  similarityThreshold: Number.parseFloat(process.env.PRISM_SIMILARITY_THRESHOLD ?? "0.8"),
  autoClose: process.env.PRISM_AUTO_CLOSE === "true",
  autoCloseThreshold: Number.parseFloat(process.env.PRISM_AUTO_CLOSE_THRESHOLD ?? "0.95"),
};

// placeholder postComment — logs to stdout until Task 8 adds real GitHub App auth
async function postComment(repo: string, number: number, body: string): Promise<void> {
  console.log(`[triage] would post comment on ${repo}#${number}:\n${body}`);
}

// placeholder closeIssue — logs to stdout until Task 8 adds real GitHub App auth
async function closeIssue(repo: string, number: number): Promise<void> {
  console.log(`[triage] would close ${repo}#${number}`);
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

  const event = parseWebhookEvent(eventName, payload);

  if (!event) {
    return c.json({ ignored: true });
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
