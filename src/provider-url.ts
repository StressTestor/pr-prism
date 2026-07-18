import { createHash } from "node:crypto";

const SAFE_URL_ERROR = "must be a valid HTTP(S) URL without credentials, a query string, or a fragment";

function parseHttpUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(SAFE_URL_ERROR);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("must use the http: or https: protocol");
  }
  return parsed;
}

function normalizedEndpointIdentity(parsed: URL): string {
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

export function normalizeHttpBaseUrl(value: string): string {
  const parsed = parseHttpUrl(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(SAFE_URL_ERROR);
  }
  return normalizedEndpointIdentity(parsed);
}

export function endpointFingerprint(value: string): string {
  const parsed = parseHttpUrl(value);
  const identity = normalizedEndpointIdentity(parsed);
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}
