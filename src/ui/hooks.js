// Small shared hooks (no dependencies beyond React).
import { useState, useEffect, useRef, useCallback } from "react";

// The value, but only after it has stopped changing for `ms`. Used so typing in a search box
// does not re-filter a long list on every keystroke.
export function useDebouncedValue(value, ms = 150) {
  const [v, setV] = useState(value);
  useEffect(() => {
    if (v === value) return;
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms, v]);
  return v;
}

// A function identity that never changes but always calls the latest `fn`. Lets memoised row
// components receive handlers without re-rendering every time the parent does.
export function useStableCallback(fn) {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args) => ref.current(...args), []);
}

// "Show more" paging for long lists: returns [limit, showMore]. The limit goes back to one page
// whenever `resetKey` changes (e.g. the filter text).
export function usePagedLimit(pageSize, resetKey) {
  const [state, setState] = useState({ key: resetKey, limit: pageSize });
  const limit = state.key === resetKey ? state.limit : pageSize;
  const showMore = useCallback(
    () => setState({ key: resetKey, limit: limit + pageSize }),
    [resetKey, limit, pageSize]
  );
  return [limit, showMore];
}
