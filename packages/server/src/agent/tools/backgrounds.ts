import { Type, type Static } from "@earendil-works/pi-ai"
import { Effect } from "effect"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import {
  type ChatBackgroundEntry,
  type SceneBackground,
  sceneBackgroundName
} from "@dreamspan/shared/chatBackgrounds.ts"
import { resolveChat } from "../exposures/builtins.ts"
import { savedToolResult } from "../toolData.ts"
import type { RolloutTool, ToolContext, ToolOutput } from "../tools.ts"
import { posix } from "node:path"

const strict = { additionalProperties: false } as const
const backgroundName = Type.String({ minLength: 1, maxLength: 255 })

const readGalleries = (ctx: ToolContext, chatId?: ChatId) =>
  Effect.gen(function* () {
    const global = yield* ctx.reader.ListChatBackgrounds({ userId: ctx.userId })
    const local = chatId === undefined ? [] : yield* ctx.reader.ListChatBackgrounds({ userId: ctx.userId, chatId })
    return { local, global }
  })

const findImage = (
  name: string,
  { local, global }: { local: ReadonlyArray<ChatBackgroundEntry>; global: ReadonlyArray<ChatBackgroundEntry> }
) =>
  Effect.gen(function* () {
    const byId = [...local, ...global].find((entry) => entry.mediaId === name)
    if (byId) return byId
    for (const entries of [local, global]) {
      const matches = entries.filter((entry) => entry.name.toLowerCase() === name.toLowerCase())
      if (matches.length === 1) return matches[0]!
      if (matches.length > 1)
        return yield* Effect.fail(
          new Error("Several images have that name. List backgrounds and select one by mediaId.")
        )
    }
    return yield* Effect.fail(new Error("No available image has that name or mediaId. Use list to see your choices."))
  })

const safely = <E>(effect: Effect.Effect<ToolOutput, E>) =>
  effect.pipe(
    Effect.catch((error) => {
      const failure = error as { _tag?: string; message?: string }
      const text =
        failure._tag === "NotFound"
          ? "That chat or background is unavailable."
          : failure._tag === "StorageError" || failure._tag === "RpcClientError"
            ? "The background change could not be saved."
            : (failure.message ?? "The background change could not be saved.")
      return Effect.succeed({ text, isError: true })
    })
  )

const isSolid = (choice: string) => choice === "solid" || choice === "none"

export const setChatBackground: RolloutTool<{ background: string }> = {
  source: import.meta.url,
  id: "set_chat_background",
  label: "Set scene background",
  effect: "chat_state",
  explanation: "Change the scene background using this chat’s images or the global gallery.",
  description:
    "Change the scene background for this reply and the messages that follow it. Give a gallery image name or mediaId, solid for a plain background, default to follow the account setting again, or list to see the available images. Chat-local images are searched first.",
  parameters: Type.Object({ background: backgroundName }, strict),
  summarize: ({ background }) => background,
  execute: (ctx, { background }) =>
    safely(
      Effect.gen(function* () {
        const selection = background.trim()
        if (selection === "list") return { text: JSON.stringify(yield* readGalleries(ctx, ctx.chatId)) }
        let value: SceneBackground
        if (selection === "default") value = { mode: "default" }
        else if (isSolid(selection)) value = { mode: "solid" }
        else {
          const { mediaId, name } = yield* findImage(selection, yield* readGalleries(ctx, ctx.chatId))
          value = { mode: "image", mediaId, name }
        }
        const saved = yield* ctx.writer.ApplyRolloutEffect({
          userId: ctx.userId,
          rolloutId: ctx.rolloutId,
          toolCallId: ctx.toolCallId,
          events: [{ key: "chat.background", value }],
          result: savedToolResult(ctx, `Background: ${sceneBackgroundName(value)}`)
        })
        return { text: saved.result }
      })
    )
}

const setupParameters = Type.Object(
  {
    scope: Type.Optional(Type.Union([Type.Literal("default"), Type.Literal("workshop"), Type.Literal("chat")])),
    chat: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    background: Type.Optional(backgroundName),
    file: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    name: Type.Optional(backgroundName),
    opacity: Type.Optional(Type.Integer({ minimum: 50, maximum: 100 })),
    fit: Type.Optional(Type.Union([Type.Literal("cover"), Type.Literal("contain"), Type.Literal("tile")])),
    blur: Type.Optional(Type.Integer({ minimum: 0, maximum: 16 }))
  },
  strict
)

export const setBackground: RolloutTool<Static<typeof setupParameters>> = {
  source: import.meta.url,
  id: "set_background",
  label: "Change a background",
  effect: "setup",
  capability: "chats.setup",
  replyTool: false,
  storyRead: "account",
  parameters: setupParameters,
  description:
    "Change a background with Undo. Scope is default (main account background), workshop (workshop account background), or chat (the current chat, or a chat name/id). Use background with an image name/mediaId, solid, inherit (workshop or chat), or list. Or provide a PNG, JPEG, GIF or WebP file under /files or /attachments, and an optional gallery name. For default or workshop you can also change account-wide opacity (50–100), fit or blur (0–16).",
  summarize: ({ scope, background, file }) => [scope ?? "default", background ?? file].filter(Boolean).join(" · "),
  mustAsk: (ctx, { file }) =>
    file === undefined
      ? Effect.succeed(false)
      : ctx.reader
          .WorkshopGrants({
            userId: ctx.userId,
            chatId: ctx.chatId,
            now: Date.now()
          })
          .pipe(Effect.map((grants) => grants.some((grant) => grant.capability === "files" && grant.mode === "ask"))),
  describe: (_ctx, { scope, chat, background, file, fit, opacity, blur }) =>
    Effect.succeed({
      title: "Change a background",
      rows: Object.entries({ scope: scope ?? "default", chat, background, file, fit, opacity, blur })
        .filter(([, value]) => value !== undefined)
        .map(([label, value]) => ({ label, value: String(value) })),
      ...(file === undefined ? {} : { once: true })
    }),
  execute: (ctx, { scope = "default", chat, background, file, name, ...appearance }) =>
    safely(
      Effect.gen(function* () {
        const key = { userId: ctx.userId, rolloutId: ctx.rolloutId, toolCallId: ctx.toolCallId }
        const receipt = yield* ctx.reader.RolloutToolReceipt(key)
        if (receipt) return { ...receipt, replayed: true }
        if (chat !== undefined && scope !== "chat")
          return yield* Effect.fail(new Error("Use scope chat to name a chat."))
        if (scope === "chat" && Object.keys(appearance).length > 0)
          return yield* Effect.fail(new Error("Use scope default or workshop for account-wide appearance."))
        if (file !== undefined && background !== undefined)
          return yield* Effect.fail(new Error("Give either an existing background or a file."))
        if (file === undefined && background === undefined && Object.keys(appearance).length === 0)
          return yield* Effect.fail(new Error("Give a background, a file or appearance settings."))
        if (name !== undefined && file === undefined)
          return yield* Effect.fail(new Error("Give a gallery name only when importing a file."))
        const chatId =
          scope === "chat" ? (chat === undefined ? ctx.chatId : (yield* resolveChat(ctx, chat)).id) : undefined
        const selection = background?.trim()
        if (selection === "list") {
          const prefs = yield* ctx.reader.GetDisplayPrefs({ userId: ctx.userId })
          const galleries = yield* readGalleries(ctx, chatId)
          return {
            text: JSON.stringify({
              ...galleries,
              main: prefs.chatBackground,
              workshop: prefs.workshopBackground,
              ...(chatId === undefined
                ? {}
                : { chat: prefs.chatBackgrounds[chatId] === undefined ? "inherit" : prefs.chatBackgrounds[chatId] })
            })
          }
        }
        const choice =
          selection === undefined || selection === "inherit"
            ? selection
            : isSolid(selection)
              ? null
              : (yield* findImage(selection, yield* readGalleries(ctx, chatId))).mediaId
        const path = file?.trim()
        const label = path === undefined ? undefined : name?.trim() || posix.basename(path).slice(0, 255)
        const save = (
          media?: NonNullable<Parameters<ToolContext["writer"]["AgentSetBackground"]>[0]["imported"]>["media"]
        ) =>
          ctx.writer
            .AgentSetBackground({
              ...key,
              ...(ctx.approvalDigest === undefined ? {} : { approvalDigest: ctx.approvalDigest }),
              scope,
              ...(chatId === undefined ? {} : { chatId }),
              ...(choice === undefined ? {} : { choice }),
              appearance,
              ...(media === undefined ? {} : { imported: { media, name: label! } }),
              result: savedToolResult(ctx, "Saved the background.")
            })
            .pipe(
              Effect.tap(() => Effect.sync(() => ctx.onDisplayChanged?.())),
              Effect.uninterruptible
            )
        let text: string
        if (path === undefined) text = yield* save()
        else {
          if (!/^\/(files|attachments)\/.+/.test(path) || path.split("/").includes(".."))
            return yield* Effect.fail(
              new Error("Use a file under /files or /attachments without parent-directory segments.")
            )
          if (!ctx.portraits) return yield* Effect.fail(new Error("Background files are unavailable in this workshop."))
          text = yield* ctx.portraits.background(ctx, path, save)
        }
        return { text }
      })
    )
}
