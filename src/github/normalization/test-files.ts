export function hasTestFiles(filenames: string[]): boolean {
  return filenames.some((f) => /test|spec|__tests__/i.test(f));
}

/**
 * Determine if a PR includes tests based on scanned files and total files count.
 * If 100+ files and no test found in first 100, we can't be sure — default to undefined (neutral 0.5).
 */
export function determineHasTests(filePaths: string[], totalFiles: number): boolean | undefined {
  const foundTests = hasTestFiles(filePaths);
  return foundTests ? true : totalFiles > 100 ? undefined : false;
}
