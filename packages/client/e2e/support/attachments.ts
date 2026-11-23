// An attachment tile (images.tsx AttachmentList): the thumbnail, its Open in image column button
// inside at the bottom right, and its remove X straddling the top-right corner. Both show while
// the tile is hovered or focused (always on touch).
import { expect, type Locator, type Page } from "@playwright/test"

/** Removes an attachment with its X, reached over the tile first, as a pointer does. */
export async function removeAttachment(x: Locator) {
  await x.locator("xpath=ancestor::li[1]").hover()
  await x.click()
}

/** Where the composer's text and control row stand on screen, and its box's edges. */
export const composerPlaces = (page: Page) =>
  page.evaluate(() => {
    const at = (selector: string) => {
      const box = document.querySelector(selector)!.getBoundingClientRect()
      return { top: Math.round(box.top), bottom: Math.round(box.bottom), left: Math.round(box.left) }
    }
    const text = document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')!
    return {
      text: at('[data-testid="composer"]'),
      scroll: text.scrollTop,
      controls: at('[data-testid="composer-controls"]'),
      box: at('[data-testid="composer-box"]')
    }
  })
export type ComposerPlaces = Awaited<ReturnType<typeof composerPlaces>>

/** Attaching left the text, the caret and the control row where they were: only the box's top moved up. */
export function expectGrewUpward(before: ComposerPlaces, after: ComposerPlaces) {
  expect(after.text).toEqual(before.text)
  expect(after.scroll).toBe(before.scroll)
  expect(after.controls).toEqual(before.controls)
  expect(after.box.bottom).toBe(before.box.bottom)
  expect(after.box.top).toBeLessThan(before.box.top)
}

/**
 * An image's tile: a 104 px thumbnail (80 px before 2026-11-23) with two icon buttons over it
 * and no text button; the X centred on the thumbnail's top-right corner, the column button
 * inside at its bottom right.
 */
export async function expectImageTile(list: Locator, name: string) {
  const tile = list.getByRole("listitem").filter({ has: list.page().getByRole("button", { name: `View ${name}` }) })
  const buttons = tile.getByRole("button")
  await expect(buttons).toHaveCount(3)
  const view = tile.getByRole("button", { name: `View ${name}`, exact: true })
  const column = tile.getByRole("button", { name: "Open in image column", exact: true })
  const x = tile.getByRole("button", { name: `Remove ${name}`, exact: true })
  for (const overlay of [column, x]) await expect(overlay).toHaveText("")
  await expect(tile.getByText("Remove", { exact: true })).toHaveCount(0)
  const image = await view.getByRole("img").boundingBox()
  expect(image).toMatchObject({ width: 104, height: 104 })
  const thumb = (await view.boundingBox())!
  const corner = (await x.boundingBox())!
  expect(Math.abs(corner.x + corner.width / 2 - (thumb.x + thumb.width))).toBeLessThanOrEqual(1)
  expect(Math.abs(corner.y + corner.height / 2 - thumb.y)).toBeLessThanOrEqual(1)
  const open = (await column.boundingBox())!
  expect(open.x + open.width).toBeLessThanOrEqual(thumb.x + thumb.width)
  expect(open.y + open.height).toBeLessThanOrEqual(thumb.y + thumb.height)
  expect(open.y).toBeGreaterThan(corner.y + corner.height)
  return { tile, view, column, x }
}
