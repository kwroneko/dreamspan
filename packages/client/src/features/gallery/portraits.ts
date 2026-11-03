import type { RefId } from "@rp/shared/library.ts"
import type { CardGallery } from "@rp/shared/gallery.ts"

export const galleryPortraits = (refId: string, gallery: typeof CardGallery.Type) =>
  gallery.images.map((image, index) => ({
    id: `gallery:${refId}:${encodeURIComponent(image.uri)}`,
    name: `${gallery.name} · ${image.name || `${index + 1} of ${gallery.images.length}`}`,
    mediaId: image.mediaId
  }))
export const galleryRef = (id: string) => /^gallery:([0-9a-f-]{36}):/.exec(id)?.[1] as RefId | undefined
