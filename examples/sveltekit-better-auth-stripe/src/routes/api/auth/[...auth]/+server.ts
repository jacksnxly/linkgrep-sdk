import type { RequestHandler } from "@sveltejs/kit";
import { auth } from "$lib/server/auth";

// better-auth ships a fetch-style handler at auth.handler. SvelteKit's
// RequestHandler receives a fetch Request — pass it through directly.
const handler: RequestHandler = ({ request }) => auth.handler(request);

export const GET = handler;
export const POST = handler;
