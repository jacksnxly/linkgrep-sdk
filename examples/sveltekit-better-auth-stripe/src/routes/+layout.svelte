<script>
  import { onMount } from "svelte";

  onMount(() => {
    if (typeof window !== "undefined" && !window.linkgrep) {
      import("@linkgrep/analytics").then(({ init }) => {
        init({
          publishableKey: import.meta.env.VITE_LINKGREP_PUBLISHABLE_KEY,
          apiHost: "/lgr",
        });
      });
    }
  });
</script>

<slot />
