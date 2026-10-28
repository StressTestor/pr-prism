import { execFileSync, spawnSync } from "node:child_process";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export interface NetworkViolation {
  protocol: string;
  target?: string;
  timestamp: number;
}

export interface NetworkGuard {
  readonly violations: readonly NetworkViolation[];
  restore: () => void;
  assertZeroViolations: () => void;
  clearDemonstratedViolation: () => void;
  runWithNegativeControlIsolation: <T>(fn: (negativeViolations: NetworkViolation[]) => Promise<T> | T) => Promise<T>;
}

/**
 * Installs comprehensive in-process monkeypatches across fetch, http, https,
 * raw net.Socket, tls, and dns to establish a strict offline boundary.
 */
export function installNetworkGuard(): NetworkGuard {
  const applicationViolations: NetworkViolation[] = [];
  let activeNegativeControlSink: NetworkViolation[] | null = null;

  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpGet = http.get;
  const originalHttpsRequest = https.request;
  const originalHttpsGet = https.get;
  const originalNetConnect = net.Socket.prototype.connect;
  const originalTlsConnect = tls.connect;
  const originalDnsLookup = dns.lookup;
  const originalDnsPromisesLookup = dns.promises?.lookup;

  const recordViolation = (protocol: string, target?: string) => {
    const violation: NetworkViolation = {
      protocol,
      target,
      timestamp: Date.now(),
    };
    if (activeNegativeControlSink) {
      activeNegativeControlSink.push(violation);
    } else {
      applicationViolations.push(violation);
    }
    const err = new Error(
      `CRITICAL VIOLATION: Offline network guard intercepted prohibited ${protocol} call` +
        (target ? ` to ${target}` : ""),
    );
    (err as any).code = "ERR_NETWORK_PROHIBITED";
    return err;
  };

  // 1. globalThis.fetch (intercepted before any undici connection)
  globalThis.fetch = (async (input: any, ..._args: any[]) => {
    const target = typeof input === "string" ? input : input?.url || String(input);
    throw recordViolation("globalThis.fetch", target);
  }) as any;

  // 2. http.request & http.get
  http.request = ((...args: any[]) => {
    const target = typeof args[0] === "string" ? args[0] : args[0]?.host || args[0]?.hostname || "unknown";
    throw recordViolation("http.request", target);
  }) as any;

  http.get = ((...args: any[]) => {
    const target = typeof args[0] === "string" ? args[0] : args[0]?.host || args[0]?.hostname || "unknown";
    throw recordViolation("http.get", target);
  }) as any;

  // 3. https.request & https.get
  https.request = ((...args: any[]) => {
    const target = typeof args[0] === "string" ? args[0] : args[0]?.host || args[0]?.hostname || "unknown";
    throw recordViolation("https.request", target);
  }) as any;

  https.get = ((...args: any[]) => {
    const target = typeof args[0] === "string" ? args[0] : args[0]?.host || args[0]?.hostname || "unknown";
    throw recordViolation("https.get", target);
  }) as any;

  // 4. net.Socket.prototype.connect (intercepts all TCP connection attempts)
  net.Socket.prototype.connect = function (...args: any[]) {
    // If connecting to a unix domain socket / local IPC pipe, allow local IPC
    const firstArg = args[0];
    if (typeof firstArg === "string" && !firstArg.includes(":")) {
      return originalNetConnect.apply(this, args as any);
    }
    if (typeof firstArg === "object" && firstArg !== null && typeof firstArg.path === "string") {
      return originalNetConnect.apply(this, args as any);
    }

    const host = typeof firstArg === "object" ? firstArg?.host : typeof args[1] === "string" ? args[1] : "unknown";
    const port = typeof firstArg === "object" ? firstArg?.port : typeof firstArg === "number" ? firstArg : "unknown";
    const target = `${host}:${port}`;
    const err = recordViolation("net.Socket.connect", target);
    process.nextTick(() => {
      this.destroy(err);
    });
    return this;
  };

  // 5. tls.connect
  (tls as any).connect = (...args: any[]) => {
    const firstArg = args[0];
    const host = typeof firstArg === "object" ? firstArg?.host : typeof args[1] === "string" ? args[1] : "unknown";
    const port = typeof firstArg === "object" ? firstArg?.port : typeof firstArg === "number" ? firstArg : "443";
    throw recordViolation("tls.connect", `${host}:${port}`);
  };

  // 6. dns.lookup
  dns.lookup = ((...args: any[]) => {
    const hostname = typeof args[0] === "string" ? args[0] : "unknown";
    const cb = args.find((a) => typeof a === "function");
    const err = recordViolation("dns.lookup", hostname);
    if (cb) {
      process.nextTick(() => cb(err));
      return undefined as any;
    }
    throw err;
  }) as any;

  if (dns.promises) {
    dns.promises.lookup = (async (...args: any[]) => {
      const hostname = typeof args[0] === "string" ? args[0] : "unknown";
      throw recordViolation("dns.promises.lookup", hostname);
    }) as any;
  }

  const restore = () => {
    globalThis.fetch = originalFetch;
    http.request = originalHttpRequest;
    http.get = originalHttpGet;
    https.request = originalHttpsRequest;
    https.get = originalHttpsGet;
    net.Socket.prototype.connect = originalNetConnect;
    tls.connect = originalTlsConnect;
    dns.lookup = originalDnsLookup;
    if (dns.promises && originalDnsPromisesLookup) {
      dns.promises.lookup = originalDnsPromisesLookup;
    }
  };

  const assertZeroViolations = () => {
    if (applicationViolations.length > 0) {
      throw new Error(
        `ASSERTION FAILED: Expected 0 network violations, but recorded ${applicationViolations.length}:\n` +
          applicationViolations.map((v) => `  - [${v.protocol}] ${v.target ?? "unspecified"}`).join("\n"),
      );
    }
  };

  const clearDemonstratedViolation = () => {
    applicationViolations.length = 0;
  };

  const runWithNegativeControlIsolation = async <T>(
    fn: (negativeViolations: NetworkViolation[]) => Promise<T> | T,
  ): Promise<T> => {
    const scopedSink: NetworkViolation[] = [];
    const prevSink = activeNegativeControlSink;
    activeNegativeControlSink = scopedSink;
    try {
      return await fn(scopedSink);
    } finally {
      activeNegativeControlSink = prevSink;
    }
  };

  return {
    get violations() {
      return applicationViolations;
    },
    restore,
    assertZeroViolations,
    clearDemonstratedViolation,
    runWithNegativeControlIsolation,
  };
}

/**
 * Returns true if the current Linux process is running inside an isolated network namespace
 * where /proc/net/dev contains only the loopback interface.
 */
export function isCurrentProcessInNetworkNamespace(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const content = readFileSync("/proc/net/dev", "utf-8");
    const interfaces = content
      .split("\n")
      .slice(2)
      .map((line) => line.split(":")[0]?.trim())
      .filter(Boolean);
    return interfaces.length === 1 && interfaces[0] === "lo";
  } catch {
    return false;
  }
}

/**
 * Describes why OS-level network isolation is unavailable on the current host,
 * or returns null if isolation is available.
 *
 * Distinguishes:
 *  - "not-linux": running on a non-Linux platform
 *  - "bwrap-not-found": bwrap executable is not installed or not on PATH
 *  - "namespace-rejected": bwrap is present but the kernel rejected unprivileged
 *    user-namespace / network-namespace creation (e.g. security policy other than AppArmor)
 *  - "sandbox-error": bwrap probe failed for another reason (signal, timeout, etc.)
 *  - null: isolation is available (bwrap works, or already inside an isolated namespace)
 */
export type OsIsolationUnavailableReason = "not-linux" | "bwrap-not-found" | "namespace-rejected" | "sandbox-error";

export function osNetworkIsolationUnsupportedReason(): OsIsolationUnavailableReason | null {
  if (process.platform !== "linux") return "not-linux";
  if (isCurrentProcessInNetworkNamespace()) return null;
  try {
    const result = spawnSync("bwrap", ["--unshare-net", "--dev-bind", "/", "/", "true"], {
      stdio: "pipe",
      timeout: 2000,
    });
    if (result.status === 0) return null;
    if (result.error) {
      // ENOENT means bwrap is not installed / not on PATH
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") return "bwrap-not-found";
      return "sandbox-error";
    }
    // Non-zero exit — kernel or security policy rejected namespace creation
    return "namespace-rejected";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "bwrap-not-found";
    return "sandbox-error";
  }
}

/**
 * Returns human-readable diagnostic detail for a given isolation failure reason.
 */
export function getOsNetworkIsolationDetail(reason: OsIsolationUnavailableReason): string {
  const detail: Record<OsIsolationUnavailableReason, string> = {
    "not-linux": "not running on Linux",
    "bwrap-not-found": "bwrap is not installed or not on PATH",
    "namespace-rejected": "kernel or security policy rejected unprivileged network-namespace creation",
    "sandbox-error": "bwrap probe failed (signal, timeout, or unexpected error)",
  };
  return detail[reason];
}

/**
 * Evaluates the OS network isolation capability against the requested mode (normal vs strict).
 *
 * Normal mode: if isolation is unavailable, returns action: "skip" with diagnostic reason.
 * Strict mode (STRICT_NETWORK_ISOLATION=1): returns action: "fail". Never converts to skip.
 */
export interface OsIsolationEvaluation {
  supported: boolean;
  reason: OsIsolationUnavailableReason | null;
  detail: string | null;
  action: "proceed" | "skip" | "fail";
  message: string | null;
}

export function evaluateOsNetworkIsolationMode(options?: {
  strict?: boolean;
  unsupportedReason?: OsIsolationUnavailableReason | null;
}): OsIsolationEvaluation {
  const reason =
    options?.unsupportedReason !== undefined ? options.unsupportedReason : osNetworkIsolationUnsupportedReason();

  if (reason === null) {
    return {
      supported: true,
      reason: null,
      detail: null,
      action: "proceed",
      message: null,
    };
  }

  const detail = getOsNetworkIsolationDetail(reason);
  const strict = options?.strict ?? process.env.STRICT_NETWORK_ISOLATION === "1";
  const message = `OS-level network isolation (bwrap --unshare-net) is UNVERIFIED on this host: ${detail}.`;

  if (strict) {
    return {
      supported: false,
      reason,
      detail,
      action: "fail",
      message: `${message} Strict mode (STRICT_NETWORK_ISOLATION=1) requires verified isolation.`,
    };
  }

  return {
    supported: false,
    reason,
    detail,
    action: "skip",
    message: `${message} Set STRICT_NETWORK_ISOLATION=1 to fail instead of skip.`,
  };
}

/**
 * Checks whether Linux bubblewrap (bwrap) or an active isolated network namespace
 * is available with unshare-net support.
 */
export function isOsNetworkIsolationSupported(): boolean {
  return osNetworkIsolationUnsupportedReason() === null;
}

/**
 * Asserts that Linux bubblewrap OS-level network isolation is available.
 * Throws an explicit error if unsupported to ensure unsupported hosts are never
 * silently counted as verified.
 */
export function assertOsNetworkIsolationSupported(): void {
  const reason = osNetworkIsolationUnsupportedReason();
  if (reason !== null) {
    const detail = getOsNetworkIsolationDetail(reason);
    throw new Error(`OS-level network isolation (bwrap --unshare-net) is UNVERIFIED on this host: ${detail}.`);
  }
}

/**
 * Executes a command inside an OS-level network-isolated sandbox (bwrap --unshare-net).
 * If the current process is already inside an isolated network namespace, child processes
 * inherit that isolation directly without nested bwrap invocation.
 */
export function execInOsNetworkSandbox(
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): string {
  assertOsNetworkIsolationSupported();

  if (isCurrentProcessInNetworkNamespace()) {
    return execFileSync(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 15000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  const bwrapArgs = ["--unshare-net", "--dev-bind", "/", "/", cmd, ...args];
  return execFileSync("bwrap", bwrapArgs, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout ?? 15000,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}
