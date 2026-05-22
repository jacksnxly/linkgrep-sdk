export interface CookieOptions {
  domain?: string;
  maxAge?: number;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
  path?: string;
}

export function getCookieValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const row = document.cookie.split("; ").find(r => r.startsWith(prefix));
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
