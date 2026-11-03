import { Schema } from "effect"
import type { CardDoc } from "./docs/card.ts"

export const CardGallery = Schema.Struct({
  name: Schema.String,
  images: Schema.Array(Schema.Struct({ uri: Schema.String, name: Schema.String, mediaId: Schema.String }))
})
export const AssetKind = Schema.Literals(["icon", "user_icon", "emotion", "background", "other"])
export const AssetChange = Schema.Union([
  Schema.Struct({ action: Schema.Literal("rename"), name: Schema.String.check(Schema.isMaxLength(255)) }),
  Schema.Struct({ action: Schema.Literal("kind"), kind: AssetKind }),
  Schema.Struct({ action: Schema.Literal("portrait") }),
  Schema.Struct({ action: Schema.Literal("remove") })
])

/** The main icon has its own portrait control; every other stored image is in the gallery. */
export const galleryAssets = (card: Pick<CardDoc, "assets" | "asset_media_ids">) =>
  (card.assets ?? []).filter(
    (asset) =>
      !(asset.type.toLowerCase() === "icon" && asset.name.toLowerCase() === "main") &&
      typeof card.asset_media_ids?.[asset.uri] === "string"
  )

export const assetGroup = (kind: string) => {
  switch (kind.toLowerCase()) {
    case "icon":
    case "user_icon":
      return "Portraits"
    case "emotion":
      return "Expressions"
    case "background":
      return "Backgrounds"
    default:
      return "Other"
  }
}
