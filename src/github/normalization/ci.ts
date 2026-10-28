import type { PRItem } from "../../types.js";

export function mapCIStatus(state: string | null | undefined): PRItem["ciStatus"] {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "unknown";
  }
}

export function mapCheckRunsToCIStatus(
  totalCount: number,
  checkRuns: Array<{ status?: string | null; conclusion?: string | null }>,
): PRItem["ciStatus"] {
  if (totalCount === 0) return "unknown";

  const allComplete = checkRuns.every((c) => c.status === "completed");
  if (!allComplete) return "pending";

  const allSuccess = checkRuns.every((c) => c.conclusion === "success");
  return allSuccess ? "success" : "failure";
}
