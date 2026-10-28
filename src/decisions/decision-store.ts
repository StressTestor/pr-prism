import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_JEV_MODEL } from "./jev-provider.js";
import {
  JEV_FIRST_SCHEMA_VERSION,
  type JevComplexityTier,
  type JevFirstCategory,
  type JevFirstDecisionRecord,
  type JevPriorityTier,
} from "./triage-v2.js";
import type { AdvisoryRoutingDecision, ItemTypeDecision } from "./types.js";

/**
 * Durable SQLite store for Jev-First typed triage decisions.
 *
 * Preserves full decision provenance, probabilities, confidence, uncertainty flags,
 * input/rubric SHA-256 fingerprints, token usage, latency, and cost estimates.
 * Supports idempotent checkpointing keyed by `decisionIdentity`.
 */
export class JevDecisionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 10000");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jev_decisions (
        repo TEXT NOT NULL,
        item_type TEXT NOT NULL,
        item_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        rubric_hash TEXT NOT NULL,
        decision_identity TEXT NOT NULL,
        category TEXT NOT NULL,
        category_confidence REAL,
        category_probabilities_json TEXT NOT NULL,
        technical_domain TEXT NOT NULL,
        technical_domain_confidence REAL,
        priority_tier TEXT NOT NULL,
        complexity_tier TEXT NOT NULL,
        risk_flags_json TEXT NOT NULL,
        escalate INTEGER NOT NULL,
        advisory_route TEXT NOT NULL,
        escalation_reasons_json TEXT NOT NULL,
        safety_gates_json TEXT NOT NULL,
        uncertainty_flags_json TEXT NOT NULL,
        scores_json TEXT NOT NULL,
        raw_answers_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        full_body_len INTEGER NOT NULL,
        effective_body_len INTEGER NOT NULL,
        is_input_truncated INTEGER NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        estimated_cost_usd REAL NOT NULL,
        latency_ms INTEGER,
        evaluated_at TEXT NOT NULL,
        PRIMARY KEY (repo, item_type, item_number, model, schema_version)
      );

      CREATE INDEX IF NOT EXISTS idx_jev_decisions_identity
        ON jev_decisions(decision_identity);
      CREATE INDEX IF NOT EXISTS idx_jev_decisions_repo_type
        ON jev_decisions(repo, item_type, escalate);
    `);
  }

  upsertDecision(record: JevFirstDecisionRecord): void {
    this.db
      .prepare(`
        INSERT INTO jev_decisions (
          repo, item_type, item_number, title, model, schema_version,
          input_hash, rubric_hash, decision_identity,
          category, category_confidence, category_probabilities_json,
          technical_domain, technical_domain_confidence,
          priority_tier, complexity_tier, risk_flags_json,
          escalate, advisory_route, escalation_reasons_json,
          safety_gates_json, uncertainty_flags_json,
          scores_json, raw_answers_json, provenance_json,
          full_body_len, effective_body_len, is_input_truncated,
          input_tokens, output_tokens, estimated_cost_usd, latency_ms, evaluated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?
        )
        ON CONFLICT(repo, item_type, item_number, model, schema_version) DO UPDATE SET
          title = excluded.title,
          input_hash = excluded.input_hash,
          rubric_hash = excluded.rubric_hash,
          decision_identity = excluded.decision_identity,
          category = excluded.category,
          category_confidence = excluded.category_confidence,
          category_probabilities_json = excluded.category_probabilities_json,
          technical_domain = excluded.technical_domain,
          technical_domain_confidence = excluded.technical_domain_confidence,
          priority_tier = excluded.priority_tier,
          complexity_tier = excluded.complexity_tier,
          risk_flags_json = excluded.risk_flags_json,
          escalate = excluded.escalate,
          advisory_route = excluded.advisory_route,
          escalation_reasons_json = excluded.escalation_reasons_json,
          safety_gates_json = excluded.safety_gates_json,
          uncertainty_flags_json = excluded.uncertainty_flags_json,
          scores_json = excluded.scores_json,
          raw_answers_json = excluded.raw_answers_json,
          provenance_json = excluded.provenance_json,
          full_body_len = excluded.full_body_len,
          effective_body_len = excluded.effective_body_len,
          is_input_truncated = excluded.is_input_truncated,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          estimated_cost_usd = excluded.estimated_cost_usd,
          latency_ms = excluded.latency_ms,
          evaluated_at = excluded.evaluated_at
      `)
      .run(
        record.item.repo,
        record.item.type,
        record.item.number,
        record.item.title,
        record.provenance.model,
        record.provenance.decisionSchemaVersion,
        record.provenance.inputHash,
        record.provenance.rubricHash,
        record.provenance.decisionIdentity,
        record.classification.category,
        record.classification.categoryConfidence,
        JSON.stringify(record.classification.categoryProbabilities),
        record.classification.technicalDomain,
        record.classification.technicalDomainConfidence,
        record.derived.priorityTier,
        record.derived.complexityTier,
        JSON.stringify(record.derived.riskFlags),
        record.routing.escalateToDeepReview ? 1 : 0,
        record.routing.advisoryRoute,
        JSON.stringify(record.routing.escalationReasons),
        JSON.stringify(record.routing.deterministicSafetyGates),
        JSON.stringify(record.routing.uncertaintyFlags),
        JSON.stringify(record.scores),
        JSON.stringify(record.rawAnswers),
        JSON.stringify(record.provenance),
        record.item.fullBodyLength,
        record.item.effectiveBodyLength,
        record.item.isInputTruncated ? 1 : 0,
        record.provenance.usage?.inputTokens ?? null,
        record.provenance.usage?.outputTokens ?? null,
        record.provenance.estimatedCostUsd,
        record.provenance.latencyMs ?? null,
        record.provenance.evaluatedAt,
      );
  }

  hasFreshDecision(
    repo: string,
    itemType: ItemTypeDecision,
    itemNumber: number,
    expectedDecisionIdentity: string,
    model = DEFAULT_JEV_MODEL,
    schemaVersion = JEV_FIRST_SCHEMA_VERSION,
  ): boolean {
    const row = this.db
      .prepare(`
        SELECT decision_identity
        FROM jev_decisions
        WHERE repo = ? AND item_type = ? AND item_number = ? AND model = ? AND schema_version = ?
      `)
      .get(repo, itemType, itemNumber, model, schemaVersion) as { decision_identity: string } | undefined;
    return row?.decision_identity === expectedDecisionIdentity;
  }

  getDecision(
    repo: string,
    itemType: ItemTypeDecision,
    itemNumber: number,
    model = DEFAULT_JEV_MODEL,
    schemaVersion = JEV_FIRST_SCHEMA_VERSION,
  ): JevFirstDecisionRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT *
        FROM jev_decisions
        WHERE repo = ? AND item_type = ? AND item_number = ? AND model = ? AND schema_version = ?
      `)
      .get(repo, itemType, itemNumber, model, schemaVersion) as any;
    if (!row) return undefined;
    return this.hydrateRow(row);
  }

  getAllDecisions(
    repo: string,
    model = DEFAULT_JEV_MODEL,
    schemaVersion = JEV_FIRST_SCHEMA_VERSION,
  ): JevFirstDecisionRecord[] {
    const rows = this.db
      .prepare(`
        SELECT *
        FROM jev_decisions
        WHERE repo = ? AND model = ? AND schema_version = ?
        ORDER BY item_type ASC, item_number DESC
      `)
      .all(repo, model, schemaVersion) as any[];
    return rows.map((r) => this.hydrateRow(r));
  }

  private hydrateRow(row: any): JevFirstDecisionRecord {
    return {
      item: {
        repo: row.repo,
        number: row.item_number,
        type: row.item_type as ItemTypeDecision,
        title: row.title,
        fullBodyLength: row.full_body_len,
        effectiveBodyLength: row.effective_body_len,
        isInputTruncated: Boolean(row.is_input_truncated),
      },
      classification: {
        itemType: row.item_type as ItemTypeDecision,
        category: row.category as JevFirstCategory,
        categoryConfidence: row.category_confidence,
        categoryProbabilities: JSON.parse(row.category_probabilities_json),
        technicalDomain: row.technical_domain,
        technicalDomainConfidence: row.technical_domain_confidence,
      },
      derived: {
        priorityTier: row.priority_tier as JevPriorityTier,
        complexityTier: row.complexity_tier as JevComplexityTier,
        riskFlags: JSON.parse(row.risk_flags_json),
      },
      scores: JSON.parse(row.scores_json),
      routing: {
        advisory: true,
        escalateToDeepReview: Boolean(row.escalate),
        advisoryRoute: row.advisory_route as AdvisoryRoutingDecision,
        escalationReasons: JSON.parse(row.escalation_reasons_json),
        deterministicSafetyGates: JSON.parse(row.safety_gates_json),
        uncertaintyFlags: JSON.parse(row.uncertainty_flags_json),
      },
      rawAnswers: JSON.parse(row.raw_answers_json),
      provenance: JSON.parse(row.provenance_json),
    };
  }

  close(): void {
    this.db.close();
  }
}
