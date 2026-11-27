import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import {
  BACKGROUND_BLUR,
  BACKGROUND_OPACITY,
  CHAT_BACKGROUNDS_ROUTE,
  ChatBackgroundGallery,
  type ChatBackground
} from "@dreamspan/shared/chatBackgrounds.ts"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { Effect, Schema } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useEffect, useRef, useState } from "react"
import { useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { ContentImage } from "../../ui/ContentImage.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Select } from "../../ui/Select.tsx"
import { Slider } from "../../ui/Slider.tsx"
import { notifyDisplayPrefsChanged, useViewPrefs } from "../../ui/viewPrefs.ts"
import { activeBackground, backgroundUrl, previewBackground, useBackgroundPreview } from "./ChatBackdrop.tsx"

const changes = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("dreamspan.chatBackgrounds")

const backgroundRequest = async (path: string, options?: RequestInit) => {
  const response = await fetch(path, options)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? "The background request failed.")
  }
  return response
}
const readGallery = Schema.decodeUnknownSync(ChatBackgroundGallery)
const galleryFor = Atom.family((userId: string) =>
  AppClient.runtime
    .atom(
      Effect.tryPromise(async (signal) =>
        readGallery(await (await backgroundRequest(CHAT_BACKGROUNDS_ROUTE, { signal })).json())
      )
    )
    .pipe(AppClient.runtime.factory.withReactivity([`chatBackgrounds:${userId}`]))
)
const fits = [
  { value: "cover", label: "Cover" },
  { value: "contain", label: "Contain" },
  { value: "tile", label: "Tile" }
] as const
const choiceClass =
  "h-14 min-w-0 w-full justify-center gap-0 overflow-hidden rounded-md border px-1 text-xs whitespace-normal text-center"

function choiceStyle(pressed: boolean) {
  return `${choiceClass} ${pressed ? "border-accent ring-1 ring-accent" : "border-border"}`
}

export function ChatBackgroundSettings({ chatId }: { chatId?: ChatId | undefined }) {
  const userId = useSession().user.id
  const query = galleryFor(userId)
  const galleryResult = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  const action = useAction()
  const [uploadError, setUploadError] = useState<string | null>(null)
  const viewer = useViewPrefs()
  const dragged = useBackgroundPreview()
  const fileInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    changes?.addEventListener("message", refresh)
    window.addEventListener("focus", refresh)
    return () => {
      changes?.removeEventListener("message", refresh)
      window.removeEventListener("focus", refresh)
    }
  }, [refresh])
  useEffect(() => () => previewBackground(null), [])

  const gallery = AsyncResult.isSuccess(galleryResult) ? galleryResult.value : []
  const selected = chatId === undefined ? viewer.prefs.chatBackground.mediaId : viewer.prefs.chatBackgrounds[chatId]
  const appearance = { ...viewer.prefs.chatBackground, ...dragged }
  const enabled = viewer.ready && (activeBackground(viewer.prefs, chatId) !== null || gallery.length > 0)

  const choose = (mediaId: string | null | undefined) => {
    if (chatId === undefined) {
      if (mediaId !== undefined)
        void viewer.change(
          { chatBackground: { ...viewer.prefs.chatBackground, mediaId } },
          { chatBackground: { mediaId } }
        )
      return
    }
    const overrides = { ...viewer.prefs.chatBackgrounds }
    if (mediaId === undefined) delete overrides[chatId]
    else overrides[chatId] = mediaId
    void viewer.change(
      { chatBackgrounds: overrides },
      mediaId === undefined ? { inheritChatBackground: chatId } : { chatBackgrounds: { [chatId]: mediaId } }
    )
  }
  const setAppearance = (patch: Partial<Pick<ChatBackground, "opacity" | "fit" | "blur">>) =>
    viewer.change({ chatBackground: { ...viewer.prefs.chatBackground, ...patch } }, { chatBackground: patch })

  const changeGallery = async (path: string, options: RequestInit, invalidates: ReadonlyArray<string> = []) => {
    setUploadError(null)
    const result = await action.run(
      () =>
        Effect.tryPromise({
          try: (signal) => backgroundRequest(path, { ...options, signal }),
          catch: (error) => {
            if (error instanceof Error) setUploadError(error.message)
            return error
          }
        }),
      [`chatBackgrounds:${userId}`, ...invalidates]
    )
    if (result.ok) {
      changes?.postMessage("changed")
      if (invalidates.length) notifyDisplayPrefsChanged()
    }
  }

  return (
    <Fieldset
      legend={chatId ? "This chat’s background" : "Chat background"}
      about={
        chatId
          ? "Choose a background for this chat. Appearance controls apply to all chats."
          : "Default for chats and workshops."
      }
    >
      <div
        className="grid grid-cols-[repeat(auto-fill,minmax(5.25rem,1fr))] gap-2"
        aria-label="Background gallery"
        role="group"
      >
        {chatId && (
          <Button
            className={choiceStyle(selected === undefined)}
            aria-pressed={selected === undefined}
            disabled={!viewer.ready || action.pending}
            onClick={() => choose(undefined)}
          >
            Use default
          </Button>
        )}
        <Button
          className={choiceStyle(selected === null)}
          aria-pressed={selected === null}
          disabled={!viewer.ready || action.pending}
          onClick={() => choose(null)}
        >
          None (solid)
        </Button>
        {gallery.map(({ mediaId, name }) => (
          <div key={mediaId} className="relative min-w-0">
            <Button
              className={`relative ${choiceStyle(selected === mediaId)}`}
              aria-label={name}
              title={name}
              aria-pressed={selected === mediaId}
              disabled={!viewer.ready || action.pending}
              onClick={() => choose(mediaId)}
            >
              <ContentImage
                frameClassName="absolute inset-0"
                className="size-full object-cover"
                alt=""
                src={`${backgroundUrl(mediaId)}?w=160`}
                loading="lazy"
              />
            </Button>
            <button
              type="button"
              aria-label={`Remove ${name}`}
              title={`Remove ${name}`}
              disabled={action.pending}
              onClick={() =>
                void changeGallery(`${CHAT_BACKGROUNDS_ROUTE}/${encodeURIComponent(mediaId)}`, { method: "DELETE" }, [
                  "displayPrefs"
                ])
              }
              className="absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-sm bg-surface text-text shadow-sm hover:text-danger focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
      <input
        ref={fileInput}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/gif,image/webp"
        aria-label="Background image file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          if (file)
            void changeGallery(`${CHAT_BACKGROUNDS_ROUTE}?${new URLSearchParams({ name: file.name })}`, {
              method: "POST",
              headers: { "content-type": "application/octet-stream" },
              body: file
            })
        }}
      />
      <Button className="w-fit" onClick={() => fileInput.current?.click()} pending={action.pending}>
        Upload
      </Button>
      {AsyncResult.isFailure(galleryResult) && (
        <Button className="w-fit" onClick={() => refresh()}>
          Reload backgrounds
        </Button>
      )}
      {(uploadError ?? action.error ?? viewer.error) && (
        <p role="alert" className="text-sm text-danger">
          {uploadError ?? (action.error ?? viewer.error)?.message}
        </p>
      )}
      <Slider
        label="Message box opacity"
        value={appearance.opacity}
        min={BACKGROUND_OPACITY.min}
        max={BACKGROUND_OPACITY.max}
        step={1}
        disabled={!enabled}
        valueText={(value) => `${value}%`}
        onValueChange={(opacity) => previewBackground({ opacity })}
        onValueCommitted={(opacity) => {
          if (opacity !== viewer.prefs.chatBackground.opacity) void setAppearance({ opacity })
          previewBackground(null)
        }}
      />
      <Button
        className="w-fit"
        variant="ghost"
        disabled={!enabled || appearance.opacity === BACKGROUND_OPACITY.default}
        onClick={() => void setAppearance({ opacity: BACKGROUND_OPACITY.default })}
      >
        Reset opacity to {BACKGROUND_OPACITY.default}%
      </Button>
      <Select
        ariaLabel="Fit"
        value={appearance.fit}
        disabled={!enabled}
        items={fits}
        onValueChange={(fit) => void setAppearance({ fit })}
      />
      <Slider
        label="Background blur"
        value={appearance.blur}
        min={BACKGROUND_BLUR.min}
        max={BACKGROUND_BLUR.max}
        step={1}
        disabled={!enabled}
        valueText={(value) => `${value} px`}
        onValueChange={(blur) => previewBackground({ blur })}
        onValueCommitted={(blur) => {
          if (blur !== viewer.prefs.chatBackground.blur) void setAppearance({ blur })
          previewBackground(null)
        }}
      />
    </Fieldset>
  )
}
