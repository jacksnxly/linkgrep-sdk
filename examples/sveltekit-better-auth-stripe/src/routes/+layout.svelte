<script lang="ts">
  import { onMount } from "svelte";

  onMount(() => {
    if (typeof window !== "undefined" && !window.linkgrep) {
      import("@linkgrep/analytics").then(({ init }) => {
        init({ apiHost: "/lgr" });
      });
    }
  });
</script>

<slot />
