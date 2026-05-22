declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface Platform {}
  }

  interface Window {
    linkgrep?: {
      init: (opts?: { cookieDomain?: string; cookieName?: string }) => void;
      getClickId: (cookieName?: string) => string | undefined;
    };
  }
}

export {};
