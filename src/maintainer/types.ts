/**
 * Maintainer Workbench — Type Definitions
 *
 * Core domain types and interfaces for the maintainer worklist, filtering,
 * sorting, pagination, and adapter contracts.
 */

/**
 * Multi-dimensional filter criteria for the maintainer worklist.
 */
export interface WorklistFilter {
  /** Filter by item type ("pr" or "issue"). */
  type?: "pr" | "issue";
  /** Filter by Jev classification category. */
  category?: string;
  /** Filter by urgency tier ("critical" | "high" | "medium" | "low"). */
  urgency?: string;
  /** Filter by specific risk flag. */
  risk?: "security" | "breaking_change" | "data_loss";
  /** Filter by duplicate candidate status. */
  isDuplicateCandidate?: boolean;
  /** Filter by confirmed duplicate status. */
  isConfirmedDuplicate?: boolean;
  /** Filter by superseded candidate status (open PR with closed/merged tracker). */
  isSupersededCandidate?: boolean;
  /** Filter for items ready for maintainer action. */
  readyForAction?: boolean;
  /** Filter for items with missing information. */
  needsInformation?: boolean;
  /** Filter for PRs with pending lightweight review. */
  lightweightReviewPending?: boolean;
  /** Filter for items requiring complex deep review. */
  complexReviewRequired?: boolean;
  /** Filter for items that already have a deep review recorded. */
  alreadyReviewed?: boolean;
  /** Filter for items whose Jev decision or review evidence is stale. */
  hasStaleEvidence?: boolean;
}

/**
 * Sort options for ordering worklist items.
 */
export interface WorklistSort {
  /** Field to sort by. */
  field: "urgency" | "category" | "number" | "updatedAt" | "score";
  /** Sort direction ("asc" or "desc"). */
  direction: "asc" | "desc";
}

/**
 * Pagination bounds for slicing worklist items.
 */
export interface WorklistPage {
  /** Zero-based item offset. */
  offset: number;
  /** Maximum number of items to return. */
  limit: number;
}

/**
 * Canonical row in the maintainer workbench worklist.
 */
export interface MaintainerItem {
  // Identity
  /** Full repository name (e.g. "owner/repo"). */
  repo: string;
  /** Issue or PR number. */
  number: number;
  /** Item type. */
  type: "pr" | "issue";
  /** HTML URL to GitHub item. */
  url: string;
  /** Item title. */
  title: string;
  /** Lifecycle state. */
  state: "open" | "closed" | "merged";
  /** Author login username. */
  author: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last update timestamp. */
  updatedAt: string;
  /** Label names assigned to the item. */
  labels: string[];
  /** Flagged as closed during a recognized incident window. */
  incidentClosed?: boolean;

  // Jev decision facts (null = no decision run yet)
  /** Jev classified category or null if unassigned. */
  category: string | null;
  /** Confidence score for category classification (0..1) or null. */
  categoryConfidence: number | null;
  /** Derived urgency priority tier or null. */
  urgency: "critical" | "high" | "medium" | "low" | null;
  /** Primary technical domain or null. */
  technicalDomain: string | null;
  /** Advisory routing path from Jev triage or null. */
  advisoryRoute: string | null;
  /** Whether Jev or safety rules recommended deep review escalation or null. */
  escalateToDeepReview: boolean | null;
  /** Reproduction evidence quality score (0..1) or null. */
  evidenceQuality: number | null;
  /** Whether a security vulnerability hazard was identified or null. */
  securityRisk: boolean | null;
  /** Whether a breaking change risk was identified or null. */
  breakingChangeRisk: boolean | null;
  /** Whether a data-loss or corruption risk was identified or null. */
  dataLossRisk: boolean | null;
  /** Whether essential reproduction or PR context is missing or null. */
  missingInformation: boolean | null;
  /** Whether a Jev decision record exists for this item. */
  hasJevDecision: boolean;
  /** Freshness of Jev decision: fresh=inputHash match, stale=inputHash mismatch, none=missing. */
  jevDecisionAge: "fresh" | "stale" | "none";

  // Cluster / duplicate facts
  /** ID of duplicate cluster if item belongs to one, or null. */
  clusterId: number | null;
  /** Number of items in duplicate cluster (0 if not clustered). */
  clusterSize: number;
  /** Whether this item is considered a duplicate candidate (non-canonical in cluster). */
  isDuplicateCandidate: boolean;
  /** Identity cluster confirmed duplicate (head-oid or patch-id match). */
  isConfirmedDuplicate: boolean;
  /** Open PR whose tracker issue or sibling PR is closed/merged. */
  isSupersededCandidate: boolean;
  /** Lowest pairwise similarity in the cluster or null. */
  clusterMinSimilarity: number | null;
  /** Confidence tier of cluster tightness ("high" | "solid" | "loose") or null. */
  clusterConfidence: "high" | "solid" | "loose" | null;

  // Review state
  /** Whether a deep review has been completed and stored. */
  hasDeepReview: boolean;
  /** Freshness of review: fresh=reviewedAt >= updatedAt, stale=updatedAt > reviewedAt, none=missing. */
  deepReviewAge: "fresh" | "stale" | "none";
  /** Deep review recommendation or null. */
  reviewRecommendation: "merge" | "revise" | "close" | "needs_human_review" | null;
  /** Deep review confidence (0..1) or null. */
  reviewConfidence: number | null;

  // Quality score (scorer.ts output)
  /** PR-Prism objective quality score (0..1) or null for issues. */
  qualityScore: number | null;

  // Worklist meta
  /** Action suggested by PR-Prism maintainer workflow rules. */
  suggestedAction: SuggestedAction;
  /** Whether the item is immediately ready for maintainer action. */
  readyForAction: boolean;
  /** List of facts grounded in verified data sources (GitHub API, scorer.ts). */
  sourceBackedFacts: string[];
  /** List of advisory recommendations from Jev and LLM models. */
  modelRecommendations: string[];
}

/**
 * Suggested action for a maintainer worklist item.
 */
export type SuggestedAction =
  | "close_duplicate"
  | "close_superseded"
  | "request_info"
  | "request_changes"
  | "review_pending"
  | "needs_deep_review"
  | "ready_to_merge"
  | "monitor"
  | "investigate";

/**
 * Adapter port — stable interface future Jev/review versions can implement.
 */
export interface MaintainerAdapterPort {
  getItems(repo: string): Promise<MaintainerItem[]>;
}
