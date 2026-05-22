import { useEffect } from "react";
import { init } from "../core.js";
import type { LinkgrepBrowserAnalyticsOptions } from "../core.js";

export function LinkgrepAnalytics(props: LinkgrepBrowserAnalyticsOptions): null {
  useEffect(() => {
    init(props);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
