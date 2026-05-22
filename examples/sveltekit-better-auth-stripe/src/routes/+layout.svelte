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
      import("@linkgrep/analytics").then(({ init }) => {
        init();
      });
    }
  });
</script>

<slot />
