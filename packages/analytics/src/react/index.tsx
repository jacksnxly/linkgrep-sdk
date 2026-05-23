import { useEffect, useRef } from "react";
import type { LinkgrepBrowserAnalyticsOptions } from "../core.js";
import { init } from "../core.js";

/**
 * Mount-once analytics initializer. Reads the click-ID from the URL and
 * persists it as a cookie. `init()` is intentionally fired ONLY on mount —
 * cookie persistence is a one-shot side effect; re-running it on every prop
 * change would write the cookie multiple times per page load.
 *
 * Pre-C5 the component referenced `props` inside a `useEffect(..., [])` with
 * an `eslint-disable-next-line react-hooks/exhaustive-deps` suppression,
 * which silently dropped any prop change after mount. The new shape:
 *
 *   - The component accepts an `initialOptions` prop, naming the constraint
 *     at the API surface so consumers know props are read once at mount.
 *   - The initial options are captured via `useRef` so the effect's deps
 *     array remains empty WITHOUT a stale-closure surprise — the ref always
 *     holds the value passed on the first render.
 *   - Subsequent renders with a different `initialOptions` value are ignored,
 *     by design, matching the `init()` once-only semantics. Document this in
 *     the prop name itself.
 *
 * See react.dev/reference/react/useEffect — "An Effect with empty
 * dependencies doesn't re-run when any of your component's props or state
 * change. ... Only use this when the effect code contains no props or state
 * references." Capturing the prop in a ref keeps the effect closure free of
 * direct prop references while still letting the consumer pass options.
 */
export function LinkgrepAnalytics({
  initialOptions,
}: {
  initialOptions?: LinkgrepBrowserAnalyticsOptions;
}): null {
  // The ref intentionally captures only the FIRST initialOptions value. The
  // exhaustive-deps lint rule is honored: the effect has no reactive
  // dependencies because it reads only from the ref's current snapshot.
  const initialRef = useRef(initialOptions);
  useEffect(() => {
    init(initialRef.current);
  }, []);
  return null;
}
