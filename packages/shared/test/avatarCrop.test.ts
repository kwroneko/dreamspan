// A portrait's cutout (ARCHITECTURE.md §14.5c): the default for each shape, the pixels a stored
// cutout names, how URLs name it, and that a cutout only applies to the image it was chosen on.
import { describe, expect, it } from "vitest"
import { avatarCropOf, cropKey, cropPixels, defaultCrop, parseCropKey, snapCrop } from "../src/media.ts"
import { applyDrafts, protectedChanges, valueField } from "../src/editing.ts"

describe("portrait cutouts", () => {
  it("defaults to the full width from the top of a tall image, the full height centred of a wide one", () => {
    // ST's 400 × 600 is 2:3 already: all of it.
    expect(defaultCrop(400, 600)).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    // Taller (9:16): the full width, from the top, as tall as 2:3 makes it.
    expect(defaultCrop(900, 1600)).toEqual({ x: 0, y: 0, width: 1, height: 0.8438 })
    // Square: the full height, in the middle.
    const square = defaultCrop(600, 600)
    expect(square.width).toBeCloseTo(2 / 3, 3)
    expect(square.x).toBeCloseTo(1 / 6, 3)
    expect([square.y, square.height]).toEqual([0, 1])
    // Wide (16:9): the full height, in the middle.
    const wide = defaultCrop(1600, 900)
    expect(wide.height).toBe(1)
    expect(wide.x + wide.width / 2).toBeCloseTo(0.5, 3)
    for (const [w, h] of [
      [400, 600],
      [900, 1600],
      [600, 600],
      [1600, 900],
      [1, 1000],
      [1000, 1]
    ] as const) {
      const pixels = cropPixels(defaultCrop(w, h), w, h)
      expect(pixels.left + pixels.width).toBeLessThanOrEqual(w)
      expect(pixels.top + pixels.height).toBeLessThanOrEqual(h)
    }
  })

  it("cuts exactly 2:3 pixels inside the image, whatever the stored values", () => {
    expect(cropPixels({ x: 0.5, y: 0, width: 0.5, height: 0.75 }, 600, 600)).toEqual({
      left: 300,
      top: 0,
      width: 300,
      height: 450
    })
    // Chosen on a grid of 1/10000: trimmed about its centre to 2:3, kept inside.
    const pixels = cropPixels({ x: 0.9, y: 0.9, width: 0.3, height: 0.3 }, 1000, 1000)
    expect(pixels.width * 3).toBe(pixels.height * 2)
    expect(pixels.left + pixels.width).toBeLessThanOrEqual(1000)
    expect(pixels.top + pixels.height).toBeLessThanOrEqual(1000)
  })

  it("names a cutout in URLs and file names, and reads back only cutouts inside the image", () => {
    expect(cropKey(null)).toBe("auto")
    expect(cropKey({ x: 0.5, y: 0, width: 0.5, height: 0.75 })).toBe("5000_0_5000_7500")
    expect(parseCropKey("auto")).toBeNull()
    expect(parseCropKey("5000_0_5000_7500")).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.75 })
    for (const bad of ["", "1_2_3", "a_b_c_d", "6000_0_5000_5000", "0_0_0_5000", "0_0_10001_1", "-1_0_1_1"])
      expect(parseCropKey(bad)).toBeUndefined()
    expect(snapCrop({ x: 0.123456, y: 0.5, width: 0.5, height: 0.6 })).toEqual({
      x: 0.1235,
      y: 0.4,
      width: 0.5,
      height: 0.6
    })
  })

  it("applies a stored cutout only to the image it was chosen on", () => {
    const stored = { media_id: "m1", x: 0, y: 0, width: 0.5, height: 0.5 }
    expect(avatarCropOf("m1", stored)).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 })
    // A merge that took one side's image and the other's cutout: the default.
    expect(avatarCropOf("m2", stored)).toBeNull()
    // An import's parse, before the write binds it: never applies.
    expect(avatarCropOf("m1", { x: 0, y: 0, width: 0.5, height: 0.5 })).toBeNull()
    expect(avatarCropOf(null, stored)).toBeNull()
    expect(avatarCropOf("m1", { ...stored, width: 2 })).toBeNull()
  })

  it("is a protected field: no draft changes it, and a resolved merge keeps one side's cutout", () => {
    const head = { avatar_media_id: "m1" }
    const drafted = applyDrafts("card", head, [
      {
        field: valueField(["avatar_crop"]),
        content: JSON.stringify({ media_id: "m1", x: 0, y: 0, width: 1, height: 1 })
      }
    ])
    expect(drafted.doc).toEqual(head)
    expect(drafted.problems.map((problem) => problem.message)).toEqual([
      "This changes through its own action, not an edit."
    ])
    const ours = { avatar_media_id: "m1", avatar_crop: { media_id: "m1", x: 0, y: 0, width: 1, height: 0.5 } }
    const theirs = { avatar_media_id: "m1" }
    expect(protectedChanges("card", ours, [ours, theirs])).toEqual([])
    expect(protectedChanges("card", { ...ours, avatar_crop: { ...ours.avatar_crop, x: 0.1 } }, [ours, theirs])).toEqual(
      ["avatar_crop"]
    )
  })
})
