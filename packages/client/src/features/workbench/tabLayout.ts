// This browser tab's own frames and tabs (owner, 2026-11-07: "how can this possibly work even in
// principle for an app that is designed to be used from multiple tabs?"; DESIGN §10.1). They're
// kept in the tab's session storage, for its own reloads: every other load opens just its URL,
// so a new browser tab, a pasted URL or a middle click never brings another tab's layout.

const key = (userId: string) => `rp.workbench.${userId}`

/** Whether this page came back (a reload, Back or Forward) rather than being opened at a URL. */
const returning = () => {
  try {
    const [entry] = performance.getEntriesByType("navigation") as Array<PerformanceNavigationTiming>
    return entry?.type === "reload" || entry?.type === "back_forward"
  } catch {
    return false
  }
}

/** The layout this tab kept before its reload, or null to open the URL alone. */
export const readTabLayout = (userId: string): unknown => {
  if (!returning()) return null
  try {
    const text = sessionStorage.getItem(key(userId))
    return text === null ? null : (JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

/** Keeps the layout for this tab's next reload; a browser that can't keep it opens the URL then. */
export const writeTabLayout = (userId: string, json: string) => {
  try {
    sessionStorage.setItem(key(userId), json)
  } catch {
    // Storage full or blocked: the next reload opens its URL alone.
  }
}
