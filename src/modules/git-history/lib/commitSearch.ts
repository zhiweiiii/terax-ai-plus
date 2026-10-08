import type { GitLogEntry } from "@/lib/native";
import {
  compileSearch,
  type SearchOptions,
} from "@/modules/git-history/lib/filters";

export type SearchMatch = { index: number; length: number };
export type CommitSearchFields = Pick<
  GitLogEntry,
  "sha" | "subject" | "author" | "authorEmail" | "shortSha"
>;
export type CommitSearchHit = {
  sha: string;
  subject: SearchMatch | null;
  author: SearchMatch | null;
};

export function searchCommitFields(
  commits: readonly CommitSearchFields[],
  query: string,
  options: SearchOptions,
): CommitSearchHit[] {
  const pattern = compileSearch(query, options);
  if (!pattern) throw new Error("Invalid search expression");
  const match = (text: string): SearchMatch | null => {
    const found = pattern.exec(text);
    return found ? { index: found.index, length: found[0].length } : null;
  };
  const hits: CommitSearchHit[] = [];
  for (const commit of commits) {
    const subject = match(commit.subject);
    const author = match(commit.author);
    if (
      subject ||
      author ||
      match(commit.authorEmail) ||
      match(commit.shortSha)
    ) {
      hits.push({ sha: commit.sha, subject, author });
    }
  }
  return hits;
}
