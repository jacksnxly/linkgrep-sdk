<script lang="ts">
  async function startCheckout(plan: string) {
    const res = await fetch("/create-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        priceId: plan === "pro" ? "price_pro_demo" : "price_free_demo",
        // The e2e test asserts this field appears on the request body.
        // In a real app, derive it from the authenticated session.
        lgCustomerExternalId: "demo-user",
      }),
    });
    const { url } = (await res.json()) as { url: string };
    if (url) window.location.href = url;
  }
</script>

<h1>Pricing</h1>

<button data-plan="pro" on:click={() => startCheckout("pro")}>
  Subscribe — Pro
</button>
