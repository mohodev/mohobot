import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Shared React hooks for the dashboard. These are part of the frozen shared
 * contract: pages may import them, but must not modify this module.
 */

export interface AsyncState<T> {
  data: T | undefined;
  error: string;
  loading: boolean;
  /** Re-runs the loader; safe to pass to onClick/retry handlers. */
  reload: () => void;
  /** Optimistically replaces the loaded value (e.g. after a mutation). */
  setData: (value: T) => void;
}

function messageOf(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === 'string' && cause) return cause;
  return fallback;
}

/**
 * Runs an async loader on mount and whenever `deps` change. The loader is
 * captured through a ref, so callers may pass an inline closure without
 * triggering an infinite loop; only `deps` control re-fetching. Stale results
 * are discarded when a newer run has started.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[] = [], fallbackError = '读取数据失败'): AsyncState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const runIdRef = useRef(0);

  useEffect(() => {
    const runId = ++runIdRef.current;
    let active = true;
    setLoading(true);
    setError('');
    loaderRef.current()
      .then((value) => { if (active && runId === runIdRef.current) setDataState(value); })
      .catch((cause: unknown) => { if (active && runId === runIdRef.current) setError(messageOf(cause, fallbackError)); })
      .finally(() => { if (active && runId === runIdRef.current) setLoading(false); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, ...deps]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const setData = useCallback((value: T) => setDataState(value), []);
  return { data, error, loading, reload, setData };
}

/**
 * Calls `callback` on an interval. Polling pauses automatically while the tab
 * is hidden, and only runs while `enabled` is true. `callback` is read through
 * a ref, so it does not need to be memoised.
 */
export function usePolling(callback: () => void, intervalMs: number, enabled = true): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled || intervalMs <= 0 || typeof window === 'undefined') return;
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      callbackRef.current();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs]);
}

/** Returns `value` after it has stayed stable for `delay` ms. */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (delay <= 0) { setDebounced(value); return; }
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/** Toggles a boolean with a stable setter (useful for modals/dialogs). */
export function useToggle(initial = false): [boolean, (next?: boolean) => void] {
  const [value, setValue] = useState(initial);
  const toggle = useCallback((next?: boolean) => setValue((current) => (next === undefined ? !current : next)), []);
  return [value, toggle];
}

/** Persists a small piece of UI state in the URL hash query (`#/view?k=v`). */
export function useHashParam(key: string, fallback: string): [string, (value: string) => void] {
  const read = useCallback((): string => {
    if (typeof window === 'undefined') return fallback;
    const hash = window.location.hash.replace(/^#\/?/, '');
    const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
    return new URLSearchParams(query).get(key) ?? fallback;
  }, [key, fallback]);
  const [value, setValueState] = useState(read);

  useEffect(() => {
    const onHash = () => setValueState(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [read]);

  const setValue = useCallback((next: string) => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.hash.replace(/^#\/?/, '').split('?')[1] ?? '');
    if (next) params.set(key, next); else params.delete(key);
    const base = window.location.hash.replace(/^#\/?/, '').split('?')[0];
    const query = params.toString();
    window.location.hash = `#/${base}${query ? `?${query}` : ''}`;
    setValueState(next);
  }, [key]);

  return [value, setValue];
}

/** Memoised list filter combining a text query with a custom predicate. */
export function useFiltered<T>(items: readonly T[], query: string, fields: (item: T) => Array<unknown>): T[] {
  const needle = query.trim().toLowerCase();
  return useMemo(() => {
    if (!needle) return [...items];
    return items.filter((item) => fields(item).some((value) => String(value ?? '').toLowerCase().includes(needle)));
  }, [items, needle, fields]);
}
