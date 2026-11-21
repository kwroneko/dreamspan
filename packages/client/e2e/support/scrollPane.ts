// The pane a page scrolls in (the nearest scrolling ancestor), for screens whose lists are
// virtual rows of the pane itself, such as the request inspector's messages.
import { expect, type Locator } from "@playwright/test"

type Move = { readonly to: "start" | "end" } | { readonly by: number } | { readonly at: number }

/**
 * Scrolls the pane `inside` is in: to its start or end, `by` a fraction of its height, or so
 * that the point `at` pixels below the top of `inside` is at the pane's top.
 */
export const scrollPane = (inside: Locator, move: Move) =>
  inside.evaluate((element, move) => {
    let pane = element.parentElement
    while (pane && !["auto", "scroll"].includes(getComputedStyle(pane).overflowY)) pane = pane.parentElement
    const scroller = pane ?? document.documentElement
    if ("to" in move) scroller.scrollTop = move.to === "end" ? scroller.scrollHeight : 0
    else if ("by" in move) scroller.scrollTop += scroller.clientHeight * move.by
    else scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + move.at
  }, move)

/**
 * What shows a vertical scrollbar around `inside`: the pane it's in, every element inside that
 * pane that scrolls with content to scroll, and the pane's scrolling ancestors and the document.
 */
const vertScrollers = (inside: Locator) =>
  inside.evaluate((element) => {
    let pane = element.parentElement
    while (pane && !["auto", "scroll"].includes(getComputedStyle(pane).overflowY)) pane = pane.parentElement
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}${el.getAttribute("aria-label") ? `[aria-label="${el.getAttribute("aria-label")}"]` : ""}.${[...el.classList].join(".")}`
    const scrolls = (el: Element) => {
      const { overflowY } = getComputedStyle(el)
      return (overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1
    }
    const inner = pane ? [...pane.querySelectorAll("*")].filter(scrolls).map(describe) : []
    const above: Array<string> = []
    for (let el = pane?.parentElement ?? null; el; el = el.parentElement)
      if (el !== document.documentElement && scrolls(el)) above.push(describe(el))
    const root = document.documentElement
    if (root.scrollHeight > root.clientHeight + 1) above.push("the document")
    return { pane: pane ? describe(pane) : null, paneScrolls: pane ? scrolls(pane) : false, inner, above }
  })

/** The pane `inside` is in is the only vertical scroller there: nothing in it scrolls, nor around it. */
export const expectOneScroller = async (inside: Locator, label: string) => {
  const found = await vertScrollers(inside)
  expect(found.pane, `${label}: a scrolling pane`).not.toBeNull()
  expect(found.inner, `${label}: scrollers inside the pane`).toEqual([])
  expect(found.above, `${label}: scrollers around the pane`).toEqual([])
  return found
}

/**
 * Scrolls the pane `inside` is in down from `inside`'s top, half a pane at a time, until
 * `target` is mounted (virtual rows mount only near the pane's view), and returns it.
 */
export const scrollUntil = async (inside: Locator, target: Locator) => {
  await scrollPane(inside, { at: 0 })
  await expect
    .poll(async () => {
      if (await target.count()) return true
      await scrollPane(inside, { by: 0.5 })
      return false
    })
    .toBe(true)
  return target
}
