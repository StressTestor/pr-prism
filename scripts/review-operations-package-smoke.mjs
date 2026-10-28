import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PRISM_SMOKE_FIXTURE === "1") {
  const before = Buffer.from("old\n"),
    after = Buffer.from("new\n");
  const blob = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const meta = {
    id: 1,
    number: 1,
    state: "open",
    title: "Package fixture",
    body: "Fake evidence only",
    user: { login: "fixture" },
    created_at: "2026-01-01",
    updated_at: "2026-01-02",
    head: { sha: "head" },
    base: { sha: "base" },
    changed_files: 1,
    labels: [],
  };
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    let data;
    appendFileSync(process.env.PRISM_SMOKE_TRACE, `${options.method} ${url.pathname}\n`);
    if (options.method === "POST") {
      assert.equal(url.origin, "https://model.invalid");
      data = {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                summary: "Unverified fixture",
                category: "human_review",
                findings: [],
                uncertainty: [],
              }),
            },
          },
        ],
      };
    } else {
      assert.equal(options.method, "GET");
      assert.equal(url.origin, "https://api.github.com");
      const p = url.pathname;
      if (p.endsWith("/pulls")) data = [meta];
      else if (p.endsWith("/pulls/1")) data = meta;
      else if (p.endsWith("/files"))
        data = [{ filename: "a.ts", status: "modified", sha: blob(after), patch: "@@ -1 +1 @@\n-old\n+new" }];
      else if (p.includes("/compare/")) data = { merge_base_commit: { sha: "base" } };
      else if (p.includes("/git/commits/")) {
        const sha = p.split("/").at(-1);
        data = { sha, tree: { sha: `${sha}-tree` } };
      } else if (p.includes("/git/trees/"))
        data = {
          truncated: false,
          tree: [{ path: "a.ts", mode: "100644", type: "blob", sha: blob(p.endsWith("base-tree") ? before : after) }],
        };
      else if (p.includes("/git/blobs/")) {
        const bytes = p.endsWith(blob(before)) ? before : after;
        data = { sha: blob(bytes), size: bytes.length, encoding: "base64", content: bytes.toString("base64") };
      } else if (p.endsWith("/status")) data = { state: "success", statuses: [] };
      else if (/\/(comments|reviews|timeline)$/.test(p)) data = [];
      else throw Error(`Unexpected network route: ${p}`);
    }
    return new Response(JSON.stringify(data));
  };
} else {
  const cli = resolve(process.argv[2]);
  const dir = mkdtempSync(join(tmpdir(), "prism-package-smoke-"));
  const trace = join(dir, "requests.log"),
    env = {};
  for (const name of ["PATH", "LANG", "TMPDIR", "TERM"]) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, {
    HOME: dir,
    PRISM_DATA_DIR: dir,
    PRISM_SMOKE_FIXTURE: "1",
    PRISM_SMOKE_TRACE: trace,
    GITHUB_TOKEN: "fake",
    FAKE_KEY: "fake",
    PRISM_REVIEW_ACCOUNTS: JSON.stringify([
      { id: "fixture", model: "fixture", endpoint: "https://model.invalid/chat", keyEnv: "FAKE_KEY" },
    ]),
  });
  const invoke = (flags) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          fileURLToPath(import.meta.url),
          cli,
          "review",
          "--repo",
          "example/project",
          "--type",
          "pr",
          "--json",
          ...flags,
        ],
        { cwd: dir, env, encoding: "utf8" },
      ),
    );
  assert.equal(invoke(["--all-open", "--dry-run"]).attempts.length, 0);
  const result = invoke(["--all-open", "--max-new-calls", "2", "--run-id", "package"]);
  assert.equal(result.counts.completed_current, 1);
  assert.equal(result.runs[0].spent, 2);
  const recorded = readFileSync(trace, "utf8");
  assert.equal(recorded.split("\n").filter((s) => s.startsWith("POST ")).length, 2);
  assert.equal(invoke(["--operations", "--status"]).counts.completed_current, 1);
  assert.equal(invoke(["--dashboard"]).counts.completed_current, 1);
  invoke(["--recover"]);
  assert.equal(readFileSync(trace, "utf8"), recorded);
  invoke(["--all-open", "--max-new-calls", "2", "--run-id", "package", "--resume"]);
  assert.equal(
    readFileSync(trace, "utf8")
      .split("\n")
      .filter((s) => s.startsWith("POST ")).length,
    2,
  );
  console.log(
    JSON.stringify({
      runtime: process.version,
      result: "PASS",
      dryRunPaidCalls: 0,
      fakeOutboundAttempts: 2,
      current: 1,
      inspectionRemoteCalls: 0,
      recoveryPaidCalls: 0,
      resumeExtraPaidCalls: 0,
      fixtureDirectory: dir,
    }),
  );
}
