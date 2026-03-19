import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { parseWebhookEvent, verifyWebhookSignature } from "./webhook.js";

const app = new Hono();

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);

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

  // TODO: Task 3 wires triage logic here

  return c.json({ received: true, event: event.eventType, number: event.number });
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`pr-prism webhook server listening on port ${info.port}`);
});

export { app };
