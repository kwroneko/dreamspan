// Setting a card's portrait (ARCHITECTURE.md §14.5c): a new image goes through the cutout
// chooser before it's saved, as ST's crop popup, and "Adjust cutout" chooses again for the
// image the card has. The image is stored whole; the cutout goes with the avatar's own action
// (`POST /library/avatar?crop=`) or SetCardAvatarCrop, never through a draft.
import { avatarCropOf, type AvatarCrop, cropKey } from "@rp/shared/media.ts"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"
import { Avatar, type AvatarSize } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { FileDrop } from "../../ui/FileDrop.tsx"
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
function usePortraitChange(store: EditorStore, call: Caller, onChanged?: () => void) {
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
      aria-hidden="true"
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
  onClick
}: {
  alt?: string
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
        className="group relative inline-flex shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
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

/** The card editor's portrait: the picture (a click changes it), a drop zone, Adjust cutout. */
export function EditorPortrait({ store, call }: { store: EditorStore; call: Caller }) {
  const portrait = usePortraitChange(store, call)
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      {portrait.mediaId ? (
        <div className="flex shrink-0 flex-col items-start gap-2">
          <ChangeablePortrait
            id="editor"
            alt="The card's avatar"
            name={portrait.name}
            mediaId={portrait.mediaId}
            crop={portrait.crop}
            size="2xl"
            disabled={!portrait.ready}
            onClick={portrait.openPicker}
          />
          {portrait.canAdjust && (
            <Tooltip label="Choose again which part of the picture the small portraits show, without a new image">
              <Button onClick={portrait.adjust} disabled={!portrait.ready}>
                <Icon name="crop" />
                Adjust cutout
              </Button>
            </Tooltip>
          )}
        </div>
      ) : (
        <div className="flex size-24 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted">
          No avatar
        </div>
      )}
      <div className="min-w-0 flex-1">
        <FileDrop
          label="Choose an avatar, or drop it here"
          description="PNG, JPEG, GIF or WebP, up to 16 MB. You choose the part small portraits show; the whole image is kept. It's saved as a revision of its own."
          accept={ACCEPT}
          disabled={!portrait.ready}
          onFiles={(files) => portrait.pick(files[0])}
        />
      </div>
      {portrait.input}
      {portrait.chooser}
      {portrait.error && (
        <p role="alert" className="text-sm text-danger">
          {portrait.error}
        </p>
      )}
    </div>
  )
}

/** The full editor's header portrait: `TabPortrait` showing the card's own picture and cutout. */
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
      onViewFull={viewer && mediaId !== null ? () => viewer.show({ id, name, mediaId }) : undefined}
    />
  )
}

/**
 * A character tab's portrait (owner, 2026-11-01: "clicking on the thumbnail in the sidebar
 * would open the UI to replace it"): a click changes the picture; Adjust cutout and View full
 * image sit beside it.
 */
export function TabPortrait({
  store,
  call,
  id,
  shown,
  onViewFull,
  onChanged
}: {
  store: EditorStore
  call: Caller
  id: string
  /** What the chat shows: the cast's own copy of the card's name and portrait. */
  shown: { readonly name: string; readonly mediaId: string | null; readonly crop: AvatarCrop | null }
  onViewFull: (() => void) | undefined
  /** After a change is saved: the chat reads its cast again, so its portraits follow. */
  onChanged?: () => void
}) {
  const portrait = usePortraitChange(store, call, onChanged)
  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <ChangeablePortrait
        id={id}
        name={shown.name}
        mediaId={shown.mediaId}
        crop={shown.crop}
        size="lg"
        disabled={!portrait.ready}
        onClick={portrait.openPicker}
      />
      {shown.mediaId !== null && (
        <span className="flex">
          {portrait.canAdjust && (
            <IconButton
              icon="crop"
              label="Adjust cutout"
              hint="Adjust cutout: which part of the picture small portraits show"
              className="size-6!"
              disabled={!portrait.ready}
              onClick={portrait.adjust}
            />
          )}
          {onViewFull && (
            <IconButton
              icon="expand"
              label="View full image"
              hint="View the full image beside the chat"
              className="size-6!"
              onClick={onViewFull}
            />
          )}
        </span>
      )}
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
