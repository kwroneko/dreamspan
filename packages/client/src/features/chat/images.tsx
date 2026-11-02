import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode
} from "react"
import { positionOf } from "./position.ts"
import type { MessageImages, PathEntry } from "@rp/shared/chat.ts"
import type { ImagesLeftOut } from "@rp/shared/inspectorApi.ts"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { ContentImage } from "../../ui/ContentImage.tsx"
import { Dialog } from "../../ui/Dialog.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { SquareIconButton, ToggleIconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { mediaUrl } from "../../ui/mediaImage.ts"
import { Composer, type AttachmentInput } from "./Composer.tsx"
import type { ComposerSource } from "./composerDraft.ts"
import { composerWorkspace } from "./composerWorkspace.ts"
import type { ChatSession } from "./session.ts"
import type { MessageDraft } from "./messageDraft.ts"
import { messageEditorTools } from "./editorHistory.tsx"
import {
  chatComposer,
  chatSurfaceProviders,
  messagePreviews,
  queuedPreviews,
  type ChatSurfaceProps
} from "./presentation.tsx"
import { dropImage, keepImage, readImages, type ImageDraftEntry } from "./imageDraft.ts"

interface ImagesState {
  readonly entries: readonly ImageDraftEntry[]
  readonly ready: boolean
  readonly busy: boolean
  readonly error: string | null
  readonly add: (files: File[]) => void
  readonly remove: (id: string) => void
  readonly capture: AttachmentInput["capture"]
  readonly restore: AttachmentInput["restore"]
}
const ImagesContext = createContext<ImagesState | null>(null)

/** Uploads an image's bytes (`POST /chat/image`) and returns its media id. */
const uploadImage = async (file: Blob) => {
  const response = await fetch("/chat/image", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file
  })
  if (!response.ok) throw new Error(await response.text())
  return ((await response.json()) as { mediaId: string }).mediaId
}

const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif"
const imageFiles = (files: Iterable<File>) => Array.from(files).filter((file) => file.type.startsWith("image/"))

/**
 * The paperclip: a picker for images, one tap. Its tooltip says pasting and dropping work too.
 * The composer and the message editor use it.
 */
function AttachButton({
  disabled,
  onFiles,
  pickerLabel = "Choose images",
  hint = "Attach images. You can also paste an image or drop it anywhere in the chat."
}: {
  disabled: boolean
  onFiles: (files: File[]) => void
  pickerLabel?: string
  hint?: string
}) {
  const picker = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={picker}
        className="sr-only"
        disabled={disabled}
        type="file"
        accept={IMAGE_TYPES}
        multiple
        aria-label={pickerLabel}
        onChange={(event) => {
          onFiles(Array.from(event.currentTarget.files ?? []))
          event.currentTarget.value = ""
        }}
      />
      <SquareIconButton
        label="Attach images"
        hint={hint}
        variant="ghost"
        disabled={disabled}
        onClick={() => picker.current?.click()}
      >
        <Icon name="paperclip" />
      </SquareIconButton>
    </>
  )
}

/** Removable thumbnails of attached images; the composer and the message editor use it. */
function AttachmentList({
  label,
  items,
  onRemove
}: {
  label: string
  items: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly thumbnail: ReactNode
    readonly sending?: boolean
  }>
  onRemove: (id: string) => void
}) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label={label}>
      {items.map((item) => (
        <li key={item.id} className="flex flex-col items-center rounded-md border border-border p-1">
          {item.thumbnail}
          {item.sending ? (
            <span className="text-xs text-muted">Sending…</span>
          ) : (
            <Button variant="ghost" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.id)}>
              Remove
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * The message editor's images (DESIGN §10.2a): the version saved keeps, adds or removes them.
 * Starts from the source's set; the paperclip, paste and drop on the editor add, Remove takes
 * one off. The set is the draft's (`MessageDraft.setImages`), which Save sends.
 */
function EditorImages({ draft, images }: { draft: MessageDraft; base: string; images: MessageImages }) {
  const view = useSyncExternalStore(draft.subscribe, draft.snapshot)
  const current = view.images ?? images
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = useCallback(
    async (files: File[]) => {
      const selected = imageFiles(files)
      if (!selected.length) return
      if ((draft.snapshot().images ?? images).length + selected.length > 32) {
        setError("A message can hold at most 32 images.")
        return
      }
      await draft.uploadImages(async () => {
        setBusy(true)
        setError(null)
        try {
          const added = []
          for (const file of selected)
            added.push({ mediaId: await uploadImage(file), altText: (file.name || "Pasted image").slice(0, 2000) })
          draft.setImages([...(draft.snapshot().images ?? images), ...added])
        } catch (error) {
          setError(`The image could not be uploaded. ${error instanceof Error ? error.message : ""}`)
        } finally {
          setBusy(false)
        }
      })
    },
    [draft, images]
  )
  // Paste and drop on the editor add here, not to the composer below.
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      const form = node?.closest("form")
      if (!form) return
      const paste = (event: ClipboardEvent) => {
        const files = imageFiles(event.clipboardData?.files ?? [])
        if (!files.length) return
        event.preventDefault()
        event.stopPropagation()
        void add(files)
      }
      const over = (event: DragEvent) => {
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault()
      }
      const drop = (event: DragEvent) => {
        if (!event.dataTransfer?.files.length) return
        event.preventDefault()
        event.stopPropagation()
        void add(Array.from(event.dataTransfer.files))
      }
      form.addEventListener("paste", paste)
      form.addEventListener("dragover", over)
      form.addEventListener("drop", drop)
      return () => {
        form.removeEventListener("paste", paste)
        form.removeEventListener("dragover", over)
        form.removeEventListener("drop", drop)
      }
    },
    [add]
  )
  return (
    // It sits in the editor's row of Save and Cancel: the attach button there, and its
    // images on a line of their own above the row, where they read as part of the message.
    <div ref={ref} className="contents">
      <AttachButton
        disabled={busy}
        onFiles={(files) => void add(files)}
        pickerLabel="Choose images for this version"
        hint="Attach images to this version. You can also paste an image or drop it on the editor."
      />
      {busy && (
        <span className="text-xs text-muted" role="status">
          Uploading…
        </span>
      )}
      {current.length > 0 && (
        <div className="order-first basis-full">
          <AttachmentList
            label="Images of this version"
            items={current.map((image, index) => ({
              id: `${index}:${image.mediaId}`,
              name: image.altText || `image ${index + 1}`,
              thumbnail: (
                <ContentImage
                  src={mediaUrl(image.mediaId, 160)}
                  alt={image.altText || `Image ${index + 1}`}
                  className="h-20 w-20 rounded-md object-contain"
                />
              )
            }))}
            onRemove={(id) => {
              const at = Number(id.slice(0, id.indexOf(":")))
              draft.setImages(current.filter((_, index) => index !== at))
            }}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="basis-full text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

function ImageScope({ children, scope, session, view }: ChatSurfaceProps & { scope: string }) {
  const user = useSession().user.id
  const draft = composerWorkspace(session, user).draft
  const resolvedDraftId = useSyncExternalStore(draft.subscribe, () => draft.draftIdFor(view.forkId))
  const [entries, setEntries] = useState<readonly ImageDraftEntry[]>([])
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const queue = useRef(Promise.resolve())
  const draftId = useRef<string | null>(null)
  const enqueue = (run: () => Promise<void>) => {
    queue.current = queue.current.then(run).catch((error: unknown) => {
      setError(error instanceof Error ? error.message : "The image could not be saved.")
    })
    return queue.current
  }
  const refresh = async () => setEntries(await readImages(scope))
  const sync = async (entry: ImageDraftEntry) => {
    if (!entry.mediaId || !draftId.current) return
    const saved = await session.call((client) =>
      client("SetComposerImage", {
        chatId: session.chatId,
        draftId: draftId.current!,
        id: entry.id,
        mediaId: entry.mediaId!,
        altText: entry.name.slice(0, 2000)
      })
    )
    if (!saved.ok) throw new Error(saved.error.message)
    if (saved.value.status !== "active") await dropImage(entry.id)
    else
      await keepImage({
        id: entry.id,
        scope,
        name: saved.value.altText,
        mediaId: saved.value.mediaId!,
        position: saved.value.position,
        saved: true
      })
  }
  const upload = async (entry: ImageDraftEntry) => {
    if (entry.mediaId) return sync(entry)
    if (!entry.file) return
    try {
      const mediaId = await uploadImage(entry.file)
      const uploaded = {
        id: entry.id,
        scope,
        name: entry.name,
        mediaId,
        ...(entry.pendingPosition === undefined ? {} : { pendingPosition: entry.pendingPosition })
      }
      await keepImage(uploaded)
      await sync(uploaded)
    } catch (error) {
      throw new Error(
        `Upload failed. The attachment draft is kept in this browser. ${error instanceof Error ? error.message : "Reload to retry."}`
      )
    }
  }

  useEffect(() => {
    if (resolvedDraftId === null) return
    let live = true
    void enqueue(async () => {
      try {
        const stored = await readImages(scope)
        draftId.current = resolvedDraftId
        const remote = await session.call((client) =>
          client("GetComposerImages", {
            chatId: session.chatId,
            draftId: resolvedDraftId,
            ids: stored.map((entry) => entry.id)
          })
        )
        if (!remote.ok) throw new Error(remote.error.message)
        const tombstones = new Set(remote.value.filter((entry) => entry.status !== "active").map((entry) => entry.id))
        for (const entry of remote.value) {
          if (entry.status === "active")
            await keepImage({
              id: entry.id,
              scope,
              name: entry.altText,
              mediaId: entry.mediaId!,
              position: entry.position,
              saved: true
            })
          else await dropImage(entry.id)
        }
        for (const entry of stored) {
          if (tombstones.has(entry.id)) continue
          if (entry.sending)
            setError("A previous send was not acknowledged. Check the chat before sending these images again.")
          await upload(entry)
        }
      } finally {
        if (live) {
          try {
            await refresh()
          } finally {
            setReady(true)
          }
        }
      }
    })
    return () => {
      live = false
    }
    // The keyed provider owns one fork; opening it replays its durable upload queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedDraftId])
  const add = (files: File[]) => {
    if (!ready) {
      setError("Wait for the chat to load before attaching images.")
      return
    }
    void enqueue(async () => {
      setBusy(true)
      setError(null)
      try {
        const stored = await readImages(scope)
        const selected = files.filter((file) => file.type.startsWith("image/"))
        if (stored.length + selected.length > 32) throw new Error("A message can hold at most 32 images.")
        const firstPosition = Math.max(0, ...stored.map((entry) => entry.pendingPosition ?? 0)) + 1
        const added = selected.map((file, index) => ({
          id: crypto.randomUUID(),
          scope,
          name: file.name || "Pasted image",
          file,
          pendingPosition: firstPosition + index
        }))
        // Keep the entire selection before any upload can fail or outlive this page.
        for (const entry of added) await keepImage(entry)
        await refresh()
        for (const entry of (await readImages(scope)).filter((entry) => !entry.saved)) {
          await upload(entry)
          await refresh()
        }
      } finally {
        setBusy(false)
      }
    })
  }
  const capture = () => {
    const captured = entries.filter((entry) => entry.mediaId && entry.saved && !entry.sending)
    const images: MessageImages = captured.map((entry) => ({
      mediaId: entry.mediaId!,
      altText: entry.name.slice(0, 2000)
    }))
    return {
      images,
      ids: captured.map((entry) => entry.id),
      begin: async (from: ComposerSource) => {
        await enqueue(async () => {
          for (const entry of captured)
            await keepImage({
              ...entry,
              sending: {
                draftId: from.draftId,
                session: from.session
              }
            })
          await refresh()
        })
      },
      finish: async (sent: boolean) => {
        await enqueue(async () => {
          for (const entry of captured) {
            if (sent) await dropImage(entry.id)
            else await keepImage(entry)
          }
          await refresh()
        })
      }
    }
  }
  return (
    <ImagesContext.Provider
      value={{
        entries,
        ready,
        busy,
        error,
        add,
        capture,
        restore: (images) => {
          void enqueue(async () => {
            try {
              for (const image of images) {
                const entry = {
                  id: crypto.randomUUID(),
                  scope,
                  name: image.altText || "Restored image",
                  mediaId: image.mediaId
                }
                await keepImage(entry)
                await upload(entry)
              }
            } finally {
              await refresh()
            }
          })
        },
        remove: (id) => {
          void enqueue(async () => {
            if (!draftId.current) throw new Error("The attachment draft is still loading. Reload to retry.")
            const removed = await session.call((client) =>
              client("SetComposerImage", {
                chatId: session.chatId,
                draftId: draftId.current!,
                id,
                mediaId: null,
                altText: ""
              })
            )
            if (!removed.ok) throw new Error(removed.error.message)
            await dropImage(id)
            await refresh()
          })
        }
      }}
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault()
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return
          event.preventDefault()
          add(Array.from(event.dataTransfer.files))
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"))
          if (!files.length) return
          event.preventDefault()
          add(files)
        }}
      >
        {children}
      </div>
    </ImagesContext.Provider>
  )
}
function ImageProvider(props: ChatSurfaceProps) {
  const user = useSession().user.id
  // Opening the temporary "current" scope can overwrite this fork's durable send
  // marker before ReadPath resolves it. Only the resolved fork may reconcile images.
  if (props.view.forkId === null) return props.children
  const scope = `${user}:${props.session.chatId}:${props.view.forkId}`
  return <ImageScope key={scope} {...props} scope={scope} />
}
function DraftThumbnail({ entry }: { entry: ImageDraftEntry }) {
  const ref = useCallback(
    (node: HTMLImageElement | null) => {
      if (!node || !entry.file) return
      const url = URL.createObjectURL(entry.file)
      node.src = url
      return () => URL.revokeObjectURL(url)
    },
    [entry.file]
  )
  return (
    <ContentImage
      ref={ref}
      src={entry.mediaId ? mediaUrl(entry.mediaId, 160) : undefined}
      alt={entry.name}
      className="h-20 w-20 rounded-md object-contain"
    />
  )
}
function ImageComposer(props: ComponentProps<typeof Composer>) {
  const state = useContext(ImagesContext)
  if (!state) return <Composer {...props} />
  const vision = props.view.history?.model?.vision
  const maxImages = props.view.history?.model?.maxImages ?? 4
  return (
    <Composer
      {...props}
      attachmentInput={{
        count: state.entries.length,
        busy: !state.ready || state.busy || state.entries.some((entry) => !entry.mediaId || !entry.saved),
        capture: state.capture,
        restore: state.restore,
        action: <AttachButton disabled={!state.ready || state.busy} onFiles={state.add} />,
        editor:
          state.entries.length > 0 || state.error ? (
            <div className="flex flex-col gap-2" aria-label="Image attachments">
              {state.entries.length > 0 && (
                <>
                  <AttachmentList
                    label="Attached images"
                    items={state.entries.map((entry) => ({
                      id: entry.id,
                      name: entry.name,
                      thumbnail: <DraftThumbnail entry={entry} />,
                      ...(entry.sending ? { sending: true } : {})
                    }))}
                    onRemove={state.remove}
                  />
                  <p role="status" className={`text-sm ${vision === false ? "text-danger" : "text-muted"}`}>
                    {vision === false
                      ? "This model cannot see images. Choose a vision model before replying."
                      : vision === undefined
                        ? "Choose a vision model to reply to these images."
                        : `The model sees up to the last ${maxImages} images in context.`}
                  </p>
                </>
              )}
              {state.error && (
                <p role="alert" className="text-sm text-danger">
                  {state.error} Remove an image or reload to retry.
                </p>
              )}
            </div>
          ) : null
      }}
    />
  )
}
/** Why the next request leaves image `index` of the message out, by the assembler's rules; null: it's sent. */
const leftOutBy = (images: ImagesLeftOut | undefined, entry: PathEntry, index: number) => {
  const image = images?.images.find(
    (item) => item.versionId === entry.version.id && item.index === index && item.rule !== "user"
  )
  if (image) return image
  return images?.ranges.find((range) => positionOf(entry) >= range.from && positionOf(entry) <= range.to) ?? null
}

/**
 * A message image's corner button: takes it out of the context or puts it back. Shown on
 * hover (always on touch screens); always shown while it's out. An image a rule leaves out
 * shows it toggled and disabled, and hovering says which rule.
 */
function ContextToggle({
  index,
  excluded,
  rule,
  busy,
  onToggle
}: {
  index: number
  excluded: boolean
  rule: string | null
  busy: boolean
  onToggle: () => void
}) {
  const out = excluded || rule !== null
  const label =
    rule !== null
      ? `Image ${index + 1} isn’t sent to the model: ${rule}`
      : excluded
        ? `Put image ${index + 1} back into the context`
        : `Take image ${index + 1} out of the context`
  return (
    <ToggleIconButton
      label={label}
      icon={out ? "eyeOff" : "eye"}
      pressed={out}
      disabled={rule !== null || busy}
      onClick={onToggle}
      className="tile-toggle absolute top-1 right-1"
    />
  )
}

function ImageThumbnails({
  images,
  controls
}: {
  images: MessageImages
  /** A message's images: the context toggle and why each one isn't sent. */
  controls?: { entry: PathEntry; session: ChatSession }
}) {
  const [selected, setSelected] = useState<{ mediaId: string; altText?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const session = controls?.session
  const readLeftOut = () => session?.snapshot().history?.images
  const leftOut = useSyncExternalStore(session?.subscribe ?? noSubscribe, readLeftOut, readLeftOut)
  const readEditing = () =>
    controls && images.length > 0
      ? session!.editor(`write:${controls.entry.slotId}`) !== undefined ||
        session!.editForSlot(controls.entry.slotId, [controls.entry.version]) !== undefined
      : false
  const editing = useSyncExternalStore(session?.subscribeEditors ?? noSubscribe, readEditing, readEditing)
  // The editor shows the images it saves, with their own controls.
  if (!images.length || editing) return null
  return (
    <>
      <div className="flex flex-wrap gap-2" aria-label="Message images">
        {images.map((image, index) => {
          const excluded = controls?.entry.excludedImages?.includes(image.mediaId) ?? false
          const left = controls && !excluded ? leftOutBy(leftOut, controls.entry, index) : null
          const reason = excluded ? "taken out of the context by you" : left ? left.message : null
          const view = (
            <button
              type="button"
              aria-label={`View image ${index + 1}${reason ? ` (not sent to the model: ${reason})` : ""}`}
              onClick={() => setSelected(image)}
              className="rounded-md border border-border outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <ContentImage
                src={mediaUrl(image.mediaId, 320)}
                alt={image.altText || `Image ${index + 1}`}
                loading="lazy"
                className={`max-h-48 max-w-full rounded-md object-contain ${reason ? "opacity-40 grayscale" : ""}`}
              />
            </button>
          )
          return (
            <div
              key={`${image.mediaId}:${index}`}
              className="tile-toggle-surface relative"
              data-image-sent={reason ? "no" : "yes"}
            >
              {reason ? <Tooltip label={`Not sent to the model: ${reason}`}>{view}</Tooltip> : view}
              {controls && (
                <ContextToggle
                  index={index}
                  excluded={excluded}
                  rule={left ? left.message : null}
                  busy={busy}
                  onToggle={async () => {
                    setBusy(true)
                    const outcome = await controls.session.setImageExcluded(controls.entry, image.mediaId, !excluded)
                    setBusy(false)
                    setError(outcome.ok ? null : outcome.error.message)
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
        title={selected?.altText || "Image"}
        wide
      >
        {selected && (
          <ContentImage
            src={mediaUrl(selected.mediaId)}
            alt={selected.altText || "Attached image"}
            className="max-h-[75dvh] max-w-full object-contain"
          />
        )}
        <Button onClick={() => setSelected(null)}>Close image</Button>
      </Dialog>
    </>
  )
}
const noSubscribe = () => () => {}
export const registerImages = () => [
  chatComposer.register({ id: "chat.composer", order: 10, component: ImageComposer }),
  chatSurfaceProviders.register({ id: "chat.images", order: 40, component: ImageProvider }),
  messagePreviews.register({
    id: "message.images",
    order: 20,
    component: ({ entry, session }) => (
      <ImageThumbnails images={entry.version.images ?? []} controls={{ entry, session }} />
    )
  }),
  messageEditorTools.register({ id: "message.editor-images", order: 5, component: EditorImages }),
  queuedPreviews.register({
    id: "queued.images",
    order: 10,
    component: ({ queued }) => <ImageThumbnails images={queued.images ?? []} />
  })
]
