import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  if (event.url.pathname.startsWith("/lgr")) {
    const path = event.url.pathname.replace("/lgr", "");
    const isAsset = path.startsWith("/script");
    const target = isAsset
      ? `https://cdn.linkgrep.app${path}`
      : `https://api.linkgrep.app${path}${event.url.search}`;

    return fetch(target, {
      method: event.request.method,
      headers: {
        ...Object.fromEntries(event.request.headers),
        host: new URL(target).host,
        "x-forwarded-for": event.getClientAddress(),
      },
      body: event.request.method !== "GET"
        ? await event.request.text()
        : undefined,
    });
  }

  return resolve(event);
};
