import { describe, expect, it } from "vitest";
import {
  buildClosureCandidateRecord,
  CLOSURE_EVIDENCE_SCHEMA_VERSION,
  classifyClosureEvidence,
  exportClosureCandidates,
} from "../housekeeping/closure-verification.js";
import type { PRItem } from "../types.js";

function createMockItem(overrides: Partial<PRItem> = {}): PRItem {
  return {
    number: 1,
    type: "pr",
    repo: "test-owner/test-repo",
    title: "Sample item title",
    body: "Sample item body",
    state: "open",
    author: "alice",
    createdAt: "2026-01-01T10:00:00Z",
    updatedAt: "2026-01-01T12:00:00Z",
    labels: [],
    ...overrides,
  };
}

describe("Housekeeping Closure Verification", () => {
  it("exports correct schema version", () => {
    expect(CLOSURE_EVIDENCE_SCHEMA_VERSION).toBe("1.0.0");
  });

  // 1. ISSUE_RESOLVED_BY_MERGED_FIX: open issue + merged PR with closing ref -> correct class
  it("1. classifies ISSUE_RESOLVED_BY_MERGED_FIX for open issue + merged PR with closing ref", () => {
    const issue = createMockItem({
      number: 101,
      type: "issue",
      state: "open",
      title: "Memory leak in event loop",
    });
    const pr = createMockItem({
      number: 202,
      type: "pr",
      state: "merged",
      title: "Fix memory leak in event loop",
      closesIssues: [101],
    });

    const classification = classifyClosureEvidence(issue, pr, {
      headOidMatch: false,
      closingReferencePresent: true,
      embeddingSimilarity: 0.91,
      labelOverlap: [],
    });
    expect(classification).toBe("ISSUE_RESOLVED_BY_MERGED_FIX");

    const record = buildClosureCandidateRecord(issue, pr, {
      embeddingSimilarity: 0.91,
    });
    expect(record.relationship).toBe("ISSUE_RESOLVED_BY_MERGED_FIX");
    expect(record.deterministicEvidenceChecks.closingReferencePresent).toBe(true);
    expect(record.deterministicEvidenceChecks.targetIsMerged).toBe(true);
  });

  // 2. SUPERSEDED_BY_MERGED_REPLACEMENT: PR + merged newer PR with closing ref -> correct class
  it("2. classifies SUPERSEDED_BY_MERGED_REPLACEMENT for PR + merged newer PR with closing ref", () => {
    const oldPR = createMockItem({
      number: 301,
      type: "pr",
      state: "open",
      createdAt: "2026-01-01T00:00:00Z",
      title: "Add rate limiter middleware",
    });
    const mergedPR = createMockItem({
      number: 302,
      type: "pr",
      state: "merged",
      createdAt: "2026-01-05T00:00:00Z",
      title: "Implement comprehensive rate limiter middleware",
      closesIssues: [301],
    });

    const classification = classifyClosureEvidence(oldPR, mergedPR, {
      headOidMatch: false,
      closingReferencePresent: true,
      embeddingSimilarity: 0.89,
      labelOverlap: [],
    });
    expect(classification).toBe("SUPERSEDED_BY_MERGED_REPLACEMENT");

    const record = buildClosureCandidateRecord(oldPR, mergedPR, {
      embeddingSimilarity: 0.89,
    });
    expect(record.relationship).toBe("SUPERSEDED_BY_MERGED_REPLACEMENT");
  });

  // 3. STRONGLY_SUPPORTED_DUPLICATE: sim=0.88 + Jev noul=0.82 -> correct class
  it("3. classifies STRONGLY_SUPPORTED_DUPLICATE for sim=0.88 + Jev noul=0.82", () => {
    const prA = createMockItem({
      number: 401,
      type: "pr",
      state: "open",
      title: "Fix crash on nil pointer in auth client",
    });
    const prB = createMockItem({
      number: 402,
      type: "pr",
      state: "open",
      title: "Prevent nil pointer dereference in auth client",
    });

    const classification = classifyClosureEvidence(prA, prB, {
      headOidMatch: false,
      closingReferencePresent: false,
      embeddingSimilarity: 0.88,
      labelOverlap: [],
      jevDuplicateNoul: 0.82,
    });
    expect(classification).toBe("STRONGLY_SUPPORTED_DUPLICATE");

    const record = buildClosureCandidateRecord(prA, prB, {
      embeddingSimilarity: 0.88,
      jevDecision: { duplicateCandidateNoul: 0.82, confidence: 0.9 },
    });
    expect(record.relationship).toBe("STRONGLY_SUPPORTED_DUPLICATE");
  });

  it("3b. classifies STRONGLY_SUPPORTED_DUPLICATE for deterministic headOidMatch", () => {
    const prA = createMockItem({
      number: 410,
      headRefOid: "abc123def456",
    });
    const prB = createMockItem({
      number: 411,
      headRefOid: "abc123def456",
    });

    const classification = classifyClosureEvidence(prA, prB, {
      headOidMatch: true,
      closingReferencePresent: false,
      embeddingSimilarity: null,
      labelOverlap: [],
    });
    expect(classification).toBe("STRONGLY_SUPPORTED_DUPLICATE");
  });

  // 4. SUSPECTED_DUPLICATE: sim=0.74 + 1 label overlap -> correct class
  it("4. classifies SUSPECTED_DUPLICATE for sim=0.74 + 1 label overlap", () => {
    const prA = createMockItem({
      number: 501,
      labels: ["networking", "bug"],
    });
    const prB = createMockItem({
      number: 502,
      labels: ["networking", "enhancement"],
    });

    const classification = classifyClosureEvidence(prA, prB, {
      headOidMatch: false,
      closingReferencePresent: false,
      embeddingSimilarity: 0.74,
      labelOverlap: ["networking"],
    });
    expect(classification).toBe("SUSPECTED_DUPLICATE");

    const record = buildClosureCandidateRecord(prA, prB, {
      embeddingSimilarity: 0.74,
    });
    expect(record.relationship).toBe("SUSPECTED_DUPLICATE");
    expect(record.deterministicEvidenceChecks.labelOverlap).toEqual(["networking"]);
  });

  it("4b. classifies SUSPECTED_DUPLICATE for sim=0.74 + jevDuplicateNoul=0.65", () => {
    const prA = createMockItem({ number: 503, labels: [] });
    const prB = createMockItem({ number: 504, labels: [] });

    const classification = classifyClosureEvidence(prA, prB, {
      headOidMatch: false,
      closingReferencePresent: false,
      embeddingSimilarity: 0.74,
      labelOverlap: [],
      jevDuplicateNoul: 0.65,
    });
    expect(classification).toBe("SUSPECTED_DUPLICATE");
  });

  // 5. UNRESOLVED_INSUFFICIENT_EVIDENCE: sim=0.5, no labels, no closing ref -> correct class
  it("5. classifies UNRESOLVED_INSUFFICIENT_EVIDENCE for sim=0.5, no labels, no closing ref", () => {
    const prA = createMockItem({ number: 601, labels: [] });
    const prB = createMockItem({ number: 602, labels: [] });

    const classification = classifyClosureEvidence(prA, prB, {
      headOidMatch: false,
      closingReferencePresent: false,
      embeddingSimilarity: 0.5,
      labelOverlap: [],
    });
    expect(classification).toBe("UNRESOLVED_INSUFFICIENT_EVIDENCE");

    const record = buildClosureCandidateRecord(prA, prB, {
      embeddingSimilarity: 0.5,
    });
    expect(record.relationship).toBe("UNRESOLVED_INSUFFICIENT_EVIDENCE");
  });

  // 6. SUPERSEDED_BY_OPEN_ALTERNATIVE: older PR, newer open PR, sim=0.88 -> correct class
  it("6. classifies SUPERSEDED_BY_OPEN_ALTERNATIVE for older PR, newer open PR, sim=0.88", () => {
    const olderPR = createMockItem({
      number: 701,
      type: "pr",
      state: "open",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const newerPR = createMockItem({
      number: 702,
      type: "pr",
      state: "open",
      createdAt: "2026-01-10T00:00:00Z",
    });

    const classification = classifyClosureEvidence(olderPR, newerPR, {
      headOidMatch: false,
      closingReferencePresent: false,
      embeddingSimilarity: 0.88,
      labelOverlap: [],
    });
    expect(classification).toBe("SUPERSEDED_BY_OPEN_ALTERNATIVE");

    const record = buildClosureCandidateRecord(olderPR, newerPR, {
      embeddingSimilarity: 0.88,
    });
    expect(record.relationship).toBe("SUPERSEDED_BY_OPEN_ALTERNATIVE");
  });

  // 7. closureVerified = false when missingEvidence is non-empty even if other criteria met
  it("7. closureVerified = false when missingEvidence is non-empty even if other criteria met", () => {
    const issue = createMockItem({
      number: 801,
      type: "issue",
      state: "open",
    });
    const pr = createMockItem({
      number: 802,
      type: "pr",
      state: "merged",
      closesIssues: [801],
    });

    const record = buildClosureCandidateRecord(issue, pr, {
      jevDecision: { alreadyResolvedNoul: 0.95 },
      missingEvidence: ["Maintainer manual diff audit required"],
    });

    expect(record.relationship).toBe("ISSUE_RESOLVED_BY_MERGED_FIX");
    expect(record.closingEdgeConfirmed).toBe(true);
    expect(record.missingEvidence).toContain("Maintainer manual diff audit required");
    expect(record.closureVerified).toBe(false);
  });

  // 8. closureVerified = true only with ALL criteria: merged canonical + closing edge + jev noul >= 0.8 + empty missingEvidence
  it("8. closureVerified = true only with ALL criteria: merged canonical + closing edge + jev noul >= 0.8 + empty missingEvidence", () => {
    const issue = createMockItem({
      number: 901,
      type: "issue",
      state: "open",
    });
    const pr = createMockItem({
      number: 902,
      type: "pr",
      state: "merged",
      closesIssues: [901],
    });

    const verifiedRecord = buildClosureCandidateRecord(issue, pr, {
      jevDecision: { alreadyResolvedNoul: 0.85, confidence: 0.92 },
    });

    expect(verifiedRecord.relationship).toBe("ISSUE_RESOLVED_BY_MERGED_FIX");
    expect(verifiedRecord.closingEdgeConfirmed).toBe(true);
    expect(verifiedRecord.proposedCanonicalItem.state).toBe("merged");
    expect(verifiedRecord.jevDecision?.alreadyResolvedNoul).toBe(0.85);
    expect(verifiedRecord.missingEvidence).toHaveLength(0);
    expect(verifiedRecord.closureVerified).toBe(true);

    // Negative variation: jev noul < 0.8
    const lowNoulRecord = buildClosureCandidateRecord(issue, pr, {
      jevDecision: { alreadyResolvedNoul: 0.79 },
    });
    expect(lowNoulRecord.closureVerified).toBe(false);
    expect(lowNoulRecord.missingEvidence.length).toBeGreaterThan(0);

    // Negative variation: unmerged canonical
    const openPR = createMockItem({
      number: 903,
      type: "pr",
      state: "open",
      closesIssues: [901],
    });
    const openCanonicalRecord = buildClosureCandidateRecord(issue, openPR, {
      jevDecision: { alreadyResolvedNoul: 0.9 },
    });
    expect(openCanonicalRecord.closureVerified).toBe(false);
  });

  it("8b. closureVerified = true for deterministic headOidMatch duplicate with merged canonical without needing jev decision", () => {
    const sourcePR = createMockItem({
      number: 950,
      type: "pr",
      state: "open",
      headRefOid: "commit-hash-identical",
    });
    const canonicalPR = createMockItem({
      number: 951,
      type: "pr",
      state: "merged",
      headRefOid: "commit-hash-identical",
    });

    const record = buildClosureCandidateRecord(sourcePR, canonicalPR);
    expect(record.relationship).toBe("STRONGLY_SUPPORTED_DUPLICATE");
    expect(record.closingEdgeConfirmed).toBe(true);
    expect(record.deterministicEvidenceChecks.headOidMatch).toBe(true);
    expect(record.missingEvidence).toHaveLength(0);
    expect(record.closureVerified).toBe(true);
  });

  // 9. requiresManualVerification = ALWAYS true
  it("9. requiresManualVerification = ALWAYS true on all candidate records", () => {
    const itemA = createMockItem({ number: 1001, state: "open" });
    const itemB = createMockItem({ number: 1002, state: "merged", closesIssues: [1001] });

    const verifiedRecord = buildClosureCandidateRecord(itemA, itemB, {
      jevDecision: { alreadyResolvedNoul: 0.9 },
    });
    expect(verifiedRecord.requiresManualVerification).toBe(true);

    const unverifiedRecord = buildClosureCandidateRecord(itemA, itemB, {
      embeddingSimilarity: 0.3,
    });
    expect(unverifiedRecord.requiresManualVerification).toBe(true);
  });

  // 10. pendingMaintainerApproval = ALWAYS true
  it("10. pendingMaintainerApproval = ALWAYS true on all candidate records", () => {
    const itemA = createMockItem({ number: 1101, state: "open" });
    const itemB = createMockItem({ number: 1102, state: "merged", closesIssues: [1101] });

    const verifiedRecord = buildClosureCandidateRecord(itemA, itemB, {
      jevDecision: { alreadyResolvedNoul: 0.9 },
    });
    expect(verifiedRecord.pendingMaintainerApproval).toBe(true);

    const unverifiedRecord = buildClosureCandidateRecord(itemA, itemB);
    expect(unverifiedRecord.pendingMaintainerApproval).toBe(true);
  });

  // 11. Export counts by evidence class correctly
  it("11. exportClosureCandidates counts by evidence class correctly and populates summaries", () => {
    const prA = createMockItem({ number: 1201, type: "issue", state: "open" });
    const prB = createMockItem({ number: 1202, type: "pr", state: "merged", closesIssues: [1201] });

    const recVerified = buildClosureCandidateRecord(prA, prB, {
      jevDecision: { alreadyResolvedNoul: 0.9 },
    });
    expect(recVerified.closureVerified).toBe(true);

    const recSuspected = buildClosureCandidateRecord(
      createMockItem({ number: 1203, labels: ["triage"] }),
      createMockItem({ number: 1204, labels: ["triage"] }),
      { embeddingSimilarity: 0.75 },
    );

    const recSuperseded = buildClosureCandidateRecord(
      createMockItem({ number: 1205, createdAt: "2026-01-01T00:00:00Z" }),
      createMockItem({ number: 1206, state: "open", createdAt: "2026-01-05T00:00:00Z" }),
      { embeddingSimilarity: 0.88 },
    );

    const recUnresolved = buildClosureCandidateRecord(
      createMockItem({ number: 1207 }),
      createMockItem({ number: 1208 }),
      { embeddingSimilarity: 0.4 },
    );

    const exportData = exportClosureCandidates(
      [recVerified, recSuspected, recSuperseded, recUnresolved],
      "test-owner/test-repo",
    );

    expect(exportData.schemaVersion).toBe(CLOSURE_EVIDENCE_SCHEMA_VERSION);
    expect(exportData.repo).toBe("test-owner/test-repo");
    expect(exportData.totalCandidates).toBe(4);
    expect(exportData.verifiedCandidates).toBe(1);
    expect(exportData.pendingManualReview).toBe(4);

    expect(exportData.byEvidenceClass.ISSUE_RESOLVED_BY_MERGED_FIX).toBe(1);
    expect(exportData.byEvidenceClass.SUSPECTED_DUPLICATE).toBe(1);
    expect(exportData.byEvidenceClass.SUPERSEDED_BY_OPEN_ALTERNATIVE).toBe(1);
    expect(exportData.byEvidenceClass.UNRESOLVED_INSUFFICIENT_EVIDENCE).toBe(1);
    expect(exportData.byEvidenceClass.STRONGLY_SUPPORTED_DUPLICATE).toBe(0);
    expect(exportData.byEvidenceClass.SUPERSEDED_BY_MERGED_REPLACEMENT).toBe(0);
    expect(exportData.byEvidenceClass.CLOSURE_VERIFIED).toBe(0);
  });

  // 12. Negative: newer PR does not automatically verify supersession — needs closing ref or jev evidence
  it("12. Negative: newer PR does not automatically verify supersession without closing ref or jev evidence", () => {
    const olderPR = createMockItem({
      number: 1301,
      type: "pr",
      state: "open",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const newerMergedPR = createMockItem({
      number: 1302,
      type: "pr",
      state: "merged",
      createdAt: "2026-01-10T00:00:00Z",
      // No closesIssues
    });

    const record = buildClosureCandidateRecord(olderPR, newerMergedPR, {
      embeddingSimilarity: 0.86,
      // No closing ref, no jev decision
    });

    expect(record.closingEdgeConfirmed).toBe(false);
    expect(record.closureVerified).toBe(false);
    expect(record.missingEvidence).toContain(
      "Explicit closing keyword reference or identical head commit OID is required",
    );
  });

  // 13. Negative: open issue + open alternative PR -> SUPERSEDED_BY_OPEN_ALTERNATIVE (not VERIFIED)
  it("13. Negative: open issue + open alternative PR -> SUPERSEDED_BY_OPEN_ALTERNATIVE (not VERIFIED)", () => {
    const openIssue = createMockItem({
      number: 1401,
      type: "issue",
      state: "open",
      createdAt: "2026-01-01T00:00:00Z",
      title: "Crash on rapid websocket reconnect",
    });
    const openAlternativePR = createMockItem({
      number: 1402,
      type: "pr",
      state: "open",
      createdAt: "2026-01-10T00:00:00Z",
      title: "Handle rapid websocket reconnect without crashing",
    });

    const classification = classifyClosureEvidence(openIssue, openAlternativePR, {
      headOidMatch: false,
      closingReferencePresent: false,
      embeddingSimilarity: 0.89,
      labelOverlap: [],
    });
    expect(classification).toBe("SUPERSEDED_BY_OPEN_ALTERNATIVE");

    const record = buildClosureCandidateRecord(openIssue, openAlternativePR, {
      embeddingSimilarity: 0.89,
    });
    expect(record.relationship).toBe("SUPERSEDED_BY_OPEN_ALTERNATIVE");
    expect(record.closureVerified).toBe(false);
    expect(record.proposedCanonicalItem.state).toBe("open");
  });

  // 14. Negative: reopened defect — a re-opened issue should NOT be CLOSURE_VERIFIED against its old fix
  it("14. Negative: reopened defect — a re-opened issue should NOT be CLOSURE_VERIFIED against its old fix", () => {
    const reopenedIssue = createMockItem({
      number: 1501,
      type: "issue",
      state: "open",
      closedAt: "2026-01-05T00:00:00Z",
      updatedAt: "2026-01-08T00:00:00Z",
      labels: ["reopened"],
      title: "Null pointer regression in token refresh",
    });
    const oldMergedFix = createMockItem({
      number: 1502,
      type: "pr",
      state: "merged",
      closedAt: "2026-01-05T00:00:00Z",
      closesIssues: [1501],
      title: "Fix null pointer in token refresh",
    });

    const record = buildClosureCandidateRecord(reopenedIssue, oldMergedFix, {
      jevDecision: { alreadyResolvedNoul: 0.95 },
    });

    expect(record.closureVerified).toBe(false);
    expect(record.missingEvidence.some((m) => m.includes("reopened"))).toBe(true);
  });

  it("14b. Negative: reopened defect detected via open state with historical closedAt timestamp", () => {
    const reopenedIssueWithoutLabel = createMockItem({
      number: 1503,
      type: "issue",
      state: "open",
      closedAt: "2026-01-02T00:00:00Z",
      labels: [],
    });
    const oldMergedFix = createMockItem({
      number: 1504,
      type: "pr",
      state: "merged",
      closesIssues: [1503],
    });

    const record = buildClosureCandidateRecord(reopenedIssueWithoutLabel, oldMergedFix, {
      jevDecision: { alreadyResolvedNoul: 0.92 },
    });

    expect(record.closureVerified).toBe(false);
    expect(record.missingEvidence.some((m) => m.includes("reopened"))).toBe(true);
  });

  // Additional detail tests: GitHub URLs
  it("generates correct GitHub links for PRs and issues", () => {
    const issue = createMockItem({
      repo: "acme/widgets",
      number: 42,
      type: "issue",
    });
    const pr = createMockItem({
      repo: "acme/widgets",
      number: 84,
      type: "pr",
    });

    const record = buildClosureCandidateRecord(issue, pr);
    expect(record.githubLinks.sourceUrl).toBe("https://github.com/acme/widgets/issues/42");
    expect(record.githubLinks.canonicalUrl).toBe("https://github.com/acme/widgets/pull/84");
  });
});
