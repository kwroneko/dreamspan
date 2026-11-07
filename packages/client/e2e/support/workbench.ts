// The layout a browser tab keeps for its reloads (client features/workbench/tabLayout.ts).
import type { Page } from "@playwright/test"

const PREFIX = "rp.workbench."

/** This page's stored layout, as JSON text; null before its first save. */
export const storedLayout = (page: Page) =>
  page.evaluate((prefix) => {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index)
      if (key?.startsWith(prefix)) return sessionStorage.getItem(key)
    }
    return null
  }, PREFIX)

/** Replaces this page's stored layout (it must have saved one), for its next reload. */
export const replaceStoredLayout = (page: Page, layout: string) =>
  page.evaluate(
    ([prefix, text]) => {
      for (let index = 0; index < sessionStorage.length; index++) {
        const key = sessionStorage.key(index)
        if (key?.startsWith(prefix)) return void sessionStorage.setItem(key, text)
      }
      throw new Error("no stored layout")
    },
    [PREFIX, layout] as const
  )
