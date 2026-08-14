import { describe, expect, it } from "vitest";
import type { GitLogEntry } from "@/lib/native";
import {
  compileSearch,
  EMPTY_HISTORY_FILTERS,
  findMatch,
  findMatchIndex,
  hasServerFilters,
  matchCommit,
  serverFilterOptions,
  sinceForPreset,
  uniqueAuthors,
} from "./filters";

function commit(overrides: Partial<GitLogEntry> = {}): GitLogEntry {
  return {
    sha: "a1b2c3d4e5f6",
    shortSha: "a1b2c3d",
    author: "Ada Lovelace",
    authorEmail: "ada@example.com",
    timestampSecs: 0,
    parents: [],
    subject: "feat(ui): add toolbar",
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    ...overrides,
  };
}

describe("sinceForPreset", () => {
  const now = 1_700_000_000_000;

  it("returns null for the all-time preset", () => {
    expect(sinceForPreset("all", now)).toBeNull();
  });

  it("returns an ISO timestamp 24 hours in the past", () => {
    expect(sinceForPreset("24h", now)).toBe(
      new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("returns an ISO timestamp 7 days in the past", () => {
    expect(sinceForPreset("7d", now)).toBe(
      new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("returns an ISO timestamp 30 days in the past", () => {
    expect(sinceForPreset("30d", now)).toBe(
      new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });
});

describe("hasServerFilters", () => {
  it("is false for the empty state", () => {
    expect(hasServerFilters(EMPTY_HISTORY_FILTERS)).toBe(false);
  });

  it("is true when any server-side filter is set", () => {
    expect(
      hasServerFilters({ ...EMPTY_HISTORY_FILTERS, author: "Ada" }),
    ).toBe(true);
    expect(
      hasServerFilters({ ...EMPTY_HISTORY_FILTERS, branch: "main" }),
    ).toBe(true);
    expect(
      hasServerFilters({ ...EMPTY_HISTORY_FILTERS, noMerges: true }),
    ).toBe(true);
    expect(
      hasServerFilters({ ...EMPTY_HISTORY_FILTERS, date: "7d" }),
    ).toBe(true);
  });

  it("ignores the client-side firstParent toggle", () => {
    expect(
      hasServerFilters({ ...EMPTY_HISTORY_FILTERS, firstParent: true }),
    ).toBe(false);
  });
});

describe("serverFilterOptions", () => {
  it("returns null when no server-side filters are set", () => {
    expect(
      serverFilterOptions(
        { author: null, date: "all", branch: null, noMerges: false },
        0,
      ),
    ).toBeNull();
  });

  it("maps author and branch filters", () => {
    expect(
      serverFilterOptions(
        { ...EMPTY_HISTORY_FILTERS, author: "Ada", branch: "main" },
        0,
      ),
    ).toEqual({ author: "Ada", branch: "main" });
  });

  it("maps the noMerges flag", () => {
    expect(
      serverFilterOptions({ ...EMPTY_HISTORY_FILTERS, noMerges: true }, 0),
    ).toEqual({ noMerges: true });
  });

  it("maps a date preset to an ISO since timestamp", () => {
    const now = 1_700_000_000_000;
    const options = serverFilterOptions(
      { ...EMPTY_HISTORY_FILTERS, date: "24h" },
      now,
    );
    expect(options).toEqual({
      since: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  it("combines author, branch, noMerges and a date preset", () => {
    const now = 1_700_000_000_000;
    const options = serverFilterOptions(
      { author: "Ada", branch: "main", noMerges: true, date: "7d" },
      now,
    );
    expect(options).toEqual({
      author: "Ada",
      branch: "main",
      noMerges: true,
      since: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  it("omits the since key when the date preset is all-time", () => {
    expect(
      serverFilterOptions(
        { author: "Ada", branch: "main", noMerges: false, date: "all" },
        0,
      ),
    ).toEqual({ author: "Ada", branch: "main" });
  });

  it("treats empty author and branch strings as unset", () => {
    expect(
      serverFilterOptions(
        { author: "", date: "all", branch: "", noMerges: false },
        0,
      ),
    ).toBeNull();
  });
});

describe("compileSearch", () => {
  it("escapes plain queries so they match literally", () => {
    expect(compileSearch("a.b", {})?.source).toBe("a\\.b");
  });

  it("is case-insensitive by default", () => {
    expect(compileSearch("Feat", {})?.flags).toContain("i");
  });

  it("drops the ignore-case flag when case-sensitive", () => {
    expect(compileSearch("Feat", { caseSensitive: true })?.flags).toBe("");
  });

  it("returns null for an empty query", () => {
    expect(compileSearch("", {})).toBeNull();
  });

  it("returns null for an invalid regex", () => {
    expect(compileSearch("(", { regex: true })).toBeNull();
  });

  it("passes a regex source through unescaped", () => {
    expect(compileSearch("^feat\\(ui\\)", { regex: true })?.source).toBe(
      "^feat\\(ui\\)",
    );
  });

  it("keeps escaping when caseSensitive is combined with regex", () => {
    expect(
      compileSearch("\\d+", { regex: true, caseSensitive: true })?.flags,
    ).toBe("");
  });

  it("escapes every regex metacharacter in a plain query", () => {
    expect(compileSearch("a.b*c[d]?e", {})?.source).toBe(
      "a\\.b\\*c\\[d\\]\\?e",
    );
  });
});

describe("findMatchIndex", () => {
  it("returns the index of the first match", () => {
    expect(findMatchIndex("add toolbar", "tool", {})).toBe(4);
  });

  it("returns -1 when nothing matches", () => {
    expect(findMatchIndex("add toolbar", "zzz", {})).toBe(-1);
  });

  it("respects the caseSensitive option", () => {
    expect(findMatchIndex("Toolbar", "toolbar", { caseSensitive: true })).toBe(
      -1,
    );
    expect(findMatchIndex("Toolbar", "toolbar", {})).toBe(0);
  });

  it("returns -1 for an invalid regex", () => {
    expect(findMatchIndex("add toolbar", "(", { regex: true })).toBe(-1);
  });

  it("returns -1 for an empty query", () => {
    expect(findMatchIndex("add toolbar", "", {})).toBe(-1);
  });

  it("honors the regex option", () => {
    expect(findMatchIndex("add toolbar", "tool\\w+", { regex: true })).toBe(4);
  });
});

describe("findMatch", () => {
  it("reports the matched span for highlighting", () => {
    expect(findMatch("add toolbar", "tool", {})).toEqual({
      index: 4,
      length: 4,
    });
  });

  it("returns null when nothing matches", () => {
    expect(findMatch("add toolbar", "zzz", {})).toBeNull();
  });

  it("respects the caseSensitive option", () => {
    expect(findMatch("Toolbar", "toolbar", { caseSensitive: true })).toBeNull();
    expect(findMatch("Toolbar", "toolbar", {})).toEqual({
      index: 0,
      length: 7,
    });
  });

  it("returns null for an invalid regex", () => {
    expect(findMatch("add toolbar", "(", { regex: true })).toBeNull();
  });

  it("honors the regex option", () => {
    expect(findMatch("add toolbar", "tool\\w+", { regex: true })).toEqual({
      index: 4,
      length: 7,
    });
  });
});

describe("matchCommit", () => {
  it("matches the subject case-insensitively by default", () => {
    expect(matchCommit(commit(), "TOOLBAR", {})).toBe(true);
    expect(matchCommit(commit(), "nope", {})).toBe(false);
  });

  it("matches author, email, and short sha", () => {
    const c = commit();
    expect(matchCommit(c, "lovelace", {})).toBe(true);
    expect(matchCommit(c, "ada@example.com", {})).toBe(true);
    expect(matchCommit(c, "a1b2c3d", {})).toBe(true);
  });

  it("honors the caseSensitive option", () => {
    expect(matchCommit(commit(), "TOOLBAR", { caseSensitive: true })).toBe(
      false,
    );
    expect(matchCommit(commit(), "TOOLBAR", {})).toBe(true);
  });

  it("honors the regex option", () => {
    expect(matchCommit(commit(), "feat\\(ui\\)", { regex: true })).toBe(true);
    expect(matchCommit(commit(), "feat\\[ui\\]", { regex: true })).toBe(false);
  });

  it("treats an invalid regex as matching nothing", () => {
    expect(matchCommit(commit(), "(", { regex: true })).toBe(false);
  });

  it("combines regex and caseSensitive", () => {
    expect(
      matchCommit(commit(), "^FEAT", { regex: true, caseSensitive: true }),
    ).toBe(false);
    expect(
      matchCommit(commit(), "^feat", { regex: true, caseSensitive: true }),
    ).toBe(true);
  });

  it("matches the author email with a regex", () => {
    expect(
      matchCommit(commit(), "ada@example\\.com", { regex: true }),
    ).toBe(true);
  });

  it("matches everything with an empty query", () => {
    expect(matchCommit(commit(), "", {})).toBe(true);
  });
});

describe("uniqueAuthors", () => {
  it("dedupes authors preserving first-seen order", () => {
    const authors = uniqueAuthors([
      commit(),
      commit({ author: "Ada Lovelace" }),
      commit({ author: "Grace Hopper" }),
    ]);
    expect(authors).toEqual(["Ada Lovelace", "Grace Hopper"]);
  });

  it("falls back to Unknown for missing names", () => {
    expect(uniqueAuthors([commit({ author: "" })])).toEqual(["Unknown"]);
  });

  it("skips whitespace-only names", () => {
    expect(uniqueAuthors([commit({ author: "   " })])).toEqual([]);
  });

  it("dedupes names that differ only by surrounding whitespace", () => {
    expect(uniqueAuthors([commit({ author: " Ada " }), commit()])).toEqual([
      "Ada Lovelace",
    ]);
  });

  it("returns an empty list for no commits", () => {
    expect(uniqueAuthors([])).toEqual([]);
  });
});
