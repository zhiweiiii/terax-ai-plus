import {
  type CommitSearchFields,
  searchCommitFields,
} from "@/modules/git-history/lib/commitSearch";
import type { SearchOptions } from "@/modules/git-history/lib/filters";

self.onmessage = (
  event: MessageEvent<{
    commits: CommitSearchFields[];
    query: string;
    options: SearchOptions;
  }>,
) => {
  try {
    self.postMessage({
      hits: searchCommitFields(
        event.data.commits,
        event.data.query,
        event.data.options,
      ),
    });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
