// The portrait's cutout parts are registry entries (ARCHITECTURE.md §14.5c): a plugin can
// replace the cutout-aware thumbnail URL and the chooser, and undo that.
import { expect, it } from "vitest"
import {
  CUTOUT_CHOOSER,
  cutoutChoosers,
  PORTRAIT_URL,
  portraitThumbnails,
  portraitUrl
} from "../src/ui/portraitParts.ts"

it("small portraits ask for the cutout, through a URL builder a plugin can replace", () => {
  expect(portraitUrl("m1", 150, null)).toBe("/library/media?id=m1&w=192&crop=auto")
  expect(portraitUrl("m1", 90, { x: 0.5, y: 0, width: 0.5, height: 0.75 })).toBe(
    "/library/media?id=m1&w=96&crop=5000_0_5000_7500"
  )
  const undo = portraitThumbnails.register({ id: PORTRAIT_URL, url: (id) => `/elsewhere/${id}` })
  expect(portraitUrl("m1", 90, null)).toBe("/elsewhere/m1")
  undo()
  expect(portraitUrl("m1", 90, null)).toBe("/library/media?id=m1&w=96&crop=auto")
})

it("the chooser is one replaceable entry", () => {
  const Plugin = () => null
  const undo = cutoutChoosers.register({ id: CUTOUT_CHOOSER, component: Plugin })
  expect(cutoutChoosers.get(CUTOUT_CHOOSER)?.component).toBe(Plugin)
  undo()
  const off = cutoutChoosers.disable(CUTOUT_CHOOSER)
  expect(cutoutChoosers.get(CUTOUT_CHOOSER)).toBeUndefined()
  off()
})
