import { useEffect } from "react";
import { init } from "../core.js";
import type { LinkgrepAnalyticsOptions } from "../core.js";

export function LinkgrepAnalytics(props: LinkgrepAnalyticsOptions): null {
  useEffect(() => {
    init(props);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
