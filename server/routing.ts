export interface OwnerSuggestion {
  login: string;
  reason: string;
}

export interface CodeownerRule {
  pattern: string;
  owners: string[];
}

/**
 * Parse a CODEOWNERS file into an array of pattern -> owners rules.
 * Handles comments, empty lines, and multiple owners per pattern.
 */
export function parseCodeowners(content: string): CodeownerRule[] {
  const rules: CodeownerRule[] = [];

  for (const raw of content.split("\n")) {
    const line = raw.trim();

    // skip empty lines and comments
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;

    const pattern = parts[0];
    const owners = parts.slice(1).filter((p) => p.startsWith("@"));

    if (owners.length > 0) {
      rules.push({
        pattern,
        owners: owners.map((o) => o.replace(/^@/, "")),
      });
    }
  }

  return rules;
}

/**
 * Extract file paths and component names from issue text.
 * Looks for:
 *  - paths like src/foo/bar.ts, lib/thing, etc.
 *  - filenames like module.ts, config.json
 *  - backtick-quoted identifiers that look like paths or filenames
 */
function extractPaths(text: string): string[] {
  const paths = new Set<string>();

  // match explicit file paths (word chars, slashes, dots, hyphens)
  // must contain a slash or a dot+extension to qualify
  const pathRegex = /(?:^|\s|`|\/|[(["'])([a-zA-Z0-9_\-./]+\/[a-zA-Z0-9_\-./]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(text)) !== null) {
    const p = match[1];
    if (p && p.length > 2) {
      // strip trailing punctuation
      paths.add(p.replace(/[.,;:)}\]'"]+$/, ""));
    }
  }

  // match filenames with extensions in backticks: `something.ts`
  const backtickFileRegex = /`([a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,10})`/g;
  while ((match = backtickFileRegex.exec(text)) !== null) {
    const p = match[1];
    if (p && p.length > 2) {
      paths.add(p);
    }
  }

  // match standalone filenames with extensions (not in backticks)
  const standaloneFileRegex = /(?:^|\s)([a-zA-Z0-9_\-]+\.[a-zA-Z]{1,10})(?:\s|$|[,;:)])/g;
  while ((match = standaloneFileRegex.exec(text)) !== null) {
    const p = match[1];
    // filter out common non-file patterns
    if (p && p.length > 2 && !p.match(/^\d+\.\d+$/)) {
      paths.add(p);
    }
  }

  return [...paths];
}

/**
 * Check whether a file path matches a CODEOWNERS glob pattern.
 * Supports:
 *  - exact prefix matching (src/auth/ matches src/auth/login.ts)
 *  - wildcard extension (*.ts matches foo.ts)
 *  - directory prefix (src/api matches src/api/routes.ts)
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  // normalize: strip leading slash
  const normPath = filePath.replace(/^\//, "");
  const normPattern = pattern.replace(/^\//, "");

  // wildcard extension: *.ts
  if (normPattern.startsWith("*.")) {
    const ext = normPattern.slice(1); // .ts
    return normPath.endsWith(ext);
  }

  // directory or prefix pattern
  // "src/auth/" matches "src/auth/login.ts"
  // "src/auth" matches "src/auth/login.ts" and "src/auth.ts"
  if (normPath === normPattern) return true;
  if (normPath.startsWith(normPattern)) return true;

  // check if the extracted path is a substring match for the pattern directory
  // e.g., path "auth/login.ts" should match pattern "src/auth/"
  const patternDir = normPattern.replace(/\/$/, "");
  if (normPath.includes(patternDir)) return true;

  return false;
}

/**
 * Suggest owners for an issue based on CODEOWNERS rules and file paths
 * mentioned in the issue title and body.
 *
 * Returns up to 3 owner suggestions.
 */
export function suggestOwners(
  issueTitle: string,
  issueBody: string,
  codeownersContent: string | null,
): OwnerSuggestion[] {
  if (!codeownersContent) return [];

  const rules = parseCodeowners(codeownersContent);
  if (rules.length === 0) return [];

  const text = `${issueTitle}\n${issueBody}`;
  const paths = extractPaths(text);
  if (paths.length === 0) return [];

  // track suggestions keyed by login to dedupe
  const suggestions = new Map<string, OwnerSuggestion>();

  for (const filePath of paths) {
    for (const rule of rules) {
      if (matchesPattern(filePath, rule.pattern)) {
        for (const owner of rule.owners) {
          if (!suggestions.has(owner)) {
            suggestions.set(owner, {
              login: owner,
              reason: `owns ${rule.pattern} in CODEOWNERS`,
            });
          }
        }
      }
    }
  }

  // return up to 3
  return [...suggestions.values()].slice(0, 3);
}
