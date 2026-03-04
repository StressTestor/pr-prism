# contributing

thanks for the interest. here's how to get involved.

## dev setup

```bash
git clone https://github.com/StressTestor/pr-prism.git
cd pr-prism
npm install
npm run build
npm test
```

requires node >= 20. run `node --version` to check.

## project structure

```
src/
  cli.ts        — commander-based CLI (thin wrapper)
  index.ts      — public API exports
  config.ts     — zod-validated YAML config + env loading
  github.ts     — GraphQL-based GitHub ingestion
  embeddings.ts — multi-provider embedding (ollama, jina, openai, voyage, kimi)
  store.ts      — sqlite + sqlite-vec storage layer
  cluster.ts    — cosine similarity clustering
  scorer.ts     — PR quality scoring signals
  reviewer.ts   — multi-provider LLM review
  vision.ts     — vision document alignment checking
  similarity.ts — vector math utilities
  types.ts      — shared type definitions
```

## adding a new embedding provider

most likely contribution. here's the pattern:

1. add a new class in `src/embeddings.ts` implementing the `EmbeddingProvider` interface
2. add the provider name to the config schema in `src/config.ts`
3. add env var loading in `loadEnvConfig()`
4. add a case to the provider factory in `createEmbeddingProvider()`
5. add tests in `src/__tests__/`

same pattern applies for LLM providers in `src/reviewer.ts`.

## adding a new CLI command

1. add the command in `src/cli.ts` using commander
2. keep CLI logic thin — call into the programmatic API from `src/index.ts`
3. support `--json` flag for machine-readable output

## running tests

```bash
npm test              # run once
npm run test:watch    # watch mode
```

## code style

project uses biome for linting and formatting.

```bash
npm run lint          # check
npm run format        # auto-fix
```

## commits

- keep commits granular and descriptive
- use lowercase, imperative mood: "add X", "fix Y", not "Added X" or "Fixes Y"

## issues and PRs

- open an issue before starting large changes
- PRs should target `main`
- include a brief description of what changed and why
- if adding a provider, include a test that runs against a mock/fixture (don't require live API keys in CI)
