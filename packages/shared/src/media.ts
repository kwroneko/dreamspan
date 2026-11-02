import { Schema } from "effect"

/** Rounded up to bound the number of persistent derivatives of each immutable image. */
export const MEDIA_WIDTHS = [96, 192, 384, 768] as const

export const mediaWidth = (pixels: number) => MEDIA_WIDTHS.find((width) => width >= pixels) ?? 768

// --- A portrait's cutout (ARCHITECTURE.md §14.5c): the 2:3 part of the whole image every
// small portrait shows. The original is never altered; the cutout is stored beside it, as
// fractions of the original's width and height, and thumbnails are made from it.

const Fraction = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

/** Steps a cutout is stored and addressed in: 1/10000 of the original's width or height. */
const CUTOUT_STEPS = 10_000

export const AvatarCrop = Schema.Struct({
  x: Fraction,
  y: Fraction,
  width: Fraction.check(Schema.isGreaterThan(0)),
  height: Fraction.check(Schema.isGreaterThan(0))
}).check(
  Schema.makeFilter(
    (crop) =>
      (Math.round((crop.x + crop.width) * CUTOUT_STEPS) <= CUTOUT_STEPS &&
        Math.round((crop.y + crop.height) * CUTOUT_STEPS) <= CUTOUT_STEPS) ||
      "A cutout must lie inside its image"
  )
)
export type AvatarCrop = typeof AvatarCrop.Type

/** The portrait frame's shape: two wide, three high. */
export const PORTRAIT_RATIO = 2 / 3

const step = (value: number) => Math.round(value * CUTOUT_STEPS) / CUTOUT_STEPS

/** A cutout on the storage grid, inside its image. */
export const snapCrop = (crop: AvatarCrop): AvatarCrop => {
  const width = Math.max(1 / CUTOUT_STEPS, Math.min(1, step(crop.width)))
  const height = Math.max(1 / CUTOUT_STEPS, Math.min(1, step(crop.height)))
  return {
    x: Math.min(step(crop.x), step(1 - width)),
    y: Math.min(step(crop.y), step(1 - height)),
    width,
    height
  }
}

/**
 * The cutout an image has until one is chosen: the full width, from the top, of an image
 * taller than 2:3 (where a portrait's face is); the full height, centred, of a wider one.
 */
export const defaultCrop = (imageWidth: number, imageHeight: number): AvatarCrop => {
  if (imageWidth <= 0 || imageHeight <= 0) return { x: 0, y: 0, width: 1, height: 1 }
  if (imageWidth / imageHeight > PORTRAIT_RATIO) {
    const width = step((imageHeight * PORTRAIT_RATIO) / imageWidth)
    return { x: step((1 - width) / 2), y: 0, width, height: 1 }
  }
  return { x: 0, y: 0, width: 1, height: Math.min(1, step(imageWidth / PORTRAIT_RATIO / imageHeight)) }
}

/**
 * The cutout in an image's pixels, exactly 2:3 (a stored cutout is on a grid, and the image's
 * shape may not be the one it was chosen on): trimmed about its centre to that shape and kept
 * inside the image.
 */
export const cropPixels = (crop: AvatarCrop, imageWidth: number, imageHeight: number) => {
  let width = crop.width * imageWidth
  let height = crop.height * imageHeight
  const centreX = (crop.x + crop.width / 2) * imageWidth
  const centreY = (crop.y + crop.height / 2) * imageHeight
  if (width / height > PORTRAIT_RATIO) width = height * PORTRAIT_RATIO
  else height = width / PORTRAIT_RATIO
  width = Math.max(1, Math.min(imageWidth, Math.round(width)))
  height = Math.max(1, Math.min(imageHeight, Math.round(height)))
  const left = Math.max(0, Math.min(imageWidth - width, Math.round(centreX - width / 2)))
  const top = Math.max(0, Math.min(imageHeight - height, Math.round(centreY - height / 2)))
  return { left, top, width, height }
}

/**
 * How a thumbnail URL and its derivative's file name name a cutout: `auto` for the default
 * (made from the image's own shape), else its four values in CUTOUT_STEPS.
 */
export const cropKey = (crop: AvatarCrop | null) =>
  crop === null
    ? "auto"
    : [crop.x, crop.y, crop.width, crop.height].map((value) => Math.round(value * CUTOUT_STEPS)).join("_")

/** A `crop` query value back to the cutout it names (`auto`: null), or undefined when it names none. */
export const parseCropKey = (key: string): AvatarCrop | null | undefined => {
  if (key === "auto") return null
  const parts = key.split("_")
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,5}$/.test(part))) return undefined
  const [x, y, width, height] = parts.map((part) => Number(part) / CUTOUT_STEPS) as [number, number, number, number]
  const crop = { x, y, width, height }
  return Schema.is(AvatarCrop)(crop) ? crop : undefined
}

/**
 * A card's stored cutout: the one chosen for `media_id`, the image it was chosen on. A cutout
 * whose image isn't the card's avatar any more (a merge that took one side's image and the
 * other's cutout, say) doesn't apply: the image has the default.
 */
export const StoredCrop = Schema.Struct({
  /** Absent only between an import's parse and its write, which binds it to the stored file. */
  media_id: Schema.optionalKey(Schema.String),
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite
})
export type StoredCrop = typeof StoredCrop.Type

/** The cutout a card shows (`avatar_crop` of its document) for its avatar; null: the default. */
export const avatarCropOf = (avatarMediaId: unknown, stored: unknown): AvatarCrop | null => {
  if (typeof avatarMediaId !== "string" || !Schema.is(StoredCrop)(stored) || stored.media_id !== avatarMediaId)
    return null
  const crop = { x: stored.x, y: stored.y, width: stored.width, height: stored.height }
  return Schema.is(AvatarCrop)(crop) ? crop : null
}

/** A read model's `avatarCrop`, present only when the card has chosen one for its avatar. */
export const avatarCropField = (avatarMediaId: unknown, stored: unknown): { avatarCrop?: AvatarCrop } => {
  const crop = avatarCropOf(avatarMediaId, stored)
  return crop === null ? {} : { avatarCrop: crop }
}
