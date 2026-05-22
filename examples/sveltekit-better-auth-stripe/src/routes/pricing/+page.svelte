<script lang="ts">
  async function startCheckout(plan: string) {
    // lgCustomerExternalId is NOT sent from the client — the server derives it
    // from the authenticated better-auth session (see /create-checkout). This
    // keeps attribution honest: a logged-out caller gets 401, and a logged-in
    // caller cannot spoof another user's external ID.
    const res = await fetch("/create-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        priceId: plan === "pro" ? "price_pro_demo" : "price_free_demo",
      }),
    });
    if (res.status === 401) {
      window.location.href = "/signup";
      return;
    }
    const { url } = (await res.json()) as { url: string };
    if (url) window.location.href = url;
  }
</script>

<h1>Pricing</h1>

<button data-plan="pro" on:click={() => startCheckout("pro")}>
  Subscribe — Pro
</button>
