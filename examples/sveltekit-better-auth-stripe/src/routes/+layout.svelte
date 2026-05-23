<script lang="ts">
  import { onMount } from "svelte";

  onMount(() => {
    if (typeof window !== "undefined" && !window.linkgrep) {
      // Lazy ESM import so the analytics package is excluded from the
      // SSR bundle. `init()` reads `?lg_id=` from window.location and
      // persists the click-ID in a cookie. No fetches are made from the
      // browser — server-side track.lead / track.sale calls are what
      // hit api.linkgrep.xyz (or, in production, your /lgr first-party
      // proxy if configured).
      import("@linkgrep/analytics")
        .then(({ init }) => {
          init();
        })
        .catch((err) => {
          // Chunk-load failure: ad-blocker pattern match, CDN outage, network
          // blip, or a dependent module throwing during evaluation. The
          // attribution cookie write is best-effort — never block the page
          // render on it, and never let the failure escalate to an
          // unhandledrejection event (which would count against Sentry /
          // Datadog RUM budgets and surface as console noise).
          //
          // MDN — JavaScript / Operators / import:
          //   "If module fetching and loading fails for any reason, rejects
          //    with an implementation-defined error"
          // Canonical pattern includes a .catch handler.
          // eslint-disable-next-line no-console
          console.warn("[linkgrep] analytics chunk failed to load", err);
        });
    }
  });
</script>

<slot />
