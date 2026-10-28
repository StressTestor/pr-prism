import { createHash } from "node:crypto";
import { type Evidence, hash } from "./contracts.js";

export const blobHash = (bytes: Buffer): string =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
export interface FileSource {
  before: string | null;
  after: string | null;
  baseBlob: string | null;
  headBlob: string | null;
  baseMode: string | null;
  headMode: string | null;
}
export function coverageManifest(files: Evidence["files"]) {
  return files.map((f) => ({
    path: f.path,
    previousPath: f.previousPath,
    status: f.status,
    objectSha: f.objectSha,
    patchHash: hash(f.patch ?? null),
    sourceHash: hash(f.source ?? null),
  }));
}
export function coverageProblems(e: Evidence): string[] {
  const problems = [...e.limitations];
  if (e.kind === "issue") return problems;
  if (
    !e.coverage ||
    e.coverage.version !== 1 ||
    e.coverage.expectedFiles !== e.files.length ||
    e.coverage.manifestHash !== hash(coverageManifest(e.files))
  )
    return [...problems, "Unproven changed-file coverage (legacy or incomplete manifest)"];
  if (new Set(e.files.map((f) => f.path)).size !== e.files.length) problems.push("Duplicate changed-file paths");
  for (const file of e.files) {
    const s = file.source;
    if (!s) {
      problems.push(`Unverified source: ${file.path}`);
      continue;
    }
    for (const [text, sha] of [
      [s.before, s.baseBlob],
      [s.after, s.headBlob],
    ]) {
      if (text === null ? sha !== null : typeof text !== "string" || blobHash(Buffer.from(text)) !== sha)
        problems.push(`Source checksum mismatch: ${file.path}`);
    }
    if (!["added", "removed", "modified", "renamed", "copied", "changed"].includes(file.status))
      problems.push(`Unsupported change: ${file.path}`);
    if (
      (file.status === "added" && s.before !== null) ||
      (file.status === "removed" && s.after !== null) ||
      (file.status !== "removed" && s.after === null) ||
      (!["added", "copied"].includes(file.status) && s.before === null)
    )
      problems.push(`Source presence mismatch: ${file.path}`);
  }
  return [...new Set(problems)];
}
