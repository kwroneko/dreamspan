// A portrait's cutout as replaceable parts (ARCHITECTURE.md §14.5c; spec/PLUGINS.md §8): the
// URL every small portrait loads, and the chooser that sets a cutout. Each is one registry
// entry with a fixed id, so a plugin can wrap or replace it (register the same id) and undo
// that; the built-ins below are what's in effect until one does.
import { type AvatarCrop, cropKey } from "@dreamspan/shared/media.ts"
import { type ComponentType, useSyncExternalStore } from "react"
import { makeRegistry } from "../registry.ts"
import { mediaUrl } from "./mediaImage.ts"

export interface PortraitThumbnail {
  readonly id: string
  /** A small portrait's image: `mediaId` at about `width` pixels, cut out as `crop` (null: the default). */
  readonly url: (mediaId: string, width: number, crop: AvatarCrop | null) => string
}

export const PORTRAIT_URL = "portrait.cutout-url"
export const portraitThumbnails = makeRegistry<PortraitThumbnail>()

/** The server's cutout derivative: the cutout is in the URL, so a changed one is another file. */
const cutoutUrl = (mediaId: string, width: number, crop: AvatarCrop | null) =>
  `${mediaUrl(mediaId, width)}&crop=${cropKey(crop)}`

portraitThumbnails.register({ id: PORTRAIT_URL, url: cutoutUrl })

export const portraitUrl = (mediaId: string, width: number, crop: AvatarCrop | null) =>
  (portraitThumbnails.get(PORTRAIT_URL)?.url ?? cutoutUrl)(mediaId, width, crop)

export interface CutoutChooserProps {
  /** The whole image: a stored one's original, or a picked file's object URL. */
  readonly src: string
  readonly name: string
  /** The cutout it has (null: the default), where the box starts. */
  readonly initial: AvatarCrop | null
  readonly title: string
  readonly saveLabel: string
  readonly pending: boolean
  readonly error: string | null
  readonly onSave: (crop: AvatarCrop) => void
  readonly onCancel: () => void
  /** Replace picture: a new image chosen in the dialog, whose cutout is chosen next. Absent: no replacing here. */
  readonly onReplace?: ((file: File) => void) | undefined
}

/** The image files a picture can be. */
export const PICTURE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp"

export interface CutoutChooser {
  readonly id: string
  readonly component: ComponentType<CutoutChooserProps>
}

export const CUTOUT_CHOOSER = "portrait.cutout-chooser"
/** The built-in (`CutoutChooser.tsx`) is registered by the editor feature, loaded when first opened. */
export const cutoutChoosers = makeRegistry<CutoutChooser>()

/** The chooser's entry in effect, or undefined while none is (a plugin disabled it). */
export const useCutoutChooser = () => {
  useSyncExternalStore(cutoutChoosers.subscribe, cutoutChoosers.snapshot)
  return cutoutChoosers.get(CUTOUT_CHOOSER)
}
