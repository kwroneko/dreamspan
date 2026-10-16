/** Rounded up to bound the number of persistent derivatives of each immutable image. */
export const MEDIA_WIDTHS = [96, 192, 384, 768] as const

export const mediaWidth = (pixels: number) => MEDIA_WIDTHS.find((width) => width >= pixels) ?? 768
