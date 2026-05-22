<script lang="ts">
  import { goto } from "$app/navigation";

  let submitting = false;
  let error = "";

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    submitting = true;
    error = "";
    try {
      const res = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: data.get("email"),
          password: data.get("password"),
          name: (data.get("email") as string)?.split("@")[0] ?? "User",
        }),
      });
      if (!res.ok) {
        error = `Sign-up failed (${res.status})`;
        return;
      }
      await goto("/");
    } finally {
      submitting = false;
    }
  }
</script>

<h1>Sign up</h1>

<form on:submit={handleSubmit}>
  <label>
    Email
    <input name="email" type="email" required />
  </label>
  <label>
    Password
    <input name="password" type="password" required minlength="8" />
  </label>
  <button type="submit" disabled={submitting}>
    {submitting ? "Creating account…" : "Sign up"}
  </button>
</form>

{#if error}
  <p style="color: red">{error}</p>
{/if}
