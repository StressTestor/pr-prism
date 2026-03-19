import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseWebhookEvent, verifyWebhookSignature } from "../webhook.js";

const TEST_SECRET = "test-webhook-secret-1234";

function sign(payload: string, secret: string = TEST_SECRET): string {
  const hmac = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${hmac}`;
}

// --- verifyWebhookSignature ---

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature", () => {
    const payload = '{"action":"opened"}';
    const sig = sign(payload);
    expect(verifyWebhookSignature(payload, sig, TEST_SECRET)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const payload = '{"action":"opened"}';
    const sig = sign(payload, "wrong-secret");
    expect(verifyWebhookSignature(payload, sig, TEST_SECRET)).toBe(false);
  });

  it("rejects a missing signature", () => {
    const payload = '{"action":"opened"}';
    expect(verifyWebhookSignature(payload, undefined, TEST_SECRET)).toBe(false);
    expect(verifyWebhookSignature(payload, null, TEST_SECRET)).toBe(false);
    expect(verifyWebhookSignature(payload, "", TEST_SECRET)).toBe(false);
  });

  it("rejects a signature without the sha256= prefix", () => {
    const payload = '{"action":"opened"}';
    const hmac = createHmac("sha256", TEST_SECRET).update(payload).digest("hex");
    expect(verifyWebhookSignature(payload, hmac, TEST_SECRET)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const original = '{"action":"opened"}';
    const sig = sign(original);
    const tampered = '{"action":"closed"}';
    expect(verifyWebhookSignature(tampered, sig, TEST_SECRET)).toBe(false);
  });
});

// --- parseWebhookEvent ---

function makeIssuePayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    issue: {
      number: 42,
      title: "Bug: login broken",
      body: "Login page 500s on submit",
    },
    repository: {
      name: "my-repo",
      full_name: "octocat/my-repo",
      owner: { login: "octocat" },
    },
    sender: { login: "contributor" },
    ...overrides,
  };
}

function makePRPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    pull_request: {
      number: 99,
      title: "Fix auth redirect",
      body: "Resolves #42",
    },
    repository: {
      name: "my-repo",
      full_name: "octocat/my-repo",
      owner: { login: "octocat" },
    },
    sender: { login: "contributor" },
    ...overrides,
  };
}

describe("parseWebhookEvent", () => {
  it("parses issues.opened", () => {
    const event = parseWebhookEvent("issues", makeIssuePayload());
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe("issues");
    expect(event!.action).toBe("opened");
    expect(event!.number).toBe(42);
    expect(event!.title).toBe("Bug: login broken");
    expect(event!.body).toBe("Login page 500s on submit");
    expect(event!.repo.owner).toBe("octocat");
    expect(event!.repo.name).toBe("my-repo");
    expect(event!.repo.fullName).toBe("octocat/my-repo");
    expect(event!.sender).toBe("contributor");
  });

  it("parses pull_request.opened", () => {
    const event = parseWebhookEvent("pull_request", makePRPayload());
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe("pull_request");
    expect(event!.action).toBe("opened");
    expect(event!.number).toBe(99);
    expect(event!.title).toBe("Fix auth redirect");
    expect(event!.body).toBe("Resolves #42");
    expect(event!.repo.owner).toBe("octocat");
    expect(event!.repo.name).toBe("my-repo");
    expect(event!.sender).toBe("contributor");
  });

  it("returns null for issues.closed", () => {
    const payload = makeIssuePayload({ action: "closed" });
    expect(parseWebhookEvent("issues", payload)).toBeNull();
  });

  it("returns null for pull_request.synchronize", () => {
    const payload = makePRPayload({ action: "synchronize" });
    expect(parseWebhookEvent("pull_request", payload)).toBeNull();
  });

  it("returns null for irrelevant event types", () => {
    expect(parseWebhookEvent("push", { action: "opened" })).toBeNull();
    expect(parseWebhookEvent("star", { action: "created" })).toBeNull();
    expect(parseWebhookEvent("ping", {})).toBeNull();
  });

  it("handles null body gracefully", () => {
    const payload = makePRPayload();
    (payload.pull_request as Record<string, unknown>).body = null;
    const event = parseWebhookEvent("pull_request", payload);
    expect(event).not.toBeNull();
    expect(event!.body).toBe("");
  });
});
