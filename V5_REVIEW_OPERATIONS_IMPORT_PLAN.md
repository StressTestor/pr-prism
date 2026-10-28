# Read-only migration and import plan

No migration or import has been executed. The external runner remains authoritative while active. Do not point V5 at its database or draft directory. The source implementation does not load these artifacts.

After the runner finishes and the operator separately authorizes an import:

1. Copy the stopped runner's SQLite database using SQLite's backup API and copy its targeted/overnight checkpoint manifests into an isolated private staging directory. Record source hashes, schema versions, checkpoint counts and runner/prompt versions; retain originals. Do not copy private responses into Git.
2. Implement an offline preview reader against staging, opened read-only. Inventory JSON/Markdown/manifests and ledger records without rewriting legacy schemas. Invalid/truncated/failed outputs stay historical and never count as current. Show exact counts by repository/type/head/model/prompt/evidence hash, duplicate identities, missing evidence and unverifiable artifacts.
3. Obtain a fresh read-only GitHub snapshot. Require repository, type, number, exact PR head and base, full changed-file/diff evidence hashes and prompt/model provenance. Issues require exact body/conversation/linked-fix evidence identity. A title or timestamp match is insufficient. Require the V5 source-coverage manifest: complete unique file inventory, merge-base/head tree paths, Git blob checksums and byte-preserving text, plus every exact evidence batch. Raw patch-only legacy records remain advisory/partial until that proof exists. Keep legacy checkpoint identities and paid counts unchanged.
4. Build a proposed mapping into a new V5 database; legacy attempts preserve their original provenance and costs in a separately identified historical ledger. Never fabricate V5 paid-attempt reservations or treat a different prompt/model hash as a reusable native checkpoint. Verified legacy drafts may count as imported advisory coverage only after an explicit compatibility validator exists.
5. Present a dry-run manifest and its hash for item-level operator review. No paid calls, GitHub writes or live-source modifications occur. Unknown SHA/evidence records are stale/unverifiable, never silently re-reviewed for a fee.
6. Only after authorization, back up the destination with SQLite backup, atomically import the approved manifest into the new database, and verify exact before/after counts plus source hashes. Revalidate GitHub again before any later action. Rollback discards the new destination or restores its backup; original artifacts remain intact.

This document is a proposal, not an implemented importer. No automatic import flags are exposed.

Native schema-5 V5 databases are a separate compatibility case: schema 6 creates a consistent SQLite backup before adding tables, preserving original checkpoint columns and hashes. This does not authorize opening or migrating any production database during development.
