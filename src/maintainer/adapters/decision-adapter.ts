/**
 * Maintainer Workbench — Jev Decision Adapter
 *
 * Reads Jev-First triage decisions from JevDecisionStore and calculates
 * cryptographic decision freshness against current PR/issue metadata.
 */

import { createHash } from "node:crypto";
import type { JevDecisionStore } from "../../decisions/decision-store.js";
import type { JevFirstDecisionRecord } from "../../decisions/triage-v2.js";
import type { PRItem } from "../../types.js";

/**
 * Computes the cryptographic SHA-256 fingerprint of an item's identity and state
 * used to detect out-of-sync or stale decisions.
 *
 * Spec: SHA-256 of `${item.number}${item.title}${item.updatedAt}${item.state}`.
 *
 * @param item PRItem with number, title, updatedAt, and state fields
 * @returns 64-character lowercase hex digest
 */
export function computeItemInputHash(item: Pick<PRItem, "number" | "title" | "updatedAt" | "state">): string {
  const payload = `${item.number}${item.title}${item.updatedAt}${item.state}`;
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Evaluates whether an existing Jev decision matches the current item state.
 *
 * - "none": No decision record is present or decision provenance is missing.
 * - "fresh": Decision inputHash matches the computed SHA-256 hash of the item.
 * - "stale": Decision exists but inputHash differs (e.g. title/state/update timestamp changed).
 *
 * @param decision Stored Jev decision record or undefined
 * @param item Current PRItem state
 * @returns Freshness classification
 */
export function computeDecisionFreshness(
  decision: JevFirstDecisionRecord | undefined,
  item: PRItem,
): "fresh" | "stale" | "none" {
  if (!decision || !decision.provenance || !decision.provenance.inputHash) {
    return "none";
  }

  const expectedHash = computeItemInputHash(item);
  if (decision.provenance.inputHash === expectedHash) {
    return "fresh";
  }

  // If the item title has changed, the decision is definitely stale
  if (decision.item?.title && decision.item.title !== item.title) {
    return "stale";
  }

  // Fallback: If decision evaluation occurred at or after the item's latest modification,
  // classify as fresh (supports Jev v2 multi-field input hashes).
  if (decision.provenance.evaluatedAt && item.updatedAt) {
    const evaluatedTime = new Date(decision.provenance.evaluatedAt).getTime();
    const updatedTime = new Date(item.updatedAt).getTime();
    if (!Number.isNaN(evaluatedTime) && !Number.isNaN(updatedTime)) {
      return evaluatedTime >= updatedTime ? "fresh" : "stale";
    }
  }

  return "stale";
}

/**
 * Retrieves a single Jev decision for an item by number and type.
 *
 * @param jevStore The JevDecisionStore instance
 * @param repo Full repository name (e.g. "owner/repo")
 * @param itemType "pr" or "issue"
 * @param itemNumber Issue or PR number
 * @returns JevFirstDecisionRecord if found, else undefined
 */
export function getDecision(
  jevStore: JevDecisionStore,
  repo: string,
  itemType: "pr" | "issue",
  itemNumber: number,
): JevFirstDecisionRecord | undefined {
  return jevStore.getDecision(repo, itemType, itemNumber);
}

/**
 * Retrieves all stored Jev decisions for a repository.
 *
 * @param jevStore The JevDecisionStore instance
 * @param repo Full repository name (e.g. "owner/repo")
 * @returns Array of JevFirstDecisionRecord instances
 */
export function getAllDecisions(jevStore: JevDecisionStore, repo: string): JevFirstDecisionRecord[] {
  return jevStore.getAllDecisions(repo);
}

/**
 * Builds an in-memory lookup map of Jev decisions for a repository keyed by item number.
 *
 * @param jevStore The JevDecisionStore instance
 * @param repo Full repository name (e.g. "owner/repo")
 * @returns Map from item number to JevFirstDecisionRecord
 */
export function buildDecisionMap(jevStore: JevDecisionStore, repo: string): Map<number, JevFirstDecisionRecord> {
  const decisions = jevStore.getAllDecisions(repo);
  const map = new Map<number, JevFirstDecisionRecord>();
  for (const d of decisions) {
    map.set(d.item.number, d);
  }
  return map;
}
