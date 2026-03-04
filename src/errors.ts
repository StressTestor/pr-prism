import chalk from "chalk";

export class ProviderError extends Error {
  constructor(
    public provider: string,
    public reason: string,
    public remedy: string,
    public statusCode?: number,
  ) {
    super(`${provider}: ${reason}`);
    this.name = "ProviderError";
  }

  format(): string {
    return [
      chalk.red(`✗ ${this.provider}: ${this.reason}`),
      chalk.dim(`  → ${this.remedy}`),
    ].join("\n");
  }
}

export function classifyFetchError(
  provider: string,
  err: any,
  opts?: { apiKeyEnvVar?: string },
): ProviderError {
  const msg = err?.message || String(err);
  const code = err?.code || err?.cause?.code;

  // Network errors
  if (code === "ECONNREFUSED") {
    if (provider.toLowerCase() === "ollama") {
      return new ProviderError(provider, "Connection refused", "Start Ollama with: ollama serve");
    }
    return new ProviderError(provider, "Connection refused", `Check that ${provider} is running and reachable`);
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || msg.includes("getaddrinfo")) {
    return new ProviderError(provider, `Cannot reach ${provider}`, "Check your internet connection");
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || msg.includes("timeout")) {
    return new ProviderError(provider, `Request to ${provider} timed out`, "Check your internet connection or try again");
  }

  // Pass through ProviderErrors
  if (err instanceof ProviderError) return err;

  return new ProviderError(provider, msg, "Check your configuration and try again");
}

export function classifyHttpError(
  provider: string,
  status: number,
  body: string,
  opts?: { apiKeyEnvVar?: string },
): ProviderError {
  const envVar = opts?.apiKeyEnvVar || "API key";

  switch (status) {
    case 401:
      return new ProviderError(provider, "Invalid API key", `Check ${envVar} in your .env`);
    case 403: {
      if (provider === "GitHub") {
        if (body.includes("scope") || body.includes("permission")) {
          return new ProviderError(
            provider,
            "Token lacks required scopes",
            "Needs `repo` for private repos, `public_repo` for public. Generate at https://github.com/settings/tokens",
          );
        }
        return new ProviderError(
          provider,
          "Token invalid or expired",
          "Generate a new PAT at https://github.com/settings/tokens",
        );
      }
      return new ProviderError(provider, `Forbidden (403)`, `Check ${envVar} permissions`);
    }
    case 404:
      if (provider === "Ollama") {
        const modelMatch = body.match(/model ['"]?([^'"]+)['"]?/i);
        const model = modelMatch?.[1] || "the requested model";
        return new ProviderError(provider, `Model not found: ${model}`, `Pull it with: ollama pull ${model}`);
      }
      return new ProviderError(provider, `Not found (404): ${body.slice(0, 100)}`, "Check your configuration");
    case 429:
      return new ProviderError(provider, "Rate limited", "Waiting before retry...");
    case 500:
    case 502:
    case 503:
      return new ProviderError(provider, `Server error (${status})`, `${provider} may be down. Try again later`);
    default:
      return new ProviderError(
        provider,
        `Returned ${status}: ${body.slice(0, 200)}`,
        "Check your .env configuration",
      );
  }
}
