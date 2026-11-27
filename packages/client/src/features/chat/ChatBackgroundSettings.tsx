import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import {
  BACKGROUND_BLUR,
  BACKGROUND_OPACITY,
  CHAT_BACKGROUNDS_ROUTE,
  ChatBackgroundGallery,
  sceneBackgroundName,
  type SceneBackground,
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
import { onDisplayPrefsChanged, useViewPrefs } from "../../ui/viewPrefs.ts"
import { backgroundUrl, previewBackground, useBackgroundPreview } from "./ChatBackdrop.tsx"

const backgroundRequest = async (path: string, options?: RequestInit) => {
  const response = await fetch(path, options)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? "The background request failed.")
  }
  return response
}
const readGallery = Schema.decodeUnknownSync(ChatBackgroundGallery)
const galleryPath = (chatId?: ChatId, mediaId?: string, name?: string) => {
  const params = new URLSearchParams()
  if (chatId !== undefined) params.set("chatId", chatId)
  if (name !== undefined) params.set("name", name)
  const path =
    mediaId === undefined ? CHAT_BACKGROUNDS_ROUTE : `${CHAT_BACKGROUNDS_ROUTE}/${encodeURIComponent(mediaId)}`
  return params.size === 0 ? path : `${path}?${params}`
}
const galleryFor = Atom.family((key: string) => {
  const [userId, chatId] = JSON.parse(key) as [string, ChatId?]
  return AppClient.runtime
    .atom(
      Effect.tryPromise(async (signal) =>
        readGallery(await (await backgroundRequest(galleryPath(chatId ?? undefined), { signal })).json())
      )
    )
    .pipe(AppClient.runtime.factory.withReactivity([galleryKey(userId)]))
})
const galleryKey = (userId: string) => `chatBackgrounds:${userId}`

function useGallery(chatId?: ChatId) {
  const userId = useSession().user.id
  const query = galleryFor(JSON.stringify([userId, chatId]))
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  useEffect(() => {
    const stop = onDisplayPrefsChanged(refresh)
    window.addEventListener("focus", refresh)
    return () => {
      stop()
      window.removeEventListener("focus", refresh)
    }
  }, [refresh])
  return {
    items: AsyncResult.isSuccess(result) ? result.value : [],
    failed: AsyncResult.isFailure(result),
    refresh
  }
}
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

type GalleryItems = typeof ChatBackgroundGallery.Type

function Gallery({
  label,
  items,
  selected,
  choose,
  disabled,
  remove
}: {
  label: string
  items: GalleryItems
  selected: string | null | undefined
  choose: (id: string) => void
  disabled: boolean
  remove?: (id: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(5.25rem,1fr))] gap-2" aria-label={label} role="group">
      {items.map(({ mediaId, name }) => (
        <div key={mediaId} className="relative min-w-0">
          <Button
            className={`relative ${choiceStyle(selected === mediaId)}`}
            aria-label={name}
            title={name}
            aria-pressed={selected === mediaId}
            disabled={disabled}
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
          {remove && (
            <button
              type="button"
              aria-label={`Remove ${name}`}
              title={`Remove ${name}`}
              disabled={disabled}
              onClick={() => remove(mediaId)}
              className="absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-sm bg-surface text-text shadow-sm hover:text-danger focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function BackgroundChoice({
  label,
  pressed,
  disabled,
  choose
}: {
  label: string
  pressed: boolean
  disabled: boolean
  choose: () => void
}) {
  return (
    <Button className={choiceStyle(pressed)} aria-pressed={pressed} disabled={disabled} onClick={choose}>
      {label}
    </Button>
  )
}

function ManagedGallery({
  gallery,
  chatId,
  label,
  selected,
  disabled,
  choose
}: {
  gallery: ReturnType<typeof useGallery>
  chatId?: ChatId
  label: string
  selected: string | null | undefined
  disabled: boolean
  choose: (id: string) => void
}) {
  const userId = useSession().user.id
  const action = useAction()
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const change = async (path: string, options: RequestInit) => {
    setError(null)
    return action.run(
      () =>
        Effect.tryPromise({
          try: async (signal) => {
            const response = await backgroundRequest(path, { ...options, signal })
            return response.status === 204 ? null : ((await response.json()) as { mediaId: string }).mediaId
          },
          catch: (cause) => {
            if (cause instanceof Error) setError(cause.message)
            return cause
          }
        }),
      [galleryKey(userId), "displayPrefs"]
    )
  }

  return (
    <>
      <Gallery
        label={label}
        items={gallery.items}
        selected={selected}
        choose={choose}
        disabled={disabled || action.pending}
        remove={(id) => void change(galleryPath(chatId, id), { method: "DELETE" })}
      />
      <input
        ref={input}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/gif,image/webp"
        aria-label={chatId === undefined ? "Background image file" : "This chat’s background image file"}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          if (file)
            void change(galleryPath(chatId, undefined, file.name), {
              method: "POST",
              headers: { "content-type": "application/octet-stream" },
              body: file
            }).then((result) => {
              if (chatId !== undefined && result.ok && result.value !== null) choose(result.value)
            })
        }}
      />
      <Button className="w-fit" onClick={() => input.current?.click()} disabled={disabled} pending={action.pending}>
        {chatId === undefined ? "Upload" : "Upload for this chat"}
      </Button>
      {gallery.failed && (
        <Button className="w-fit" onClick={() => gallery.refresh()}>
          Reload backgrounds
        </Button>
      )}
      {(error ?? action.error?.message) && (
        <p role="alert" className="text-sm text-danger">
          {error ?? action.error?.message}
        </p>
      )}
    </>
  )
}

export function ThisChatBackgroundSettings({ chatId, scene }: { chatId: ChatId; scene?: SceneBackground | undefined }) {
  const viewer = useViewPrefs()
  const local = useGallery(chatId)
  const global = useGallery()
  const selected = viewer.prefs.chatBackgrounds[chatId]
  const disabled = !viewer.ready || viewer.pending
  const choose = (mediaId: string | null | undefined) => {
    const overrides = { ...viewer.prefs.chatBackgrounds }
    if (mediaId === undefined) delete overrides[chatId]
    else overrides[chatId] = mediaId
    void viewer.change(
      { chatBackgrounds: overrides },
      mediaId === undefined ? { inheritChatBackground: chatId } : { chatBackgrounds: { [chatId]: mediaId } }
    )
  }
  const followsScene = scene !== undefined && scene.mode !== "default"
  return (
    <Fieldset legend="This chat’s background">
      {selected === undefined && followsScene && (
        <p className="text-sm text-muted">Active from scene: {sceneBackgroundName(scene)}</p>
      )}
      <div className="grid w-full max-w-sm grid-cols-2 gap-2">
        <BackgroundChoice
          label={followsScene ? "Follow scene" : "Use default"}
          pressed={selected === undefined}
          disabled={disabled}
          choose={() => choose(undefined)}
        />
        <BackgroundChoice
          label="None (solid)"
          pressed={selected === null}
          disabled={disabled}
          choose={() => choose(null)}
        />
      </div>
      <h3 className="text-sm font-medium text-text">This chat’s images</h3>
      <ManagedGallery
        gallery={local}
        chatId={chatId}
        label="This chat’s images"
        selected={selected}
        choose={choose}
        disabled={disabled}
      />
      <h3 className="text-sm font-medium text-text">Global gallery</h3>
      <Gallery label="Global gallery" items={global.items} selected={selected} choose={choose} disabled={disabled} />
      {viewer.error && (
        <p role="alert" className="text-sm text-danger">
          {viewer.error.message}
        </p>
      )}
    </Fieldset>
  )
}

export function ChatBackgroundSettings() {
  const viewer = useViewPrefs()
  const gallery = useGallery()
  const dragged = useBackgroundPreview()
  useEffect(() => () => previewBackground(null), [])
  const main = viewer.prefs.chatBackground.mediaId
  const workshop = viewer.prefs.workshopBackground
  const appearance = { ...viewer.prefs.chatBackground, ...dragged }
  const disabled = !viewer.ready || viewer.pending
  const enabled = viewer.ready
  const choose = (mediaId: string | null) => void viewer.change({ chatBackground: { mediaId } })

  const setAppearance = (patch: Partial<Pick<ChatBackground, "opacity" | "fit" | "blur">>) =>
    viewer.change({ chatBackground: patch })

  return (
    <>
      <Fieldset legend="Chat background (default)" about="Main background for all your chats.">
        <div className="grid w-full max-w-sm grid-cols-2 gap-2">
          <BackgroundChoice
            label="None (solid)"
            pressed={main === null}
            disabled={disabled}
            choose={() => choose(null)}
          />
        </div>
        <ManagedGallery
          gallery={gallery}
          label="Background gallery"
          selected={main}
          choose={choose}
          disabled={disabled}
        />
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
      <Fieldset legend="Workshop background" about="Applies to workshops across your account.">
        <div className="grid w-full max-w-sm grid-cols-2 gap-2">
          <BackgroundChoice
            label="Inherit main background"
            pressed={workshop === "inherit"}
            disabled={disabled}
            choose={() => void viewer.change({ workshopBackground: "inherit" })}
          />
          <BackgroundChoice
            label="None (solid)"
            pressed={workshop === null}
            disabled={disabled}
            choose={() => void viewer.change({ workshopBackground: null })}
          />
        </div>
        <Gallery
          label="Workshop background choices"
          items={gallery.items}
          selected={workshop}
          choose={(mediaId) => void viewer.change({ workshopBackground: mediaId })}
          disabled={disabled}
        />
        {viewer.error && (
          <p role="alert" className="text-sm text-danger">
            {viewer.error.message}
          </p>
        )}
      </Fieldset>
    </>
  )
}
