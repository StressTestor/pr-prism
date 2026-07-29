import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { compileIncidentWindows, isIncidentClosed } from "../incident.js";
import { itemMetadata } from "../metadata.js";

const INCIDENT = {
  start: "2026-07-23T00:00:00Z",
  end: "2026-07-24T00:00:00Z",
  reason: "repository visibility flip auto-closed all open PRs",
};

describe("isIncidentClosed", () => {
  it("classifies a PR closed inside an incident window as incident-closed", () => {
    const item = { state: "closed", closedAt: "2026-07-23T10:18:00Z" };

    expect(isIncidentClosed(item, compileIncidentWindows([INCIDENT]))).toBe(true);
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

describe("incident window validation", () => {
  function writeConfig(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "prism-incident-"));
    const path = join(dir, "prism.config.yaml");
    writeFileSync(path, `repo: odysseus-dev/odysseus\nincidents:\n${body}`);
    return path;
  }

  it("rejects a window without an explicit UTC offset, which would parse in the host timezone", () => {
    const path = writeConfig('  - start: "2026-07-23T00:00:00"\n    end: "2026-07-24T00:00:00Z"\n    reason: "x"\n');

    expect(() => loadConfig(path)).toThrow(/offset/i);
  });

  it("rejects an unparseable timestamp instead of silently matching nothing", () => {
    const path = writeConfig('  - start: "last tuesday"\n    end: "2026-07-24T00:00:00Z"\n    reason: "x"\n');

    expect(() => loadConfig(path)).toThrow();
  });

  it("rejects a window whose end precedes its start", () => {
    const path = writeConfig('  - start: "2026-07-24T00:00:00Z"\n    end: "2026-07-23T00:00:00Z"\n    reason: "x"\n');

    expect(() => loadConfig(path)).toThrow(/end/i);
  });
});

describe("compileIncidentWindows", () => {
  it("rejects an unparseable bound instead of skipping the window", () => {
    // Config validation catches this on the CLI path, but VectorStore accepts
    // windows from any caller. Silently ignoring a malformed window is the
    // same no-op the config layer exists to prevent, just later and quieter.
    expect(() => compileIncidentWindows([{ start: "nonsense", end: "2026-07-24T00:00:00Z", reason: "x" }])).toThrow(
      /nonsense/,
    );
  });

  it("rejects an inverted window", () => {
    expect(() =>
      compileIncidentWindows([{ start: "2026-07-24T00:00:00Z", end: "2026-07-23T00:00:00Z", reason: "x" }]),
    ).toThrow(/after its start/);
  });

  it("names the offending window so a long list is searchable", () => {
    expect(() =>
      compileIncidentWindows([
        { start: "2026-07-23T00:00:00Z", end: "2026-07-24T00:00:00Z", reason: "fine" },
        { start: "broken", end: "2026-07-24T00:00:00Z", reason: "the bad one" },
      ]),
    ).toThrow(/the bad one/);
  });

  it("parses bounds once, so matching does not re-parse per item", () => {
    const [w] = compileIncidentWindows([
      { start: "2026-07-23T09:00:00Z", end: "2026-07-23T11:00:00Z", reason: "flip" },
    ]);
    expect(w.start).toBe(Date.parse("2026-07-23T09:00:00Z"));
    expect(w.end).toBe(Date.parse("2026-07-23T11:00:00Z"));
  });
});
