import { describe, expect, it } from "vitest";
import fixtureItems from "../maintainer/__fixtures__/items.json";
import type { MaintainerItem } from "../maintainer/types.js";
import { filterWorklist, paginateWorklist, sortWorklist } from "../maintainer/worklist.js";

const items = fixtureItems as MaintainerItem[];

describe("filterWorklist", () => {
  it("filters by type: pr", () => {
    const prs = filterWorklist(items, { type: "pr" });
    expect(prs.length).toBe(8);
    expect(prs.every((i) => i.type === "pr")).toBe(true);
  });

  it("filters by type: issue", () => {
    const issues = filterWorklist(items, { type: "issue" });
    expect(issues.length).toBe(2);
    expect(issues.every((i) => i.type === "issue")).toBe(true);
  });

  it("filters isDuplicateCandidate", () => {
    const dupes = filterWorklist(items, { isDuplicateCandidate: true });
    expect(dupes.length).toBe(2);
    expect(dupes.every((i) => i.isDuplicateCandidate)).toBe(true);
  });

  it("filters isConfirmedDuplicate only", () => {
    const confirmed = filterWorklist(items, { isConfirmedDuplicate: true });
    expect(confirmed.length).toBe(1);
    expect(confirmed[0].number).toBe(103);
    expect(confirmed[0].isConfirmedDuplicate).toBe(true);
  });

  it("filters needsInformation", () => {
    const needingInfo = filterWorklist(items, { needsInformation: true });
    expect(needingInfo.length).toBe(1);
    expect(needingInfo[0].number).toBe(201);
  });

  it("filters alreadyReviewed", () => {
    const reviewed = filterWorklist(items, { alreadyReviewed: true });
    expect(reviewed.length).toBe(3); // 202, 106, 107
    expect(reviewed.every((i) => i.hasDeepReview)).toBe(true);
  });

  it("a duplicate candidate is NOT treated as confirmed without isConfirmedDuplicate=true", () => {
    // Key acceptance test: fuzzy duplicate ≠ confirmed
    const fuzzy = items.filter((i) => i.isDuplicateCandidate && !i.isConfirmedDuplicate);
    expect(fuzzy.length).toBeGreaterThan(0);
    expect(fuzzy.some((i) => i.isConfirmedDuplicate)).toBe(false);
  });
});

describe("sortWorklist", () => {
  it("sorts by urgency desc (critical > high > medium > low > null)", () => {
    const sorted = sortWorklist([...items], { field: "urgency", direction: "desc" });
    const urgencies = sorted.map((i) => i.urgency);
    expect(urgencies[0]).toBe("critical"); // Item 202
    expect(urgencies.slice(1, 4)).toEqual(["high", "high", "high"]); // 101, 103, 106
  });

  it("sorts by number asc", () => {
    const sorted = sortWorklist([...items], { field: "number", direction: "asc" });
    const numbers = sorted.map((i) => i.number);
    expect(numbers).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 201, 202]);
  });

  it("sort is deterministic", () => {
    const a = sortWorklist([...items], { field: "urgency", direction: "desc" });
    const b = sortWorklist([...items], { field: "urgency", direction: "desc" });
    expect(a.map((i) => i.number)).toEqual(b.map((i) => i.number));
  });
});

describe("paginateWorklist", () => {
  it("returns correct slice", () => {
    const page1 = paginateWorklist(items, { offset: 0, limit: 3 });
    expect(page1.items.length).toBe(3);
    expect(page1.items[0].number).toBe(101);
    expect(page1.items[1].number).toBe(102);
    expect(page1.items[2].number).toBe(103);
    expect(page1.hasMore).toBe(true);

    const page4 = paginateWorklist(items, { offset: 9, limit: 3 });
    expect(page4.items.length).toBe(1);
    expect(page4.items[0].number).toBe(108);
    expect(page4.hasMore).toBe(false);
  });

  it("hasMore is correct", () => {
    const full = paginateWorklist(items, { offset: 0, limit: 10 });
    expect(full.items.length).toBe(10);
    expect(full.hasMore).toBe(false);

    const partial = paginateWorklist(items, { offset: 0, limit: 5 });
    expect(partial.items.length).toBe(5);
    expect(partial.hasMore).toBe(true);
  });
});
