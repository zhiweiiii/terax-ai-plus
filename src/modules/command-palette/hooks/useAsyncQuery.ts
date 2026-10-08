import { useCallback, useEffect, useRef, useState } from "react";

type Params<T> = {
  enabled: boolean;
  term: string;
  minLength: number;
  debounceMs: number;
  run: (term: string) => Promise<T[]>;
  scopeKey?: string;
};

export type AsyncQueryState<T> = {
  results: T[];
  loading: boolean;
  error: string | null;
  retry: () => void;
};

export function useAsyncQuery<T>({
  enabled,
  term,
  minLength,
  debounceMs,
  run,
  scopeKey = "",
}: Params<T>): AsyncQueryState<T> {
  const [results, setResults] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current++;
    };
  }, []);
  const [resultsScope, setResultsScope] = useState(scopeKey);
  const configKey = JSON.stringify([
    scopeKey,
    enabled,
    minLength,
    debounceMs,
    term,
  ]);
  const configRef = useRef({ key: configKey, run });
  if (configRef.current.key !== configKey || configRef.current.run !== run) {
    configRef.current = { key: configKey, run };
    requestIdRef.current++;
  }
  const config = configRef.current;

  const execute = useCallback(
    (q: string) => {
      if (!mountedRef.current || configRef.current !== config) return;
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      Promise.resolve()
        .then(() => (requestId === requestIdRef.current ? config.run(q) : []))
        .then((hits) => {
          if (requestId !== requestIdRef.current) return;
          setResults(hits);
          setResultsScope(scopeKey);
        })
        .catch((e) => {
          if (requestId !== requestIdRef.current) return;
          setResults([]);
          setResultsScope(scopeKey);
          setError(String(e));
        })
        .finally(() => {
          if (requestId === requestIdRef.current) setLoading(false);
        });
    },
    [config, scopeKey],
  );

  useEffect(() => {
    requestIdRef.current += 1;
    if (!enabled || term.length < minLength) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    // Keep the previous term's hits on screen while the new query runs. Blanking
    // the list on every keystroke tore down and rebuilt every result row, which
    // is the jank the "updating" affordance exists to avoid.
    setLoading(true);
    setError(null);
    const handle = window.setTimeout(() => execute(term), debounceMs);
    return () => {
      requestIdRef.current++;
      window.clearTimeout(handle);
    };
  }, [enabled, term, minLength, debounceMs, execute]);

  const retry = useCallback(() => {
    if (enabled && term.length >= minLength) execute(term);
  }, [enabled, term, minLength, execute]);

  const active = enabled && term.length >= minLength;
  const sameScope = resultsScope === scopeKey;
  return {
    results: active && sameScope ? results : [],
    loading: active && (loading || !sameScope),
    error: active && sameScope ? error : null,
    retry,
  };
}
