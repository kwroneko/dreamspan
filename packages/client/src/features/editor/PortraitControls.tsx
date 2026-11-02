// Setting a card's portrait (ARCHITECTURE.md §14.5c): a new image goes through the cutout
// chooser before it's saved, as ST's crop popup, and "Adjust cutout" chooses again for the
// image the card has. The image is stored whole; the cutout goes with the avatar's own action
// (`POST /library/avatar?crop=`) or SetCardAvatarCrop, never through a draft.
import { avatarCropOf, type AvatarCrop, cropKey } from "@rp/shared/media.ts"
import { Effect } from "effect"
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react"
import { Avatar, type AvatarSize } from "../../ui/Avatar.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { mediaUrl } from "../../ui/mediaImage.ts"
import { useCutoutChooser } from "../../ui/portraitParts.ts"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import type { Caller } from "./caller.ts"
import { usePortraitViewer } from "../../ui/Portrait.tsx"
import { type EditorStore, useEditorState, useText, useValue } from "./store.ts"

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp"

interface Choosing {
  readonly src: string
  /** A new image, uploaded with the cutout; null: the card's own, cut out again. */
  readonly file: File | null
  readonly initial: AvatarCrop | null
}

/** The card's portrait as the store has it, and the two ways of changing it. */
function usePortraitChange(store: EditorStore, call: Caller, onChanged?: () => void, pickerLabel?: string) {
  const { snapshot } = useEditorState(store)
  const name = useValue<string>(store, ["name"]) || snapshot?.ref.label || "Card"
  const mediaId = useValue<string | null>(store, ["avatar_media_id"]) ?? null
  const crop = avatarCropOf(mediaId, useValue<unknown>(store, ["avatar_crop"]))
  const [choosing, setChoosing] = useState<Choosing | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  // A picked file's object URL lives only while its chooser is open.
  useEffect(() => {
    const src = choosing?.file ? choosing.src : null
    return () => {
      if (src) URL.revokeObjectURL(src)
    }
  }, [choosing])

  const Chooser = useCutoutChooser()
  const pick = (file: File | undefined) => {
    if (!file) return
    setError(null)
    // Without a chooser (a plugin disabled it), the new picture has the default cutout.
    if (!Chooser) void save({ src: "", file, initial: null }, null)
    else setChoosing({ src: URL.createObjectURL(file), file, initial: null })
  }
  const adjust = () => {
    if (mediaId === null || !Chooser) return
    setError(null)
    setChoosing({ src: mediaUrl(mediaId), file: null, initial: crop })
  }

  async function save(target: Choosing, chosen: AvatarCrop | null) {
    if (!snapshot) return
    setPending(true)
    setError(null)
    const { ref } = snapshot
    let failure: string | null = null
    if (target.file) {
      const cut = chosen === null ? "" : `&crop=${cropKey(chosen)}`
      const response = await fetch(`/library/avatar?ref=${ref.id}&rowVersion=${ref.rowVersion}${cut}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: target.file
      }).catch(() => null)
      if (!response) failure = "The picture couldn't be sent: check the connection and try again."
      else if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: unknown }
        failure = typeof body.error === "string" ? body.error : "The picture couldn't be uploaded."
      } else await call(() => Effect.void, ["library"])
    } else {
      const result = await call(
        (client) => client("SetCardAvatarCrop", { refId: ref.id, crop: chosen, expectedRowVersion: ref.rowVersion }),
        ["library"]
      )
      if (!result.ok) failure = result.error.message
    }
    setPending(false)
    await store.refresh()
    if (failure !== null) setError(failure)
    else {
      setChoosing(null)
      onChanged?.()
    }
  }

  const chooser = choosing && Chooser && (
    <Chooser.component
      key={choosing.src}
      src={choosing.src}
      name={name}
      initial={choosing.initial}
      title={choosing.file ? `Cut out ${name}'s new picture` : `Adjust ${name}'s cutout`}
      saveLabel={choosing.file ? "Save picture" : "Save cutout"}
      pending={pending}
      error={error}
      onSave={(chosen) => void save(choosing, chosen)}
      onCancel={() => {
        setChoosing(null)
        setError(null)
      }}
    />
  )
  // The hidden picker a portrait's click opens: a label can't wrap a button.
  const input = (
    <input
      ref={picker}
      type="file"
      accept={ACCEPT}
      className="sr-only"
      tabIndex={-1}
      {...(pickerLabel ? { "aria-label": pickerLabel } : { "aria-hidden": true })}
      data-portrait-picker
      onChange={(event) => {
        pick(event.currentTarget.files?.[0])
        event.currentTarget.value = ""
      }}
    />
  )
  return {
    name,
    mediaId,
    crop,
    pick,
    adjust,
    openPicker: () => picker.current?.click(),
    chooser,
    input,
    /** A failure with no chooser open to show it. */
    error: choosing ? null : error,
    canAdjust: Chooser !== undefined && mediaId !== null,
    ready: snapshot !== null && !pending
  }
}

/**
 * The portrait as a button that changes it: a click picks a new image (then its cutout), with
 * a camera over it on hover and focus, and always on a touch screen, so the click is found.
 */
function ChangeablePortrait({
  id,
  name,
  mediaId,
  crop,
  size,
  disabled,
  alt = "",
  className = "",
  onClick
}: {
  alt?: string
  className?: string
  id: string
  name: string
  mediaId: string | null
  crop: AvatarCrop | null
  size: AvatarSize
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Tooltip label="Change the picture">
      <button
        type="button"
        aria-label={`Change ${name}'s picture`}
        disabled={disabled}
        data-change-portrait
        onClick={onClick}
        className={`group relative inline-flex shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60 ${className}`}
      >
        <Avatar id={id} name={name} mediaId={mediaId} crop={crop} size={size} alt={alt} />
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center rounded-sm bg-overlay text-accent-contrast opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:items-end pointer-coarse:justify-end pointer-coarse:bg-transparent pointer-coarse:p-0.5 pointer-coarse:opacity-100"
        >
          <span className="inline-flex rounded-full bg-overlay p-1">
            <Icon name="camera" size={14} />
          </span>
        </span>
      </button>
    </Tooltip>
  )
}

/** What a new picture can be, and what happens to it: the explanation of every way to add one. */
const PICTURE_HINT =
  "PNG, JPEG, GIF or WebP, up to 16 MB. You then choose the part small portraits show; the whole image is kept."

/** A portrait that takes a dropped image file: `over` while one is dragged over it. */
function useImageDrop(onFile: (file: File) => void, enabled: boolean) {
  const [over, setOver] = useState(false)
  const files = (event: DragEvent) => enabled && event.dataTransfer.types.includes("Files")
  return {
    over,
    props: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!files(event)) return
        event.preventDefault()
        setOver(true)
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!files(event)) return
        event.preventDefault()
        setOver(false)
        const file = event.dataTransfer.files[0]
        if (file) onFile(file)
      }
    }
  }
}

/**
 * The full editor's Picture (Metadata; owner, 2026-11-02: "not really made for a wide screen"):
 * one large portrait that is its own drop target, a click or Replace picking a new image, and
 * Replace and Adjust cutout over its corner; without a picture, a dashed 2:3 box of the same
 * size that adds one. What a picture can be is in the explanations, not a standing line.
 */
export function EditorPortrait({ store, call }: { store: EditorStore; call: Caller }) {
  const portrait = usePortraitChange(store, call, undefined, "Choose an avatar, or drop it here")
  const drop = useImageDrop(portrait.pick, portrait.ready)
  return (
    <div className="flex flex-col gap-2">
      <CardHeaderPortrait
        size="large"
        drop={drop}
        controls={
          portrait.mediaId !== null && (
            <>
              <IconButton
                icon="camera"
                label="Replace the picture"
                hint={`Replace the picture: choose another, or drop one on it. ${PICTURE_HINT}`}
                className="size-7! text-text!"
                disabled={!portrait.ready}
                onClick={portrait.openPicker}
              />
              {portrait.canAdjust && (
                <IconButton
                  icon="crop"
                  label="Adjust cutout"
                  hint="Adjust cutout: which part of the picture small portraits show"
                  className="size-7! text-text!"
                  disabled={!portrait.ready}
                  onClick={portrait.adjust}
                />
              )}
            </>
          )
        }
      >
        {portrait.mediaId ? (
          <ChangeablePortrait
            id="editor"
            alt="The card's avatar"
            name={portrait.name}
            mediaId={portrait.mediaId}
            crop={portrait.crop}
            size="fill"
            className="size-full"
            disabled={!portrait.ready}
            onClick={portrait.openPicker}
          />
        ) : (
          <Tooltip label={`Add a picture: choose one, or drop it here. ${PICTURE_HINT}`}>
            <button
              type="button"
              disabled={!portrait.ready}
              onClick={portrait.openPicker}
              className="flex size-full flex-col items-center justify-center gap-2 rounded-sm border-2 border-dashed border-border text-sm text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
            >
              <Icon name="camera" size={24} />
              Add a picture
            </button>
          </Tooltip>
        )}
      </CardHeaderPortrait>
      {portrait.input}
      {portrait.chooser}
      {portrait.error && (
        <p role="alert" className="max-w-48 text-sm text-danger">
          {portrait.error}
        </p>
      )}
    </div>
  )
}

/**
 * The full editor's header portrait: `TabPortrait` showing the card's own picture and cutout,
 * the same as a character tab's (owner, 2026-11-02: "the big version's header has the same
 * annoyances as the side bar one").
 */
export function StorePortrait({ store, call, id }: { store: EditorStore; call: Caller; id: string }) {
  const stored = useValue<unknown>(store, ["avatar_media_id"])
  const crop = avatarCropOf(stored, useValue<unknown>(store, ["avatar_crop"]))
  const name = useText(store, ["name"]) ?? ""
  const viewer = usePortraitViewer()
  const mediaId = typeof stored === "string" ? stored : null
  return (
    <TabPortrait
      store={store}
      call={call}
      id={id}
      shown={{ name, mediaId, crop }}
      size="page"
      onViewFull={viewer && mediaId !== null ? () => viewer.show({ id, name, mediaId }) : undefined}
    />
  )
}

/**
 * The portrait's box in a card's header (`CardHeader`), 2:3, sized by the header's width so it
 * is as tall as the names beside it: 136 px at the panel's narrowest, 144 from a 20rem header
 * (the panel's default width), 160 from 36rem; the full editor's page 144, then 176.
 */
const HEADER_PORTRAIT = {
  panel: "h-34 w-[calc(var(--spacing)*34*2/3)] @xs:h-36 @xs:w-24 @xl:h-40 @xl:w-[calc(var(--spacing)*40*2/3)]",
  page: "h-36 w-24 @xl:h-44 @xl:w-[calc(var(--spacing)*44*2/3)]",
  /** The full editor's Picture. */
  large: "h-72 w-48"
} as const

/**
 * The portrait's place in a card's header: the picture (`children`), with `badge` on it ("You
 * play" on the persona's, owner 2026-11-02, so its header has the same shape as any other) and
 * `controls` over its top corner, faint until the picture is hovered or a control has focus,
 * and always shown on a touch screen. Nothing takes room under it.
 */
export function CardHeaderPortrait({
  size = "panel",
  badge,
  controls,
  drop,
  children
}: {
  size?: keyof typeof HEADER_PORTRAIT
  badge?: ReactNode
  controls?: ReactNode
  /** An image dropped on it replaces the picture (`useImageDrop`). */
  drop?: ReturnType<typeof useImageDrop> | undefined
  children: ReactNode
}) {
  return (
    <div
      {...drop?.props}
      data-over={drop?.over || undefined}
      {...(size === "large" ? {} : { "data-card-header-portrait": true })}
      className={`group/portrait relative flex shrink-0 rounded-sm data-over:ring-2 data-over:ring-accent ${HEADER_PORTRAIT[size]}`}
    >
      {children}
      {badge && (
        <span className="pointer-events-none absolute bottom-1 left-1 max-w-[calc(100%-0.5rem)] truncate rounded-sm bg-accent px-1.5 text-[0.6875rem] leading-4 font-medium text-accent-contrast shadow-sm">
          {badge}
        </span>
      )}
      {controls && (
        <span
          data-portrait-controls
          className="absolute top-1 right-1 z-10 flex rounded-md border border-border bg-surface/85 text-text opacity-60 shadow-sm transition-opacity group-hover/portrait:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
        >
          {controls}
        </span>
      )}
    </div>
  )
}

/**
 * A character tab's portrait (owner, 2026-11-01: "clicking on the thumbnail in the sidebar
 * would open the UI to replace it"): a click changes the picture; Adjust cutout and View full
 * image sit over it (owner, 2026-11-02), with `badge` ("You play") on it.
 */
export function TabPortrait({
  store,
  call,
  id,
  shown,
  onViewFull,
  onChanged,
  adjust = true,
  badge,
  size = "panel"
}: {
  store: EditorStore
  call: Caller
  id: string
  /** What the chat shows: the cast's own copy of the card's name and portrait. */
  shown: { readonly name: string; readonly mediaId: string | null; readonly crop: AvatarCrop | null }
  onViewFull: (() => void) | undefined
  /** After a change is saved: the chat reads its cast again, so its portraits follow. */
  onChanged?: () => void
  /** Adjust cutout over it. */
  adjust?: boolean
  badge?: ReactNode
  size?: "panel" | "page"
}) {
  const portrait = usePortraitChange(store, call, onChanged)
  const drop = useImageDrop(portrait.pick, portrait.ready)
  const controls = shown.mediaId !== null && ((adjust && portrait.canAdjust) || onViewFull) && (
    <>
      {adjust && portrait.canAdjust && (
        <IconButton
          icon="crop"
          label="Adjust cutout"
          hint="Adjust cutout: which part of the picture small portraits show"
          className="size-7! text-text!"
          disabled={!portrait.ready}
          onClick={portrait.adjust}
        />
      )}
      {onViewFull && (
        <IconButton
          icon="expand"
          label="View full image"
          hint="View the full image beside the chat"
          className="size-7! text-text!"
          onClick={onViewFull}
        />
      )}
    </>
  )
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <CardHeaderPortrait size={size} badge={badge} controls={controls || undefined} drop={drop}>
        <ChangeablePortrait
          id={id}
          name={shown.name}
          mediaId={shown.mediaId}
          crop={shown.crop}
          size="fill"
          className="size-full"
          disabled={!portrait.ready}
          onClick={portrait.openPicker}
        />
      </CardHeaderPortrait>
      {portrait.input}
      {portrait.chooser}
      {portrait.error && (
        <p role="alert" className="max-w-24 text-xs text-danger">
          {portrait.error}
        </p>
      )}
    </div>
  )
}
