import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./msw-server.js";

// `"error"` (not `"warn"`) — match the sdk-package convention so an
// unexpected outbound request from the plugin fails the test instead of
// emitting a console warning the CI logs may swallow (keryx I-11).
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
