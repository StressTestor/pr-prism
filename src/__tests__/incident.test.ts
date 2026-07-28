import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { isIncidentClosed } from "../incident.js";
import { itemMetadata } from "../pipeline.js";

const INCIDENT = {
  start: "2026-07-23T00:00:00Z",
  end: "2026-07-24T00:00:00Z",
  reason: "repository visibility flip auto-closed all open PRs",
};

describe("isIncidentClosed", () => {
  it("classifies a PR closed inside an incident window as incident-closed", () => {
    const item = { state: "closed", closedAt: "2026-07-23T10:18:00Z" };

    expect(isIncidentClosed(item, [INCIDENT])).toBe(true);
  });
});

describe("incident windows in config", () => {
  it("parses an incidents block into typed windows", () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-incident-"));
    const path = join(dir, "prism.config.yaml");
    writeFileSync(
      path,
      [
        "repo: odysseus-dev/odysseus",
        "incidents:",
        '  - start: "2026-07-23T00:00:00Z"',
        '    end: "2026-07-24T00:00:00Z"',
        '    reason: "repository visibility flip auto-closed all open PRs"',
      ].join("\n"),
    );

    try {
      const config = loadConfig(path);
      expect(config.incidents).toEqual([INCIDENT]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("itemMetadata", () => {
  it("persists closedAt so incident windows can be re-evaluated without a rescan", () => {
    const item = {
      number: 5559,
      type: "pr" as const,
      repo: "odysseus-dev/odysseus",
      title: "fix(rag): skip hidden dirs",
      body: "",
      state: "closed",
      author: "stresstestor",
      createdAt: "2026-07-20T00:00:00Z",
      updatedAt: "2026-07-23T10:18:00Z",
      closedAt: "2026-07-23T10:18:00Z",
      labels: [],
    };

    expect(itemMetadata(item).closedAt).toBe("2026-07-23T10:18:00Z");
  });
});
