import type { GitLogEntry } from "@/lib/native";
import {
  type CommitSearchHit,
  searchCommitFields,
} from "@/modules/git-history/lib/commitSearch";
import type { SearchOptions } from "@/modules/git-history/lib/filters";
import { useEffect, useMemo, useState } from "react";

type SearchState = {
  key: object;
  hits: CommitSearchHit[];
  error: string | null;
};
const EMPTY_HITS: CommitSearchHit[] = [];

export function useCommitSearch(
  commits: GitLogEntry[],
  query: string,
  options: SearchOptions,
) {
  const regex = options.regex === true && query !== "";
  const caseSensitive = options.caseSensitive === true;
  const key = useMemo(
    () => ({ commits, query, regex, caseSensitive }),
    [commits, query, regex, caseSensitive],
  );
  const [state, setState] = useState<SearchState | null>(null);
  const plain = useMemo(
    () =>
      query && !regex
        ? searchCommitFields(commits, query, { caseSensitive })
        : EMPTY_HITS,
    [commits, query, regex, caseSensitive],
  );

  useEffect(() => {
    if (!regex) return;
    let alive = true;
    let worker: Worker | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (hits: CommitSearchHit[], error: string | null) => {
      if (!alive) return;
      alive = false;
      clearTimeout(timeout);
      worker?.terminate();
      setState({ key, hits, error });
    };
    const start = setTimeout(() => {
      if (!alive) return;
      try {
        worker = new Worker(
          new URL("./commitSearch.worker.ts", import.meta.url),
          { type: "module" },
        );
        worker.onmessage = (
          event: MessageEvent<{ hits?: CommitSearchHit[]; error?: string }>,
        ) => {
          finish(event.data.hits ?? EMPTY_HITS, event.data.error ?? null);
        };
        worker.onerror = () =>
          finish(
            EMPTY_HITS,
            "Search worker failed. Please retry or use plain text.",
          );
        timeout = setTimeout(
          () =>
            finish(
              EMPTY_HITS,
              "Search expression timed out. Simplify it or use plain text.",
            ),
          1000,
        );
        worker.postMessage({
          query,
          options: { regex: true, caseSensitive },
          commits: commits.map(
            ({ sha, subject, author, authorEmail, shortSha }) => ({
              sha,
              subject,
              author,
              authorEmail,
              shortSha,
            }),
          ),
        });
      } catch (error) {
        finish(
          EMPTY_HITS,
          error instanceof Error ? error.message : String(error),
        );
      }
    }, 80);
    return () => {
      alive = false;
      clearTimeout(start);
      clearTimeout(timeout);
      worker?.terminate();
    };
  }, [commits, query, regex, caseSensitive, key]);

  const hits = regex ? (state?.key === key ? state.hits : EMPTY_HITS) : plain;
  const matches = useMemo(
    () => new Map(hits.map((hit) => [hit.sha, hit])),
    [hits],
  );
  const results = useMemo(
    () =>
      query ? commits.filter((commit) => matches.has(commit.sha)) : commits,
    [commits, query, matches],
  );
  return {
    results,
    matches,
    loading: regex && state?.key !== key,
    error: regex && state?.key === key ? state.error : null,
  };
}
