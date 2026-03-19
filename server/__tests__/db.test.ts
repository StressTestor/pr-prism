import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  drainWebhookQueue,
  getRepoDBPath,
  getRepoStatus,
  isRepoScanning,
  openRepoDB,
  queueWebhook,
  setRepoScanning,
} from "../db.js";

describe("getRepoDBPath", () => {
  it("returns correct path", () => {
    const result = getRepoDBPath("/data", "octocat", "hello-world");
    expect(result).toBe(join("/data", "octocat-hello-world", "prism.db"));
  });

  it("handles nested-looking owner names", () => {
    const result = getRepoDBPath("/srv/prism", "my-org", "my-repo");
    expect(result).toBe(join("/srv/prism", "my-org-my-repo", "prism.db"));
  });
});

describe("openRepoDB", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    tmpDirs.length = 0;
  });

  it("creates directory and returns a VectorStore", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "prism-db-test-"));
    tmpDirs.push(dataDir);

    const store = openRepoDB(dataDir, "octocat", "hello-world", 4);
    expect(store).toBeDefined();
    // VectorStore has setMeta/getMeta — use them to prove it works
    store.setMeta("test", "value");
    expect(store.getMeta("test")).toBe("value");
    store.close();
  });

  it("opens same DB on second call (idempotent)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "prism-db-test-"));
    tmpDirs.push(dataDir);

    const store1 = openRepoDB(dataDir, "octocat", "hello-world", 4);
    store1.setMeta("persist", "yes");
    store1.close();

    const store2 = openRepoDB(dataDir, "octocat", "hello-world", 4);
    expect(store2.getMeta("persist")).toBe("yes");
    store2.close();
  });
});

describe("getRepoStatus", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    tmpDirs.length = 0;
  });

  it("returns zeros for empty DB", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "prism-db-test-"));
    tmpDirs.push(dataDir);

    // create the DB so it exists but has no items
    const store = openRepoDB(dataDir, "octocat", "hello-world", 4);
    store.close();

    const status = getRepoStatus(dataDir, "octocat", "hello-world");
    expect(status.itemCount).toBe(0);
    expect(status.embeddingCount).toBe(0);
    expect(status.lastSyncTime).toBeUndefined();
  });

  it("returns zeros when DB does not exist", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "prism-db-test-"));
    tmpDirs.push(dataDir);

    const status = getRepoStatus(dataDir, "ghost", "missing");
    expect(status.itemCount).toBe(0);
    expect(status.embeddingCount).toBe(0);
    expect(status.lastSyncTime).toBeUndefined();
  });

  it("returns last_sync when set", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "prism-db-test-"));
    tmpDirs.push(dataDir);

    const store = openRepoDB(dataDir, "octocat", "hello-world", 4);
    store.setMeta("last_sync", "2026-03-18T00:00:00Z");
    store.close();

    const status = getRepoStatus(dataDir, "octocat", "hello-world");
    expect(status.lastSyncTime).toBe("2026-03-18T00:00:00Z");
  });
});

describe("scanning flag", () => {
  it("defaults to false", () => {
    expect(isRepoScanning("nobody", "nothing")).toBe(false);
  });

  it("set true, check, clear, check", () => {
    setRepoScanning("octocat", "repo", true);
    expect(isRepoScanning("octocat", "repo")).toBe(true);

    setRepoScanning("octocat", "repo", false);
    expect(isRepoScanning("octocat", "repo")).toBe(false);
  });

  it("repos are independent", () => {
    setRepoScanning("a", "x", true);
    setRepoScanning("b", "y", false);
    expect(isRepoScanning("a", "x")).toBe(true);
    expect(isRepoScanning("b", "y")).toBe(false);
    // cleanup
    setRepoScanning("a", "x", false);
  });
});

describe("webhook queue", () => {
  it("queue, drain, verify empty after drain", () => {
    queueWebhook("octocat", "repo", { action: "opened", number: 1 });
    queueWebhook("octocat", "repo", { action: "opened", number: 2 });

    const events = drainWebhookQueue("octocat", "repo");
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ action: "opened", number: 1 });
    expect(events[1]).toEqual({ action: "opened", number: 2 });

    // queue should be empty now
    const again = drainWebhookQueue("octocat", "repo");
    expect(again).toHaveLength(0);
  });

  it("drain on empty queue returns empty array", () => {
    const events = drainWebhookQueue("ghost", "nope");
    expect(events).toEqual([]);
  });

  it("queues are per-repo", () => {
    queueWebhook("a", "x", { n: 1 });
    queueWebhook("b", "y", { n: 2 });

    const aEvents = drainWebhookQueue("a", "x");
    const bEvents = drainWebhookQueue("b", "y");
    expect(aEvents).toEqual([{ n: 1 }]);
    expect(bEvents).toEqual([{ n: 2 }]);
  });
});
