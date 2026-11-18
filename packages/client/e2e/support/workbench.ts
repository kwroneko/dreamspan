// The layout a browser tab keeps in its URL (client features/workbench/layoutParam.ts): the `wb`
// param, absent while one tab shows alone.
import type { Page } from "@playwright/test"

/**
 * This page's frames as its URL holds them, the focused tab (`"="`) spelled out as the URL's
 * own path: null while one tab shows alone.
 */
export const storedLayout = (page: Page) => {
  const url = new URL(page.url())
  const text = url.searchParams.get("wb")
  if (text === null) return null
  // The tab's own URL: the browser's, without the layout params (a tab's never has them).
  for (const key of ["wb", "sidebar", "sbw", "cpw", "ptw", "pow", "fb", "fs", "fbh", "fsh", "cadd"])
    url.searchParams.delete(key)
  return text.replace(/"=([~^]?)"/g, (_, mark: string) => JSON.stringify(`${mark}${url.pathname}${url.search}`))
}

/** Opens `path` with `layout` (the compact form) as its frames. */
export const gotoWithLayout = (page: Page, base: string, path: string, layout: unknown) => {
  const url = new URL(path, base)
  url.searchParams.set("wb", JSON.stringify(layout))
  return page.goto(url.href)
}
