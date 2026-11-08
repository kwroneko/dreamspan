// Setting a card's portrait (ARCHITECTURE.md §14.5c; owner, 2026-11-02): a click on the
// portrait opens its whole image in the viewer; one Picture button over its lower-right corner
// opens the Picture dialog (the cutout chooser), which adjusts the cutout and replaces the
// picture, a new one going straight to choosing its cutout. The image is stored whole; the cutout goes with the avatar's own action
// (`POST /library/avatar?crop=`) or SetCardAvatarCrop, never through a draft.
import { avatarCropOf, type AvatarCrop, cropKey } from "@rp/shared/media.ts"
import { Effect } from "effect"
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { mediaUrl } from "../../ui/mediaImage.ts"
import { PICTURE_ACCEPT, useCutoutChooser } from "../../ui/portraitParts.ts"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import type { Caller } from "./caller.ts"
import { useOpenPortrait } from "../../ui/Portrait.tsx"
import { carryOnDrag, isAppDrag, PICTURE_DRAG } from "../../ui/appDrags.ts"
import { pictureHref } from "../chat/PicturePage.tsx"
import { type EditorStore, useEditorState, useText, useValue } from "./store.ts"

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
      const cut =
        chosen === null ? "" : `&crop=${cropKey(chosen)}${chosen.picture ? `&picture=${cropKey(chosen.picture)}` : ""}`
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
      title={choosing.file ? `${name}'s new picture` : `${name}'s picture`}
      saveLabel={choosing.file ? "Save picture" : "Save cutout"}
      pending={pending}
      error={error}
      onSave={(chosen) => void save(choosing, chosen)}
      onReplace={pick}
      onCancel={() => {
        setChoosing(null)
        setError(null)
      }}
    />
  )
  // The hidden picker the Picture button opens while there's no picture: a label can't wrap a button.
  const input = (
    <input
      ref={picker}
      type="file"
      accept={PICTURE_ACCEPT}
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
    /** The Picture button: the dialog over the picture there is, else straight to choosing one. */
    openPicture: () => (mediaId !== null && Chooser ? adjust() : picker.current?.click()),
    chooser,
    input,
    /** A failure with no chooser open to show it. */
    error: choosing ? null : error,
    canAdjust: Chooser !== undefined && mediaId !== null,
    ready: snapshot !== null && !pending
  }
}

/**
 * The portrait as a button that opens its whole image in the viewer (owner, 2026-11-02: "Clicking
 * the portrait itself opens the enlarged image"); a plain portrait while there's no image.
 */
function ViewablePortrait({
  id,
  name,
  mediaId,
  crop,
  alt = ""
}: {
  alt?: string
  id: string
  name: string
  mediaId: string | null
  crop: AvatarCrop | null
}) {
  const togglePortrait = useOpenPortrait()
  const avatar = (
    <Avatar id={id} name={name} mediaId={mediaId} crop={crop} size="fill" className="size-full" alt={alt} />
  )
  if (mediaId === null || !togglePortrait) return avatar
  return (
    <Tooltip label="View the whole picture">
      <button
        type="button"
        aria-label={`View ${name}'s picture`}
        data-view-portrait
        onClick={() => togglePortrait({ id, name, mediaId, picture: crop?.picture })}
        // Dropped on a frame, the picture opens there as a tab (owner, 2026-11-07).
        onDragStart={(event) =>
          carryOnDrag(event.dataTransfer, PICTURE_DRAG.id, pictureHref({ id, name, mediaId, picture: crop?.picture }))
        }
        className="relative inline-flex size-full shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {avatar}
      </button>
    </Tooltip>
  )
}

/** The one button over every editable portrait's lower-right corner. */
function PictureButton({ portrait }: { portrait: ReturnType<typeof usePortraitChange> }) {
  return (
    <IconButton
      icon="image"
      label="Picture"
      hint={
        portrait.mediaId !== null
          ? "Picture: crop the picture and small portrait, or replace the picture"
          : `Picture: add one. ${PICTURE_HINT}`
      }
      data-picture-button
      className="size-7! text-text!"
      disabled={!portrait.ready}
      onClick={portrait.openPicture}
    />
  )
}

/** What a new picture can be, and what happens to it: the explanation of every way to add one. */
const PICTURE_HINT = "PNG, JPEG, GIF or WebP, up to 16 MB. Choose the picture and portrait cuts; the original is kept."

/** A portrait that takes a dropped image file: `over` while one is dragged over it. */
function useImageDrop(onFile: (file: File) => void, enabled: boolean) {
  const [over, setOver] = useState(false)
  // A file from outside; the app's own picture dragged here is no new one.
  const files = (event: DragEvent) =>
    enabled && event.dataTransfer.types.includes("Files") && !isAppDrag(event.dataTransfer)
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
 * one large portrait that is its own drop target, a click opening the whole image, and the
 * Picture button over its lower-right corner; without a picture, a dashed 2:3 box of the same
 * size that adds one. What a picture can be is in the explanations, not a standing line.
 */
export function EditorPortrait({ store, call }: { store: EditorStore; call: Caller }) {
  const portrait = usePortraitChange(store, call, undefined, "Choose an avatar, or drop it here")
  const drop = useImageDrop(portrait.pick, portrait.ready)
  const { snapshot } = useEditorState(store)
  return (
    <div className="flex flex-col gap-2">
      <CardHeaderPortrait
        size="large"
        drop={drop}
        controls={portrait.mediaId !== null && <PictureButton portrait={portrait} />}
      >
        {portrait.mediaId ? (
          <ViewablePortrait
            id={snapshot?.ref.entityId ?? "editor"}
            alt="The card's avatar"
            name={portrait.name}
            mediaId={portrait.mediaId}
            crop={portrait.crop}
          />
        ) : (
          <Tooltip label={`Add a picture: choose one, or drop it here. ${PICTURE_HINT}`}>
            <button
              type="button"
              disabled={!portrait.ready}
              onClick={portrait.openPicker}
              className="flex size-full flex-col items-center justify-center gap-2 rounded-sm border-2 border-dashed border-border text-sm text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
            >
              <Icon name="image" size={24} />
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
export function StorePortrait({
  store,
  call,
  id,
  badge
}: {
  store: EditorStore
  call: Caller
  id: string
  badge?: ReactNode
}) {
  const stored = useValue<unknown>(store, ["avatar_media_id"])
  const crop = avatarCropOf(stored, useValue<unknown>(store, ["avatar_crop"]))
  const name = useText(store, ["name"]) ?? ""
  const mediaId = typeof stored === "string" ? stored : null
  return <TabPortrait store={store} call={call} id={id} shown={{ name, mediaId, crop }} badge={badge} size="page" />
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
 * The portrait's place in a card's header: the picture (`children`), with the shared persona `badge` on it ("You"
 * for the selected chat persona, "Persona" for folder membership outside the chat) and
 * `controls` (the Picture button) over its lower-right corner, faint until the picture is
 * hovered or the button has focus, and always shown on a touch screen. Nothing takes room under it.
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
      {badge}
      {controls && (
        <span
          data-portrait-controls
          data-layout-overlay="The Picture button sits over the picture's corner"
          data-layout-audit-ignore="inset: A compact icon toolbar whose buttons are the segments of its frame; overlay: The toolbar's frame is the one backing its buttons share"
          className="absolute right-1 bottom-1 z-10 flex rounded-md border border-border bg-surface/85 text-text opacity-60 shadow-sm transition-opacity group-hover/portrait:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
        >
          {controls}
        </span>
      )}
    </div>
  )
}

/**
 * An editable portrait in a card's header (a character's or persona's tab, the full editor's
 * header): a click opens the whole image, the Picture button over its lower-right corner
 * changes it, and an image dropped on it replaces it; the shared persona `badge` on it.
 */
export function TabPortrait({
  store,
  call,
  id,
  shown,
  onChanged,
  badge,
  size = "panel"
}: {
  store: EditorStore
  call: Caller
  id: string
  /** What the chat shows: the cast's own copy of the card's name and portrait. */
  shown: { readonly name: string; readonly mediaId: string | null; readonly crop: AvatarCrop | null }
  /** After a change is saved: the chat reads its cast again, so its portraits follow. */
  onChanged?: () => void
  badge?: ReactNode
  size?: "panel" | "page"
}) {
  const portrait = usePortraitChange(store, call, onChanged)
  const drop = useImageDrop(portrait.pick, portrait.ready)
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <CardHeaderPortrait size={size} badge={badge} controls={<PictureButton portrait={portrait} />} drop={drop}>
        <ViewablePortrait id={id} name={shown.name} mediaId={shown.mediaId} crop={shown.crop} />
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
