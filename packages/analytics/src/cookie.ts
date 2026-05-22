export interface CookieOptions {
  domain?: string;
  maxAge?: number;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
  path?: string;
}

export function getCookieValue(name: string): string | undefined {
  const prefix = `${name}=`;
  // RFC 6265 §4.2.1 specifies `";" SP` between Cookie-header pairs and modern
  // browsers normalize `document.cookie` to that format. However, a
  // third-party script writing `document.cookie = "a=1;b=2"` (no space) can
  // produce non-canonical input the browser may surface back verbatim. Use
  // /;\s*/ to robustly handle either case — same pattern as the server-side
  // filterCookieHeader in examples/sveltekit-better-auth-stripe/src/hooks.server.ts.
  const row = document.cookie.split(/;\s*/).find(r => r.startsWith(prefix));
  return row?.slice(prefix.length);
}

export function setCookie(name: string, value: string, opts: CookieOptions = {}): void {
  const parts: string[] = [`${name}=${value}`];
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push("Secure");
  parts.push(`Path=${opts.path ?? "/"}`);
  document.cookie = parts.join("; ");
}
