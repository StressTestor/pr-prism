import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MaintainerActionKind } from "./actions.js";
import type { RemoteState } from "./github-transport.js";

export interface ActionAuditRecord {
  id: string; // UUID
  timestamp: string; // ISO
  repo: string;
  number: number;
  type: "pr" | "issue";
  actionKind: MaintainerActionKind;
  dryRun: boolean;
  checkpointsVerified: number[];
  proposedBody?: string;
  result: "success" | "dry_run" | "blocked" | "error";
  resultDetail?: string;
  observedState?: RemoteState; // readback after write
}

/**
 * Generate a unique audit record ID (UUID v4).
 */
export function generateAuditId(): string {
  return randomUUID();
}

/**
 * Append record to JSON Lines audit file.
 * Creates directory and file if they do not exist.
 */
export function appendAuditRecord(auditPath: string, record: ActionAuditRecord): void {
  const dir = path.dirname(auditPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const recordWithId = {
    ...record,
    id: record.id || generateAuditId(),
    timestamp: record.timestamp || new Date().toISOString(),
  };

  const line = `${JSON.stringify(recordWithId)}\n`;
  fs.appendFileSync(auditPath, line, "utf8");
}

/**
 * Read all audit records from JSON Lines audit file.
 * Returns empty array if file does not exist.
 */
export function readAuditLog(auditPath: string): ActionAuditRecord[] {
  if (!fs.existsSync(auditPath)) {
    return [];
  }

  const content = fs.readFileSync(auditPath, "utf8");
  const lines = content.split("\n");
  const records: ActionAuditRecord[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      records.push(JSON.parse(trimmed) as ActionAuditRecord);
    }
  }

  return records;
}
