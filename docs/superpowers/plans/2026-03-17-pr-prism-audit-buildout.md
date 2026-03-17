# PR Prism Full Audit & Build-Out Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden PR Prism's error handling, expand test coverage, extract pipeline for programmatic use, add GitHub Action integration, Docker distribution, and quality-of-life features.

**Architecture:** Extract pipeline business logic from cli.ts into pipeline.ts so it can be consumed by the CLI, GitHub Action, and programmatic imports independently. Fix error handling gaps across embedding, LLM, and storage layers. Add a JavaScript GitHub Action that auto-triages PRs and posts comments.

**Tech Stack:** TypeScript, SQLite + sqlite-vec, Vitest, Commander.js, @actions/core + @actions/github, Docker

---

## File Structure

### Files to create:
- `src/pipeline.ts` - extracted pipeline functions (runScan, runDupes, runRank, runVision, runReport, createPipelineContext)
- `src/__tests__/reviewer.test.ts` - LLM reviewer test suite
- `src/__tests__/errors.test.ts` - ProviderError and classify functions tests
- `src/__tests__/pipeline.test.ts` - pipeline integration tests
- `action/index.ts` - GitHub Action entry point
- `action/action.yml` - GitHub Action metadata
- `action/tsconfig.json` - Action TypeScript config
- `Dockerfile` - Docker image for prism CLI
- `.dockerignore` - Docker build context exclusions

### Files to modify:
- `src/cli.ts` - slim down to thin CLI wrapper importing from pipeline.ts
- `src/index.ts` - update barrel exports to use pipeline.ts
- `src/types.ts` - add PipelineContext interface
- `src/errors.ts` - add formatZodError helper
- `src/embeddings.ts` - add response validation
- `src/reviewer.ts` - handle empty/refusal LLM responses
- `src/store.ts` - add SQLite BUSY handling, author cache table
- `src/cluster.ts` - replace inline scoring with scorePR import
- `src/scorer.ts` - add cache-aware buildScorerContext
- `src/config.ts` - improve Zod error formatting
- `package.json` - npm audit fix, add action build script
- `README.md` - update with new features (GitHub Action, Docker, compare)
- `CHANGELOG.md` - add new version entry

---

## Chunk 1: Error Handling & Hardening (Tasks 1-4)

### Task 1: Fix embedding response validation

**Files:**
- Modify: `src/embeddings.ts`
- Create: `src/__tests__/errors.test.ts`
- Modify: `src/errors.ts`

- [ ] **Step 1: Write tests for existing error classification functions**

In `src/__tests__/errors.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ProviderError, classifyFetchError, classifyHttpError } from "../errors.js";

describe("ProviderError", () => {
  it("formats with provider, reason, and remedy", () => {
    const err = new ProviderError("Ollama", "Connection refused", "Start Ollama with: ollama serve");
    expect(err.provider).toBe("Ollama");
    expect(err.reason).toBe("Connection refused");
    expect(err.remedy).toBe("Start Ollama with: ollama serve");
    expect(err.message).toBe("Ollama: Connection refused");
  });
});

describe("classifyFetchError", () => {
  it("classifies ECONNREFUSED for Ollama", () => {
    const err = classifyFetchError("Ollama", { code: "ECONNREFUSED" });
    expect(err.reason).toBe("Connection refused");
    expect(err.remedy).toContain("ollama serve");
  });

  it("classifies ENOTFOUND as network error", () => {
    const err = classifyFetchError("Jina", { code: "ENOTFOUND" });
    expect(err.reason).toContain("Cannot reach");
  });

  it("classifies timeout errors", () => {
    const err = classifyFetchError("OpenAI", { code: "ETIMEDOUT" });
    expect(err.reason).toContain("timed out");
  });

  it("passes through existing ProviderErrors", () => {
    const original = new ProviderError("Test", "original", "fix");
    const result = classifyFetchError("Test", original);
    expect(result).toBe(original);
  });
});

describe("classifyHttpError", () => {
  it("classifies 401 as invalid API key", () => {
    const err = classifyHttpError("OpenAI", 401, "Unauthorized");
    expect(err.reason).toBe("Invalid API key");
  });

  it("classifies 404 for Ollama as model not found", () => {
    const err = classifyHttpError("Ollama", 404, "model 'foo' not found");
    expect(err.reason).toContain("Model not found");
    expect(err.remedy).toContain("ollama pull");
  });

  it("classifies 429 as rate limited", () => {
    const err = classifyHttpError("Jina", 429, "Too many requests");
    expect(err.reason).toBe("Rate limited");
  });

  it("classifies 5xx as server error", () => {
    const err = classifyHttpError("OpenAI", 502, "Bad Gateway");
    expect(err.reason).toContain("Server error");
  });
});
```

- [ ] **Step 2: Run test to verify it passes (these test existing code)**

Run: `cd /Volumes/onn/pr-prism-working-directory && npx vitest run src/__tests__/errors.test.ts`
Expected: PASS (these test existing ProviderError code)

- [ ] **Step 3: Add response validation to embedding providers**

In `src/embeddings.ts`, add `import { ProviderError } from "./errors.js";` at the top.

In `OpenAIEmbeddings.embedBatch`, after `const data = (await resp.json()) as any;`, add:

```typescript
if (!data?.data || !Array.isArray(data.data)) {
  throw new ProviderError(
    "OpenAI Embeddings",
    "Malformed response: missing data array",
    "Check EMBEDDING_MODEL is a valid embedding model, not a chat model",
  );
}
```

In `OllamaEmbeddings.embedBatch`, after `const data = (await resp.json()) as any;`, add:

```typescript
if (!data?.embeddings || !Array.isArray(data.embeddings)) {
  throw new ProviderError(
    "Ollama",
    "Malformed response: missing embeddings array",
    `Check that ${this.model} is an embedding model. Try: ollama pull qwen3-embedding:0.6b`,
  );
}
```

In `VoyageEmbeddings.embedBatch`, after `const data = (await resp.json()) as any;`, add:

```typescript
if (!data?.data || !Array.isArray(data.data) || data.data.length === 0) {
  throw new ProviderError(
    "VoyageAI",
    "Malformed response: missing data array",
    "Check EMBEDDING_MODEL is valid. See https://docs.voyageai.com/docs/embeddings",
  );
}
```

- [ ] **Step 4: Run all tests to verify nothing broke**

Run: `cd /Volumes/onn/pr-prism-working-directory && npx vitest run`
Expected: All 78+ tests PASS

- [ ] **Step 5: Commit**

```
git add src/embeddings.ts src/errors.ts src/__tests__/errors.test.ts
git commit -m "fix: validate embedding API responses before accessing data"
```

---

### Task 2: Fix LLM reviewer empty/refusal handling

**Files:**
- Modify: `src/reviewer.ts`
- Create: `src/__tests__/reviewer.test.ts`

- [ ] **Step 1: Write tests for reviewer edge cases**

Create `src/__tests__/reviewer.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { reviewPR } from "../reviewer.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockLLMResponse(content: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => content,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  });
}

describe("reviewPR", () => {
  const llmConfig = { provider: "openai", apiKey: "test-key", model: "gpt-4o-mini" };

  it("parses valid JSON response", async () => {
    const validResponse = JSON.stringify({
      summary: "Adds feature X",
      concerns: ["No tests"],
      recommendation: "revise",
      confidence: 0.7,
    });
    mockLLMResponse(validResponse);

    const result = await reviewPR("Add X", "Description", "diff content", llmConfig);
    expect(result.summary).toBe("Adds feature X");
    expect(result.recommendation).toBe("revise");
    expect(result.confidence).toBe(0.7);
  });

  it("handles empty choices array", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
      text: async () => "",
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
      text: async () => "",
    });

    await expect(reviewPR("Test", "Body", "diff", llmConfig)).rejects.toThrow();
  });

  it("handles API error with ProviderError", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    await expect(reviewPR("Test", "Body", "diff", llmConfig)).rejects.toThrow("Invalid API key");
  });

  it("validates response against zod schema", async () => {
    const invalidResponse = JSON.stringify({
      summary: "test",
      concerns: "not an array",
      recommendation: "invalid",
      confidence: 2.0,
    });
    mockLLMResponse(invalidResponse);

    await expect(reviewPR("Test", "Body", "diff", llmConfig)).rejects.toThrow();
  });

  it("truncates diff longer than 50KB", async () => {
    const longDiff = "a".repeat(60_000);
    const validResponse = JSON.stringify({
      summary: "test",
      concerns: [],
      recommendation: "merge",
      confidence: 0.9,
    });
    mockLLMResponse(validResponse);

    const result = await reviewPR("Test", "Body", longDiff, llmConfig);
    expect(result.recommendation).toBe("merge");
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const prompt = callBody.messages[1].content;
    expect(prompt).toContain("[DIFF TRUNCATED]");
  });
});
```

- [ ] **Step 2: Run tests to see which fail**

Run: `cd /Volumes/onn/pr-prism-working-directory && npx vitest run src/__tests__/reviewer.test.ts`
Expected: Some tests fail (empty choices)

- [ ] **Step 3: Fix empty choices handling in reviewer.ts**

In `src/reviewer.ts`, add import at top: `import { ProviderError } from "./errors.js";`

In `OpenAILLM.complete`, after `const data = (await resp.json()) as any;`, add:

```typescript
if (!data?.choices?.length) {
  throw new ProviderError(
    "LLM",
    "Empty response from model (no choices returned)",
    "The model may have refused the request. Try a different model.",
  );
}
```

Do the same in `OpenAILLM.completeJSON`.

In `AnthropicLLM.complete`, after `const data = (await resp.json()) as any;`, add:

```typescript
if (!data?.content?.length) {
  throw new ProviderError(
    "Anthropic",
    "Empty response from model",
    "The model may have refused the request. Try a different model.",
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/onn/pr-prism-working-directory && npx vitest run src/__tests__/reviewer.test.ts`
Expected: All PASS

- [ ] **Step 5: Run full test suite**

Run: `cd /Volumes/onn/pr-prism-working-directory && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```
git add src/reviewer.ts src/__tests__/reviewer.test.ts
git commit -m "fix: handle empty and malformed LLM responses in reviewer"
```

---

### Task 3: Fix SQLite BUSY handling and config error formatting

**Files:**
- Modify: `src/store.ts`
- Modify: `src/config.ts`
- Modify: `src/errors.ts`

- [ ] **Step 1: Add SQLite BUSY/LOCKED handling to store.ts**

In `src/store.ts`, in the constructor, after `this.db = new Database(p);`, add:

```typescript
this.db.pragma("busy_timeout = 5000");
```

- [ ] **Step 2: Add Zod error formatting helper to errors.ts**

In `src/errors.ts`, add:

```typescript
export function formatZodError(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as any).issues;
    if (Array.isArray(issues)) {
      return issues
        .map((i: any) => {
          const path = i.path?.join(".") || "root";
          return `  ${path}: ${i.message}`;
        })
        .join("\n");
    }
  }
  return String(error);
}
```

- [ ] **Step 3: Use formatZodError in config.ts loadConfig**

Wrap the `ConfigSchema.parse(raw)` call in a try/catch:

```typescript
let parsed: PrismConfig;
try {
  parsed = ConfigSchema.parse(raw);
} catch (e: any) {
  if (e?.issues) {
    throw new Error(`invalid config at ${p}:\n${formatZodError(e)}`);
  }
  throw e;
}
```

Import `formatZodError` from `./errors.js`.

- [ ] **Step 4: Use formatZodError in config.ts loadEnvConfig**

Wrap `EnvSchema.parse(process.env)`:

```typescript
try {
  return EnvSchema.parse(process.env);
} catch (e: any) {
  if (e?.issues) {
    throw new Error(`invalid environment config:\n${formatZodError(e)}\n\ncheck your .env file or run \`prism init\``);
  }
  throw e;
}
```

- [ ] **Step 5: Add YAML parse error handling in loadConfig**

Wrap `parseYaml`:

```typescript
let raw: any;
try {
  raw = parseYaml(readFileSync(p, "utf-8"));
} catch (e: any) {
  throw new Error(`failed to parse ${p}: ${e.message || "invalid YAML syntax"}`);
}
```

- [ ] **Step 6: Add test for invalid YAML config**

In `src/__tests__/config.test.ts`, add:

```typescript
it("throws formatted error for invalid YAML", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "prism-test-"));
  const configPath = join(tmpDir, "prism.config.yaml");
  writeFileSync(configPath, "invalid: yaml: [broken");
  expect(() => loadConfig(configPath)).toThrow("failed to parse");
  rmSync(tmpDir, { recursive: true });
});
```

Add necessary imports at top of test file.

- [ ] **Step 7: Run all tests**

Run: `cd /Volumes/onn/pr-prism-working-directory && npx vitest run`
Expected: All PASS

- [ ] **Step 8: Commit**

```
git add src/store.ts src/config.ts src/errors.ts src/__tests__/config.test.ts
git commit -m "fix: handle SQLite BUSY, format Zod and YAML errors for humans"
```

---

### Task 4: npm audit fix

**Files:**
- Modify: `package-lock.json`

- [ ] **Step 1: Run npm audit fix**

Run: `npm audit fix`
Expected: 0 vulnerabilities

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 3: Commit**

```
git add package-lock.json package.json
git commit -m "fix: resolve npm audit vulnerability (rollup dev dep)"
```

---

## Chunk 2: Pipeline Extraction & DRY Fixes (Tasks 5-7)

### Task 5: Extract pipeline functions to src/pipeline.ts

**Files:**
- Create: `src/pipeline.ts`
- Modify: `src/cli.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add PipelineContext to types.ts**

Add the PipelineContext interface at the end of types.ts. Use `import type` for all imports to avoid circular dependencies:

```typescript
export interface PipelineContext {
  config: import("./config.js").PrismConfig;
  env: {
    GITHUB_TOKEN: string;
    EMBEDDING_PROVIDER: string;
    EMBEDDING_API_KEY?: string;
    EMBEDDING_MODEL: string;
    EMBEDDING_DIMENSIONS?: number;
    LLM_PROVIDER: string;
    LLM_API_KEY?: string;
    LLM_MODEL: string;
  };
  owner: string;
  repo: string;
  repoFull: string;
  github: import("./github.js").GitHubClient;
  store: import("./store.js").VectorStore;
  embedder: EmbeddingProvider;
}
```

- [ ] **Step 2: Create src/pipeline.ts**

Move `createPipelineContext`, `runScan`, `runDupes`, `runDupesMulti`, `runRank`, `runVision`, `parseDuration`, and `resolveRepos` from `src/cli.ts` to `src/pipeline.ts`.

Keep all function signatures and behavior identical. Update imports at the top of pipeline.ts to include everything these functions need.

Export all moved functions and the PipelineContext type.

- [ ] **Step 3: Update cli.ts to import from pipeline.ts**

Replace function bodies in cli.ts with imports from pipeline.ts. Remove imports that are no longer used directly by cli.ts.

- [ ] **Step 4: Update index.ts barrel exports**

Change pipeline function exports to come from `./pipeline.js` instead of `./cli.js`.

- [ ] **Step 5: Build to verify**

Run: `npm run build`
Expected: No errors

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 7: Lint**

Run: `npm run lint`
Fix any lint errors.

- [ ] **Step 8: Commit**

```
git add src/pipeline.ts src/cli.ts src/types.ts src/index.ts
git commit -m "refactor: extract pipeline functions from cli.ts to pipeline.ts"
```

---

### Task 6: Fix scoring DRY violation in cluster.ts

**Files:**
- Modify: `src/cluster.ts`
- Modify: `src/scorer.ts`

- [ ] **Step 1: Export normalize functions from scorer.ts**

Add `export` keyword to `normalizeDescriptionQuality` and `normalizeDiffSize` in scorer.ts.

- [ ] **Step 2: Use shared functions in cluster.ts**

Import: `import { normalizeDescriptionQuality, normalizeDiffSize } from "./scorer.js";`

Replace the inline description quality calculation and diff size calculation in the cluster scoring block with calls to these shared functions.

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: All PASS (same behavior, just DRY)

- [ ] **Step 4: Commit**

```
git add src/cluster.ts src/scorer.ts
git commit -m "refactor: deduplicate scoring logic between cluster.ts and scorer.ts"
```

---

### Task 7: Add author merge count cache

**Files:**
- Modify: `src/store.ts`
- Modify: `src/scorer.ts`

- [ ] **Step 1: Add author cache table to store.ts init()**

```sql
CREATE TABLE IF NOT EXISTS author_cache (
  author TEXT NOT NULL,
  repo TEXT NOT NULL,
  merge_count INTEGER NOT NULL,
  cached_at TEXT NOT NULL,
  PRIMARY KEY (author, repo)
);
```

- [ ] **Step 2: Add cache methods to VectorStore**

Add `getCachedAuthorMergeCount(repo, author, maxAgeHours)` and `cacheAuthorMergeCount(repo, author, count)` methods.

- [ ] **Step 3: Update buildScorerContext in scorer.ts**

Add optional `store` and `repo` parameters. Check cache before making API calls. Cache results after fetching.

- [ ] **Step 4: Update callers**

Pass `store` and `repoFull` to `buildScorerContext` calls in pipeline.ts.

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 6: Commit**

```
git add src/store.ts src/scorer.ts src/pipeline.ts
git commit -m "perf: cache author merge counts in SQLite with 24hr TTL"
```

---

## Chunk 3: New Features (Tasks 8-9)

### Task 8: Add prism compare command

**Files:**
- Modify: `src/pipeline.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add runCompare to pipeline.ts**

Implement a function that takes two PR/issue numbers, retrieves their embeddings from the store, computes cosine similarity, and displays the result with a classification (likely duplicates >= 0.85, related >= 0.65, unrelated < 0.65).

Handle edge cases: items not found, no embeddings, zero vectors.

- [ ] **Step 2: Add compare command to cli.ts**

```typescript
program
  .command("compare <number1> <number2>")
  .description("Compare two PRs/issues for similarity")
  .option("-r, --repo <owner/repo>", "Repository")
  .option("--json", "Output as JSON")
  .action(...)
```

- [ ] **Step 3: Export runCompare from index.ts**

- [ ] **Step 4: Build and smoke test**

Run: `npm run build && node dist/cli.js compare --help`

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 6: Commit**

```
git add src/pipeline.ts src/cli.ts src/index.ts
git commit -m "feat: add prism compare command for pairwise similarity"
```

---

### Task 9: Add Dockerfile

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Create .dockerignore**

Exclude: node_modules, dist, data, .git, .env, *.db, docs, scripts, examples

- [ ] **Step 2: Create Dockerfile**

Use node:20-slim base. Copy package files, install deps, copy source, build, prune dev deps. Entrypoint: node dist/cli.js.

- [ ] **Step 3: Test Docker build**

Run: `docker build -t pr-prism:test .`

- [ ] **Step 4: Test Docker run**

Run: `docker run --rm pr-prism:test --version`

- [ ] **Step 5: Commit**

```
git add Dockerfile .dockerignore
git commit -m "feat: add Dockerfile for containerized usage"
```

---

## Chunk 4: GitHub Action (Tasks 10-11)

### Task 10: Create GitHub Action

**Files:**
- Create: `action/action.yml`
- Create: `action/index.ts`
- Create: `action/tsconfig.json`

- [ ] **Step 1: Create action directory and action.yml**

Define inputs (github-token, embedding-provider, embedding-api-key, embedding-model, similarity-threshold, comment-on-pr) and outputs (cluster-count, duplicate-percentage, total-items).

- [ ] **Step 2: Create action/index.ts**

Import pipeline functions. Parse Action inputs, set env vars, run scan and dupes pipeline. On pull_request events, find clusters containing the PR and post a comment with duplicate matches. Update existing comments instead of creating duplicates.

- [ ] **Step 3: Install Action dependencies**

```
npm install @actions/core @actions/github --save
npm install -D @vercel/ncc
```

Add build:action script to package.json.

- [ ] **Step 4: Build Action**

Run: `npx ncc build action/index.ts -o action/dist`

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 6: Commit**

```
git add action/ package.json package-lock.json
git commit -m "feat: add GitHub Action for automated PR triage"
```

---

### Task 11: Add pipeline integration tests

**Files:**
- Create: `src/__tests__/pipeline.test.ts`

- [ ] **Step 1: Write pipeline tests**

Test parseDuration (days, weeks, months, invalid format). Test that pipeline exports are importable.

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/__tests__/pipeline.test.ts`

- [ ] **Step 3: Commit**

```
git add src/__tests__/pipeline.test.ts
git commit -m "test: add pipeline integration tests"
```

---

## Chunk 5: Documentation & Final Polish (Tasks 12-14)

### Task 12: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add compare to commands table**
- [ ] **Step 2: Add GitHub Action section with example workflow YAML**
- [ ] **Step 3: Add Docker section**
- [ ] **Step 4: Commit**

```
git add README.md
git commit -m "docs: add GitHub Action, Docker, and compare command to README"
```

---

### Task 13: Update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add v1.1.0 entry**

Document all added features, fixes, and changes from this audit.

- [ ] **Step 2: Commit**

```
git add CHANGELOG.md
git commit -m "docs: add v1.1.0 changelog entry"
```

---

### Task 14: Final verification and push

- [ ] **Step 1: Build** - `npm run build` (no errors)
- [ ] **Step 2: Lint** - `npm run lint` (no errors)
- [ ] **Step 3: Test** - `npm test` (all pass)
- [ ] **Step 4: Smoke test** - `node dist/cli.js --version && node dist/cli.js --help`
- [ ] **Step 5: Push** - `git push origin main`

---

## Task Dependency Graph

```
Task 1 (embed validation) --+
Task 2 (reviewer fixes)  ---+
Task 3 (SQLite/config)   ---+--> Task 5 (pipeline extract) --> Task 8 (compare)
Task 4 (npm audit)        --+         |                          |
                                       +--> Task 7 (author cache)|
                                       |                          |
                                       +--> Task 10 (GH Action) -+
                                                                   |
Task 6 (scoring DRY)  ------------------------------------------- +
Task 9 (Docker)  ------------------------------------------------ +
Task 11 (pipeline tests)  --------------------------------------- +
                                                                   |
                                                            Task 12 (README)
                                                            Task 13 (CHANGELOG)
                                                            Task 14 (verify + push)
```

Tasks 1-4 are independent (can run in parallel).
Task 5 depends on Tasks 1-4.
Tasks 6-11 depend on Task 5.
Tasks 12-14 are final polish.
