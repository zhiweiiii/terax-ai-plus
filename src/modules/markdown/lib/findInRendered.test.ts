import { describe, expect, it } from "vitest";
import { locateOffset, matchSpans } from "./findInRendered";

describe("matchSpans", () => {
  it("finds every occurrence, case-insensitively", () => {
    expect(matchSpans("Alpha beta ALPHA gamma alpha", "alpha")).toEqual([
      { start: 0, end: 5 },
      { start: 11, end: 16 },
      { start: 23, end: 28 },
    ]);
  });

  it("returns nothing for an empty query", () => {
    expect(matchSpans("anything", "")).toEqual([]);
  });

  it("returns nothing when the query is absent", () => {
    expect(matchSpans("hello world", "zzz")).toEqual([]);
  });

  it("does not overlap repeated characters", () => {
    // "aa" lands at 0 and 2 — not 0, 1 and 2.
    expect(matchSpans("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("matches text that spans a chunk boundary once joined", () => {
    // "rel" + "ea" + "se notes", as the text nodes of rel<b>ea</b>se would join.
    expect(matchSpans("release notes", "release")).toEqual([
      { start: 0, end: 7 },
    ]);
  });
});

describe("locateOffset", () => {
  const starts = [0, 3, 5, 13]; // chunks "rel", "ea", "se notes", …

  it("maps an offset inside the first chunk", () => {
    expect(locateOffset(starts, 1)).toEqual({ index: 0, offset: 1 });
  });

  it("maps a chunk's first offset to that chunk, not the previous one", () => {
    expect(locateOffset(starts, 3)).toEqual({ index: 1, offset: 0 });
    expect(locateOffset(starts, 5)).toEqual({ index: 2, offset: 0 });
  });

  it("maps an offset inside a later chunk", () => {
    expect(locateOffset(starts, 8)).toEqual({ index: 2, offset: 3 });
  });

  it("maps offset 0 to the first chunk", () => {
    expect(locateOffset(starts, 0)).toEqual({ index: 0, offset: 0 });
  });

  it("clamps past-the-end offsets onto the last chunk", () => {
    expect(locateOffset(starts, 99)).toEqual({ index: 3, offset: 86 });
  });

  it("handles a single chunk", () => {
    expect(locateOffset([0], 4)).toEqual({ index: 0, offset: 4 });
  });
});
