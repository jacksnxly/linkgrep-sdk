// The `@linkgrep/analytics` package augments `Window` natively (see
// `packages/analytics/src/script.ts`) when loaded via <script> tag.
// Importing the package's types here lets the example app rely on a
// single source of truth for the window.linkgrep shape — adding a new
// option in @linkgrep/analytics doesn't require editing this file (and
// any future drift becomes a compile error rather than a silent
// undefined-at-runtime).
import type { init, getClickId } from "@linkgrep/analytics";

declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface Platform {}
  }

  interface Window {
    linkgrep?: {
      init: typeof init;
      getClickId: typeof getClickId;
    };
  }
}

export {};
