import { Schema } from "effect"

const BACKGROUND_FITS = ["cover", "contain", "tile"] as const
export const BACKGROUND_OPACITY = { min: 50, max: 100, default: 85 } as const
export const BACKGROUND_BLUR = { min: 0, max: 16, default: 0 } as const

const MediaChoice = Schema.NullOr(Schema.String.check(Schema.isMaxLength(100)))
export const WorkshopBackground = MediaChoice

export const SceneBackground = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("image"),
    mediaId: Schema.String.check(Schema.isMaxLength(100)),
    name: Schema.String.check(Schema.isMaxLength(255))
  }),
  Schema.Struct({ mode: Schema.Literal("solid") }),
  Schema.Struct({ mode: Schema.Literal("default") })
])
export type SceneBackground = typeof SceneBackground.Type
export const sceneBackgroundName = (scene: SceneBackground) =>
  scene.mode === "image" ? scene.name : scene.mode === "solid" ? "Solid" : "Default"

const Fit = Schema.Literals(BACKGROUND_FITS)

export const ChatBackground = Schema.Struct({
  mediaId: MediaChoice,
  opacity: Schema.Int.check(Schema.isBetween({ minimum: BACKGROUND_OPACITY.min, maximum: BACKGROUND_OPACITY.max })),
  fit: Fit,
  blur: Schema.Int.check(Schema.isBetween({ minimum: BACKGROUND_BLUR.min, maximum: BACKGROUND_BLUR.max }))
})
export type ChatBackground = typeof ChatBackground.Type

export const DEFAULT_CHAT_BACKGROUND: ChatBackground = {
  mediaId: null,
  opacity: BACKGROUND_OPACITY.default,
  fit: "cover",
  blur: BACKGROUND_BLUR.default
}

export const ChatBackgroundChange = Schema.Struct({
  mediaId: Schema.optionalKey(MediaChoice),
  opacity: Schema.optionalKey(Schema.Finite),
  fit: Schema.optionalKey(Fit),
  blur: Schema.optionalKey(Schema.Finite)
})

export const MAX_BACKGROUND_OVERRIDES = 500
export const ChatBackgroundOverrides = Schema.Record(Schema.String.check(Schema.isMaxLength(100)), MediaChoice).check(
  Schema.isMaxProperties(MAX_BACKGROUND_OVERRIDES)
)

export const ChatBackgroundEntry = Schema.Struct({
  mediaId: Schema.String,
  name: Schema.String.check(Schema.isMaxLength(255)),
  addedAt: Schema.Int
})
export type ChatBackgroundEntry = typeof ChatBackgroundEntry.Type
export const ChatBackgroundGallery = Schema.Array(ChatBackgroundEntry)
export const CHAT_BACKGROUNDS_ROUTE = "/api/chat-backgrounds"
export const CHAT_BACKGROUND_MEDIA_ROUTE = "/api/media/chat-backgrounds"
