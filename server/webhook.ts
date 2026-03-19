import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookEvent {
  action: string;
  eventType: "issues" | "pull_request";
  number: number;
  title: string;
  body: string;
  repo: {
    owner: string;
    name: string;
    fullName: string;
  };
  sender: string;
}

/**
 * Verify a GitHub webhook signature (HMAC-SHA256).
 * Returns true if the signature is valid, false otherwise.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string | undefined | null,
  secret: string,
): boolean {
  if (!signature) return false;

  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;

  const sig = signature.slice(prefix.length);

  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(sig, "hex");
  } catch {
    return false;
  }

  const expected = createHmac("sha256", secret).update(payload).digest();

  if (sigBytes.length !== expected.length) return false;

  return timingSafeEqual(sigBytes, expected);
}

/**
 * Parse a GitHub webhook payload into a WebhookEvent.
 * Returns null for events we don't care about (anything other than
 * issues.opened and pull_request.opened).
 */
export function parseWebhookEvent(
  eventName: string,
  payload: Record<string, unknown>,
): WebhookEvent | null {
  const action = payload.action as string | undefined;

  if (action !== "opened") return null;

  if (eventName === "issues") {
    const issue = payload.issue as Record<string, unknown> | undefined;
    const repo = payload.repository as Record<string, unknown> | undefined;
    const sender = payload.sender as Record<string, unknown> | undefined;

    if (!issue || !repo || !sender) return null;

    const owner = repo.owner as Record<string, unknown>;

    return {
      action: "opened",
      eventType: "issues",
      number: issue.number as number,
      title: issue.title as string,
      body: (issue.body as string) ?? "",
      repo: {
        owner: (owner.login as string) ?? "",
        name: repo.name as string,
        fullName: repo.full_name as string,
      },
      sender: sender.login as string,
    };
  }

  if (eventName === "pull_request") {
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    const repo = payload.repository as Record<string, unknown> | undefined;
    const sender = payload.sender as Record<string, unknown> | undefined;

    if (!pr || !repo || !sender) return null;

    const owner = repo.owner as Record<string, unknown>;

    return {
      action: "opened",
      eventType: "pull_request",
      number: pr.number as number,
      title: pr.title as string,
      body: (pr.body as string) ?? "",
      repo: {
        owner: (owner.login as string) ?? "",
        name: repo.name as string,
        fullName: repo.full_name as string,
      },
      sender: sender.login as string,
    };
  }

  return null;
}
