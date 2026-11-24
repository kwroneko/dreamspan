import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactElement,
  type ReactNode
} from "react"
import { positionOf } from "./position.ts"
import { imagesOnly, type MessageImages, type PathEntry } from "@dreamspan/shared/chat.ts"
import type { ImagesLeftOut } from "@dreamspan/shared/inspectorApi.ts"
import { useSession } from "../../session.ts"
import { uuid } from "../../uuid.ts"
import { Button, LinkButton } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { useNavigate } from "@tanstack/react-router"
import { ATTACHMENT_MAX_BYTES, nameOf as fileNameOf } from "@dreamspan/shared/files.ts"
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import type { ComposerImage } from "@dreamspan/shared/composerApi.ts"
import { ContentImage } from "../../ui/ContentImage.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { ContextMenu, MenuItem } from "../../ui/Menu.tsx"
import {
  CornerIconButton,
  IconButton,
  PICTURE_TOGGLE,
  SquareIconButton,
  ToggleIconButton,
  Tooltip
} from "../../ui/Tooltip.tsx"
import { mediaUrl } from "../../ui/mediaImage.ts"
import { carryOnDrag, isAppDrag, PICTURE_DRAG } from "../../ui/appDrags.ts"
import { EnsurePortraitViewer, PicturePeek, type Portrait, usePortraitViewer } from "../../ui/Portrait.tsx"
import { useOpenAsTab } from "../workbench/tab.tsx"
import { attachmentName, attachmentPicture } from "./attachmentPictures.ts"
import { messageSide, nameOf, useCast } from "./cast.ts"
import { pictureHref } from "./PicturePage.tsx"
import { Composer, type AttachmentInput } from "./Composer.tsx"
import { kindShows } from "./kindLooks.ts"
import {
  AttachMenu,
  type ComposerLibrary,
  ComposerLibraryTiles,
  LIBRARY_ATTACH,
  libraryRefOfDrop,
  mayCarryLibrary,
  MessageLibraryTiles,
  useComposerLibrary,
  useLiveLibraryComposer
} from "./libraryAttachments.tsx"
import { focusComposer } from "./composerFocus.ts"
import { useWorkbenchTab } from "../workbench/tab.tsx"
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
import { adoptImages, dropImage, keepImage, readImages, type ImageDraftEntry } from "./imageDraft.ts"
import { draftEntryOf } from "./chatStarted.ts"
import { pendingChatCopy } from "../editor/backup.ts"
import { pendingAttachments, PendingAttachmentsContext, type PendingAttachments } from "./pendingComposerControls.tsx"
import {
  FILE_PATH_MIME,
  onAttachRequest,
  useFileAttachments,
  type FileAttacher,
  type FileAttachments
} from "./fileAttachments.ts"

interface ImagesState {
  readonly entries: readonly ImageDraftEntry[]
  readonly ready: boolean
  readonly busy: boolean
  readonly error: string | null
  /** Where files of any type go (a workshop), or null: images only. */
  readonly attacher: FileAttacher | null
  /** Cards, lorebooks and presets attached (a workshop), or null where the chat takes none. */
  readonly library: ComposerLibrary | null
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
  anyType = false,
  pickerLabel = anyType ? "Choose files" : "Choose images",
  hint = "Attach images. You can also paste an image or drop it anywhere in the chat.",
  size = "md"
}: {
  disabled: boolean
  onFiles: (files: File[]) => void
  /** Files of any type (a workshop, §6.1), not only images. */
  anyType?: boolean
  pickerLabel?: string
  hint?: string
  /** "sm" among the message editor's icon buttons, "md" beside the composer's (ui/Tooltip.tsx). */
  size?: "md" | "sm"
}) {
  const picker = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={picker}
        className="sr-only"
        disabled={disabled}
        type="file"
        {...(anyType ? {} : { accept: IMAGE_TYPES })}
        multiple
        aria-label={pickerLabel}
        onChange={(event) => {
          onFiles(Array.from(event.currentTarget.files ?? []))
          event.currentTarget.value = ""
        }}
      />
      {size === "sm" ? (
        <IconButton
          icon="paperclip"
          label={anyType ? "Attach files" : "Attach images"}
          hint={hint}
          disabled={disabled}
          onClick={() => picker.current?.click()}
        />
      ) : (
        <SquareIconButton
          label={anyType ? "Attach files" : "Attach images"}
          hint={hint}
          variant="ghost"
          disabled={disabled}
          onClick={() => picker.current?.click()}
        >
          <Icon name="paperclip" />
        </SquareIconButton>
      )}
    </>
  )
}

const UPLOADING = "This image can open there once it has finished uploading."

/**
 * An image's other ways to open (owner, 2026-11-07), for its context menu and corner button:
 * in the image column (full screen on a phone, as a portrait's) and as a tab. Disabled, with
 * the reason, while `picture` is null: an attachment still uploading has no stored image yet.
 */
function useImageActions(picture: Portrait | null, drags = false) {
  const viewer = usePortraitViewer()
  const asTab = useOpenAsTab()
  const href = picture ? pictureHref(picture) : null
  return {
    column: {
      disabled: picture === null || viewer === null,
      description: picture ? "Opens this image in the image column." : UPLOADING,
      run: () => picture && viewer?.show(picture)
    },
    tab: asTab
      ? {
          disabled: href === null,
          description: href
            ? `Opens this image as a tab in the chat's frame.${drags ? " Dragging it onto a frame does the same." : ""}`
            : UPLOADING,
          run: () => href && asTab.open(href)
        }
      : null
  }
}

/**
 * The image's app context menu (right-click or a long press): Open in image column, Open as a
 * tab. `drags`: the image also opens as a tab when dragged onto a frame (a sent one's).
 */
function ImageMenu({
  picture,
  drags = false,
  trigger
}: {
  picture: Portrait | null
  drags?: boolean
  trigger: ReactElement
}) {
  const [open, setOpen] = useState(false)
  const actions = useImageActions(picture, drags)
  return (
    <ContextMenu label="Image" open={open} onOpenChange={setOpen} trigger={trigger}>
      <MenuItem
        icon="sidebar"
        disabled={actions.column.disabled}
        description={actions.column.description}
        onClick={actions.column.run}
      >
        Open in image column
      </MenuItem>
      {actions.tab && (
        <MenuItem
          icon="image"
          disabled={actions.tab.disabled}
          description={actions.tab.description}
          onClick={actions.tab.run}
        >
          Open as a tab
        </MenuItem>
      )}
    </ContextMenu>
  )
}

/**
 * The thumbnail's button at its bottom right, inside it (the remove X takes the top right): opens
 * it in the image column (on hover and focus; always on touch).
 */
function ColumnButton({ picture }: { picture: Portrait | null }) {
  const { column } = useImageActions(picture)
  return (
    <span data-layout-overlay="Open in image column sits over the thumbnail" className="absolute right-1 bottom-1 flex">
      <ToggleIconButton
        label="Open in image column"
        icon="sidebar"
        hint={picture ? "Opens this image in the image column, beside the chat." : UPLOADING}
        disabled={column.disabled}
        onClick={column.run}
        className={`tile-action ${PICTURE_TOGGLE}`}
      />
    </span>
  )
}

/**
 * An attached image not sent yet, as the list shows it: a click peeks at it in a modal with the
 * column's viewer (owner, 2026-11-07: "Images attached to the composer should be peeked in a
 * modal"); its context menu and corner button open it in the column, or as a tab, once stored.
 */
function AttachedThumbnail({
  item,
  onPeek,
  corner
}: {
  item: AttachmentItem
  onPeek: (picture: Portrait, file: Blob | undefined) => void
  /** The remove X straddling the top-right corner. */
  corner: ReactNode
}) {
  if (item.kind === "file" || item.card)
    return (
      <div className="tile-toggle-surface relative">
        <FileTile name={item.name} href={item.fileHref ?? null} view={item.fileView ?? null} card={item.card ?? null} />
        {corner}
      </div>
    )
  const picture = item.mediaId ? attachmentPicture(item.mediaId, item.name) : null
  const peekable = picture !== null || item.file !== undefined
  return (
    <div className="tile-toggle-surface relative">
      <ImageMenu
        picture={picture}
        trigger={
          <Tooltip
            label={
              peekable
                ? "Opens this image to look at it closely. Right-click or long-press to open it in the image column."
                : "This image is still being added."
            }
          >
            <button
              type="button"
              aria-label={`View ${item.name}`}
              aria-disabled={peekable ? undefined : true}
              onClick={() => {
                if (peekable) onPeek(picture ?? { id: `draft:${item.id}`, name: item.name, mediaId: null }, item.file)
              }}
              className="block overflow-hidden rounded-md border border-border bg-surface-raised outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {item.thumbnail}
            </button>
          </Tooltip>
        }
      />
      <ColumnButton picture={picture} />
      {corner}
    </div>
  )
}

/** A character card attached as a file (spec/WORKSHOP-CARDS.md §4.5): its name, and its picture when it's a PNG. */
interface CardFace {
  readonly name: string
  readonly picture: string | null
}

/**
 * A file that isn't an image (spec/FILES-AND-ENVIRONMENT.md §6.1): its type icon and name. With
 * `href`, a link that downloads the copy sent with the message; without, it's still being added.
 * A card file (`card`) shows as a card: its picture (a PNG card's own) in the attachments' 104 px
 * box, its name under it, and "Card file".
 */
function FileTile({
  name,
  href,
  view,
  show,
  card
}: {
  name: string
  href: string | null
  /** The copy as sent, inline: it opens in the viewer for its type, where there is one. */
  view?: string | null
  show?: string | null
  card?: CardFace | null
}) {
  const navigate = useNavigate()
  const attachments = useFileAttachments()
  const [open, setOpen] = useState(false)
  const Viewer = attachments?.Viewer
  const opens = view !== null && view !== undefined && Viewer !== undefined && (attachments?.opens?.(name) ?? false)
  const body = card ? (
    <>
      <span className="flex h-26 w-26 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-raised">
        {card.picture ? (
          <ContentImage src={card.picture} alt="" className="h-26 w-26 object-cover" />
        ) : (
          <Icon name="user" size={32} className="text-muted" />
        )}
      </span>
      <span className="w-full truncate text-center text-xs text-text">{card.name}</span>
      <span className="text-xs text-muted">Card file</span>
    </>
  ) : (
    <>
      <Icon name="file" className="shrink-0 text-muted" />
      <span className="min-w-0 truncate">{name}</span>
    </>
  )
  const tile = card
    ? "flex w-26 flex-col items-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
    : "flex h-11 max-w-60 min-w-0 items-center gap-2 rounded-md border border-border px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
  const what = card ? "card file" : "file"
  return (
    <span className={`flex min-w-0 gap-1 ${card ? "items-start" : "items-center"}`}>
      {href && opens && Viewer && view ? (
        <>
          <Tooltip label={`Opens the copy of this ${what} as it was attached.`}>
            <button
              type="button"
              className={`${tile} ${card ? "" : "hover:bg-hover"}`}
              aria-label={card ? `Open the card file ${card.name} (${name})` : `Open ${name}`}
              data-card-file={card ? name : undefined}
              onClick={() => setOpen(true)}
            >
              {body}
            </button>
          </Tooltip>
          <Dialog open={open} onOpenChange={setOpen} title={name} description="As it was attached." wide>
            {open && <Viewer name={name} url={view} />}
            <DialogActions>
              <Button
                hint="Saves the copy as it was attached on this device."
                onClick={() => {
                  const link = document.createElement("a")
                  link.href = href
                  link.download = name
                  link.rel = "noopener"
                  document.body.append(link)
                  link.click()
                  link.remove()
                }}
              >
                <Icon name="download" />
                Download
              </Button>
            </DialogActions>
          </Dialog>
        </>
      ) : href ? (
        <Tooltip label={`Downloads the copy of this ${what} as it was attached.`}>
          <a
            href={href}
            download={name}
            rel="noopener"
            className={`${tile} ${card ? "" : "hover:bg-hover"}`}
            aria-label={card ? `Download the card file ${card.name} (${name})` : `Download ${name}`}
            data-card-file={card ? name : undefined}
          >
            {body}
          </a>
        </Tooltip>
      ) : (
        <Tooltip label={`This ${what} is still being added.`}>
          <span
            tabIndex={0}
            className={tile}
            aria-label={`${name}, being added`}
            data-card-file={card ? name : undefined}
          >
            {body}
          </span>
        </Tooltip>
      )}
      {show && (
        <LinkButton
          href={show}
          onOpen={() => void navigate({ href: show })}
          variant="ghost"
          aria-label={`Show ${name} in Files`}
          hint="Opens the folder it was saved in, in Files, with the file as it is now."
        >
          <Icon name="folder" />
        </LinkButton>
      )}
    </span>
  )
}

interface AttachmentItem {
  readonly id: string
  readonly name: string
  /** A file that isn't an image (§6.1): shown by its name, opening its copy at `fileHref`. */
  readonly kind?: "file"
  /** A character card file (spec/WORKSHOP-CARDS.md §4.5): shown as a card. */
  readonly card?: CardFace
  readonly fileHref?: string | null
  /** The copy as sent, inline, for its viewer. */
  readonly fileView?: string | null
  readonly thumbnail: ReactNode
  readonly sending?: boolean
  /** Its stored image, once uploaded. */
  readonly mediaId: string | null
  /** The local copy while it uploads. */
  readonly file?: Blob | undefined
}

/**
 * Removable thumbnails of attached images; the composer and the message editor use it. Each has
 * a round X straddling its top-right corner that removes it (owner, 2026-11-23: no Remove text
 * button under the picture); `removeHint` says what removing an image does there.
 */
function AttachmentList({
  label,
  items,
  removeHint,
  onRemove,
  more
}: {
  label: string
  items: ReadonlyArray<AttachmentItem>
  removeHint: string
  onRemove: (id: string) => void
  /** Rows of other kinds after these (a workshop's cards, lorebooks and presets). */
  more?: ReactNode
}) {
  const [peek, setPeek] = useState<{ picture: Portrait; src: string | undefined } | null>(null)
  useEffect(() => {
    const src = peek?.src
    return () => {
      if (src?.startsWith("blob:")) URL.revokeObjectURL(src)
    }
  }, [peek?.src])
  return (
    <>
      {/* Room above and to the right for the X, which sits half outside its tile, and clear of the edge. */}
      <ul className="flex flex-wrap gap-3 pt-5 pr-3" aria-label={label}>
        {items.map((item) => (
          <li key={item.id} className="flex flex-col items-center gap-1">
            <AttachedThumbnail
              item={item}
              onPeek={(picture, file) =>
                setPeek({ picture, src: picture.mediaId === null && file ? URL.createObjectURL(file) : undefined })
              }
              corner={
                item.sending ? null : (
                  <span
                    data-layout-overlay="The remove X straddles the thumbnail's corner"
                    className="absolute -top-3 -right-3 flex"
                  >
                    <CornerIconButton
                      label={`Remove ${item.name}`}
                      icon="close"
                      hint={
                        item.kind === "file" ? "Removes this file from the message. It stays in Files." : removeHint
                      }
                      onClick={() => onRemove(item.id)}
                      className="tile-action relative"
                    />
                  </span>
                )
              }
            />
            {item.sending && <span className="text-xs text-muted">Sending…</span>}
          </li>
        ))}
        {more}
      </ul>
      <PicturePeek picture={peek?.picture ?? null} src={peek?.src} onClose={() => setPeek(null)} />
    </>
  )
}

/**
 * The message editor's images (DESIGN §10.2a): the version saved keeps, adds or removes them.
 * Starts from the source's set; the paperclip, paste and drop on the editor add, an image's X takes
 * one off. The set is the draft's (`MessageDraft.setImages`), which Save sends.
 */
function EditorImages({ draft, images }: { draft: MessageDraft; base: string; images: MessageImages }) {
  const view = useSyncExternalStore(draft.subscribe, draft.snapshot)
  const current = view.images ?? images
  const attachments = useFileAttachments()
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
      // The editor's form, or the message an edit is open in (InPlaceEdit.tsx).
      const form = node?.closest<HTMLElement>("form, [data-message-edit]")
      if (!form) return
      const paste = (event: ClipboardEvent) => {
        const files = imageFiles(event.clipboardData?.files ?? [])
        if (!files.length) return
        event.preventDefault()
        event.stopPropagation()
        void add(files)
      }
      // Nothing dragged from inside the app is an attachment: a portrait goes to the frame as a tab.
      const own = (event: DragEvent) => isAppDrag(event.dataTransfer)
      const over = (event: DragEvent) => {
        if (event.dataTransfer?.types.includes("Files") && !own(event)) event.preventDefault()
      }
      const drop = (event: DragEvent) => {
        if (!event.dataTransfer?.files.length || own(event)) return
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
        pickerLabel="Choose images for this swipe"
        size="sm"
        hint="Attach images to this swipe. You can also paste an image or drop it on the editor."
      />
      {busy && (
        <span className="text-xs text-muted" role="status">
          Uploading…
        </span>
      )}
      {current.length > 0 && (
        <div className="order-first basis-full">
          <AttachmentList
            label="Images of this swipe"
            removeHint="Removes this image from this swipe. Cancel keeps it."
            items={current.map((image, index) => ({
              id: `${index}:${image.mediaId}`,
              name: image.name ?? attachmentName(image.altText, null, index, current.length),
              mediaId: image.mediaId,
              // A workshop's file (§6.1) keeps its place in the set; it opens its copy as sent.
              ...(image.kind === "file"
                ? {
                    kind: "file" as const,
                    fileHref: attachments?.copyUrl(image.mediaId, image.name ?? image.altText ?? "file", true) ?? null,
                    fileView: attachments?.copyUrl(image.mediaId, image.name ?? image.altText ?? "file") ?? null
                  }
                : {}),
              thumbnail: (
                <ContentImage
                  src={mediaUrl(image.mediaId, 208)}
                  alt={image.altText || `Image ${index + 1}`}
                  className="h-26 w-26 object-contain"
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

function ImageScope({
  children,
  scope,
  session,
  view,
  attacher
}: ChatSurfaceProps & { scope: string; attacher: FileAttacher | "loading" | null }) {
  const user = useSession().user.id
  // Read by the queued work, which runs after renders: the newest one.
  const attaching = attacher === "loading" ? null : attacher
  const files = useRef(attaching)
  useLayoutEffect(() => {
    files.current = attaching
  }, [attaching])
  const draft = composerWorkspace(session, user).draft
  const resolvedDraftId = useSyncExternalStore(draft.subscribe, () => draft.draftIdFor(view.forkId))
  const library = useComposerLibrary(session, resolvedDraftId, kindShows(view.chat?.kind, LIBRARY_ATTACH))
  const [entries, setEntries] = useState<readonly ImageDraftEntry[]>([])
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Removed but not yet gone from the draft: never sent (a new chat's first send included).
  const removing = useRef(new Set<string>())
  useEffect(() => {
    // Capture still sees the previous entries until React commits the new list.
    for (const id of removing.current) if (!entries.some((entry) => entry.id === id)) removing.current.delete(id)
  }, [entries])
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
        altText: entry.name.slice(0, 2000),
        ...(entry.kind ? { kind: entry.kind } : {}),
        ...(entry.path ? { name: entry.name.slice(0, 255), path: entry.path } : {})
      })
    )
    if (!saved.ok) throw new Error(saved.error.message)
    if (saved.value.status !== "active") await dropImage(entry.id)
    else await keepImage({ ...fromServer(saved.value), id: entry.id })
  }
  /** A row the server holds, as this browser keeps it. */
  const fromServer = (row: ComposerImage): ImageDraftEntry => ({
    id: row.id,
    scope,
    name: row.name ?? row.altText,
    mediaId: row.mediaId!,
    position: row.position,
    saved: true,
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.path ? { path: row.path } : {}),
    ...(row.card ? { card: row.card } : {})
  })
  const upload = async (entry: ImageDraftEntry) => {
    if (entry.mediaId) return sync(entry)
    if (!entry.file && !entry.path) return
    try {
      const attaching = files.current
      const composer = draftId.current && { chatId: session.chatId, draftId: draftId.current, id: entry.id }
      if (attaching && !composer) throw new Error("Wait for the chat to load before attaching.")
      // In a workshop, saved in Files first (or already there) and attached by its path (§6.1).
      const attached =
        attaching && composer
          ? entry.file
            ? await attaching.upload(entry.file, entry.name, composer)
            : await attaching.attach(entry.path!, composer)
          : entry.file
            ? { mediaId: await uploadImage(entry.file) }
            : null
      if (!attached) throw new Error("Files can be attached in a workshop only.")
      const uploaded: ImageDraftEntry = {
        id: entry.id,
        scope,
        name: "name" in attached ? attached.name : entry.name,
        mediaId: attached.mediaId,
        ...("path" in attached ? { path: attached.path } : {}),
        ...("kind" in attached && attached.kind === "file" ? { kind: "file" as const } : {}),
        ...("card" in attached && attached.card ? { card: attached.card } : {}),
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

  const loading = attacher === "loading"
  useEffect(() => {
    // Uploads replay where they belong: wait until it's known whether files go to Files.
    if (resolvedDraftId === null || loading) return
    let live = true
    void enqueue(async () => {
      try {
        // A card's new chat: what the page before it kept in this browser for that card (its
        // pending-chat key, before new chats were pending chats) is this chat's now.
        const entry = view.chat?.status === "pending" ? draftEntryOf(session.chatId) : null
        if (entry?.startsWith("card:")) await adoptImages(`${user}:pending:${pendingChatCopy(entry.slice(5))}`, scope)
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
        const known = new Map(remote.value.map((entry) => [entry.id, entry.status]))
        for (const entry of remote.value) {
          if (entry.status === "active") await keepImage(fromServer(entry))
          else await dropImage(entry.id)
        }
        for (const entry of stored) {
          const status = known.get(entry.id)
          if (status && status !== "active") continue
          if (entry.sending)
            setError("A previous send was not acknowledged. Check the chat before sending these attachments again.")
          if (!status) await upload(entry)
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
  }, [resolvedDraftId, loading])
  /** Attaches files from this device, or (`paths`) files already in Files. */
  const add = (picked: File[], paths: ReadonlyArray<string> = []) => {
    if (!ready) {
      setError("Wait for the chat to load before attaching.")
      return
    }
    void enqueue(async () => {
      setBusy(true)
      setError(null)
      try {
        const kept = await readImages(scope)
        // Any type where the chat saves files in Files (a workshop); images elsewhere.
        const selected = files.current ? picked : imageFiles(picked)
        const large = selected.find((file) => file.size > ATTACHMENT_MAX_BYTES)
        if (large)
          throw new Error(
            `“${large.name}” is larger than ${formatByteSize(ATTACHMENT_MAX_BYTES)}. Put it in Files and tell the assistant where it is.`
          )
        if (paths.length && !files.current) throw new Error("Files can be attached in a workshop only.")
        if (kept.length + selected.length + paths.length > 32)
          throw new Error("A message can hold at most 32 attachments.")
        const firstPosition = Math.max(0, ...kept.map((entry) => entry.pendingPosition ?? 0)) + 1
        const added: Array<ImageDraftEntry> = [
          ...selected.map((file, index) => ({
            id: uuid(),
            scope,
            name: file.name || "Pasted image",
            file,
            ...(file.type.startsWith("image/") ? {} : { kind: "file" as const }),
            pendingPosition: firstPosition + index
          })),
          ...paths.map((path, index) => ({
            id: uuid(),
            scope,
            name: fileNameOf(path),
            path,
            pendingPosition: firstPosition + selected.length + index
          }))
        ]
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
  // The Files tab's Attach to message (§6.1).
  useEffect(
    () => onAttachRequest(session, view.forkId, (path) => add([], [path])),
    // `add` reads its state through refs and the queue; one subscription per view and fork.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, view.forkId, ready]
  )
  const capture = () => {
    const captured = entries.filter(
      (entry) => entry.mediaId && entry.saved && !entry.sending && !removing.current.has(entry.id)
    )
    const images: MessageImages = captured.map((entry) => ({
      mediaId: entry.mediaId!,
      altText: entry.name.slice(0, 2000),
      ...(entry.kind ? { kind: entry.kind } : {}),
      ...(entry.path ? { name: entry.name.slice(0, 255), path: entry.path } : {})
    }))
    return {
      images,
      ids: captured.map((entry) => entry.id),
      ...(library ? { library: library.capture() } : {}),
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
        // The send may have taken items off the draft, or another tab may have removed them.
        library?.reload()
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
        attacher: attaching,
        library,
        add,
        capture,
        restore: (images, items) => {
          if (items?.length) library?.add(items.map((item) => item.refId))
          void enqueue(async () => {
            try {
              for (const image of images) {
                const entry: ImageDraftEntry = {
                  id: uuid(),
                  scope,
                  name: image.name ?? (image.altText || "Restored image"),
                  mediaId: image.mediaId,
                  ...(image.kind ? { kind: image.kind } : {}),
                  ...(image.path ? { path: image.path } : {})
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
          if (removing.current.has(id)) return
          removing.current.add(id)
          void enqueue(async () => {
            try {
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
            } catch (error) {
              removing.current.delete(id)
              throw error
            }
            setEntries((current) => current.filter((entry) => entry.id !== id))
            await refresh()
          })
        }
      }}
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        onDragOver={(event) => {
          if (attacher !== null && attacher !== "loading" && event.dataTransfer.types.includes(FILE_PATH_MIME))
            event.preventDefault()
          else if (event.dataTransfer.types.includes("Files") && !isAppDrag(event.dataTransfer)) event.preventDefault()
        }}
        onDrop={(event) => {
          // A file dragged from the Files tab: attached as it is, with no copy (§6.1).
          const dragged = event.dataTransfer.getData(FILE_PATH_MIME)
          if (dragged && files.current) {
            event.preventDefault()
            add([], [dragged])
            return
          }
          // Nothing else dragged from inside the app is an attachment: a portrait goes to the frame as a tab.
          if (!event.dataTransfer.files.length || isAppDrag(event.dataTransfer)) return
          event.preventDefault()
          add(Array.from(event.dataTransfer.files))
        }}
        onPaste={(event) => {
          const pasted = Array.from(event.clipboardData.files)
          const taken = files.current ? pasted : imageFiles(pasted)
          if (!taken.length) return
          event.preventDefault()
          add(taken)
        }}
      >
        {children}
      </div>
    </ImagesContext.Provider>
  )
}
function ImageProvider(props: ChatSurfaceProps) {
  const user = useSession().user.id
  const attachments = useFileAttachments()
  // Opening the temporary "current" scope can overwrite this fork's durable send
  // marker before ReadPath resolves it. Only the resolved fork may reconcile images.
  if (props.view.forkId === null) return props.children
  const scope = `${user}:${props.session.chatId}:${props.view.forkId}`
  // Keyed by the part, so one registered later starts its hook afresh.
  return attachments ? (
    <WithAttacher key={attachments.id} part={attachments} session={props.session} view={props.view}>
      {(attacher) => <ImageScope key={scope} {...props} scope={scope} attacher={attacher} />}
    </WithAttacher>
  ) : (
    <ImageScope key={scope} {...props} scope={scope} attacher={null} />
  )
}

function WithAttacher({
  part,
  session,
  view,
  children
}: {
  part: FileAttachments
  session: ChatSession
  view: ChatSurfaceProps["view"]
  children: (attacher: FileAttacher | "loading" | null) => ReactNode
}) {
  const { useFileAttacher } = part
  return children(useFileAttacher(session, view))
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
      src={entry.mediaId ? mediaUrl(entry.mediaId, 208) : undefined}
      alt={entry.name}
      className="h-26 w-26 object-contain"
    />
  )
}
function ImageComposer(props: ComponentProps<typeof Composer>) {
  const state = useContext(ImagesContext)
  const library = state?.library ?? null
  const tab = useWorkbenchTab()
  // Listed by "Work on in a workshop" while it's mounted (spec/WORKSHOP-CARDS.md §4.1 point 3).
  const liveRef = useLiveLibraryComposer(
    library ? { chatId: props.session.chatId, title: props.view.chat?.title ?? "", tabId: tab?.tabId ?? null } : null
  )
  useLayoutEffect(() => {
    liveRef.current = {
      add: (refIds) => library?.add(refIds),
      // Once its tab is shown, the frame showing it is the focused one.
      focus: () => requestAnimationFrame(() => focusComposer())
    }
  })
  if (!state) return <Composer {...props} />
  const vision = props.view.history?.model?.vision
  const maxImages = props.view.history?.model?.maxImages ?? 4
  const images = state.entries.some((entry) => entry.kind !== "file")
  const items = library?.items.length ?? 0
  const filesHint = state.attacher
    ? `Attach files of any type. They're saved in ${state.attacher.folder}, where the assistant can open them. You can also paste or drop them here, or drag a file from the Files tab.`
    : "Attach images. You can also paste an image or drop it anywhere in the chat."
  return (
    <Composer
      {...props}
      attachmentInput={{
        count: state.entries.length + items,
        busy:
          !state.ready ||
          state.busy ||
          (library?.busy ?? false) ||
          state.entries.some((entry) => !entry.mediaId || !entry.saved),
        capture: state.capture,
        restore: state.restore,
        ...(library
          ? {
              drop: {
                takes: mayCarryLibrary,
                drop: (data: DataTransfer) => {
                  const refId = libraryRefOfDrop(data)
                  if (refId !== null) library.add([refId])
                }
              }
            }
          : {}),
        action: library ? (
          <AttachMenu
            disabled={!state.ready || state.busy}
            filesHint={filesHint}
            onFiles={state.add}
            library={library}
          />
        ) : state.attacher ? (
          <AttachButton anyType disabled={!state.ready || state.busy} onFiles={state.add} hint={filesHint} />
        ) : (
          <AttachButton disabled={!state.ready || state.busy} onFiles={state.add} />
        ),
        editor:
          state.entries.length > 0 || items > 0 || state.error || library?.error ? (
            <div className="flex flex-col gap-2" aria-label="Image attachments">
              {state.entries.length + items > 0 && (
                <>
                  <AttachmentList
                    label={library ? "Attachments" : state.attacher ? "Attached files" : "Attached images"}
                    more={library ? <ComposerLibraryTiles library={library} /> : null}
                    removeHint="Removes this image from the message. It isn't sent."
                    items={state.entries.map((entry) => ({
                      id: entry.id,
                      name: entry.name,
                      mediaId: entry.mediaId ?? null,
                      file: entry.file,
                      thumbnail: <DraftThumbnail entry={entry} />,
                      ...(entry.card
                        ? {
                            card: {
                              name: entry.card.name,
                              picture:
                                entry.card.format === "png" && entry.mediaId ? mediaUrl(entry.mediaId, 208) : null
                            }
                          }
                        : {}),
                      ...(entry.kind === "file" || entry.card || (!entry.mediaId && entry.path && !entry.file)
                        ? {
                            kind: "file" as const,
                            fileHref:
                              entry.mediaId && state.attacher
                                ? state.attacher.copyUrl(entry.mediaId, entry.name, true)
                                : null,
                            fileView:
                              entry.mediaId && state.attacher ? state.attacher.copyUrl(entry.mediaId, entry.name) : null
                          }
                        : {}),
                      ...(entry.sending ? { sending: true } : {})
                    }))}
                    onRemove={state.remove}
                  />
                  {state.entries.length === 0 ? null : state.attacher ? (
                    <p role="status" className="text-sm text-muted">
                      {`Saved in ${state.attacher.folder}. The assistant is told where each one is${
                        images && vision === false ? "; this model can't see images" : ""
                      }.`}
                    </p>
                  ) : (
                    <VisionNote vision={vision} maxImages={maxImages} />
                  )}
                </>
              )}
              {state.error && (
                <p role="alert" className="text-sm text-danger">
                  {state.error} {state.attacher ? "Remove an attachment" : "Remove an image"} or reload to retry.
                </p>
              )}
              {library?.error && (
                <p role="alert" className="text-sm text-danger">
                  {library.error}
                </p>
              )}
            </div>
          ) : null
      }}
    />
  )
}
/** Under attached images: whether the model replying can see them, and how many it's shown. */
function VisionNote({ vision, maxImages }: { vision: boolean | undefined; maxImages: number }) {
  return (
    <p role="status" className={`text-sm ${vision === false ? "text-danger" : "text-muted"}`}>
      {vision === false
        ? "This model cannot see images. Choose a vision model before replying."
        : vision === undefined
          ? "Choose a vision model to reply to these images."
          : `The model sees up to the last ${maxImages} images in context.`}
    </p>
  )
}

/**
 * The attachments of a chat not made yet (DESIGN §2.1), as the saved composer's: the same
 * paperclip, list, paste and drop. There's no chat or composer draft to hold them on the server
 * yet, so this browser keeps them (imageDraft.ts) under the pending chat's draft identity, the
 * key its typed text is kept by: each is stored before its upload, the upload (`POST
 * /chat/image`, which needs no chat) is replayed after a reload, and the first send carries
 * them in `StartChat`, which writes them with the chat in one transaction. What the first send
 * doesn't take (a Generate) moves to the saved chat's composer, whose replay attaches it there.
 */
function PendingImageScope({ scope: key, children }: { scope: string; children: ReactNode }) {
  const user = useSession().user.id
  const scope = `${user}:pending:${key}`
  const [entries, setEntries] = useState<readonly ImageDraftEntry[]>([])
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Taken by the first send that's out: shown as sending, not removable.
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set())
  const removing = useRef(new Set<string>())
  useEffect(() => {
    // Capture still sees the previous entries until React commits the new list.
    for (const id of removing.current) if (!entries.some((entry) => entry.id === id)) removing.current.delete(id)
  }, [entries])
  const queue = useRef(Promise.resolve())
  const enqueue = (run: () => Promise<void>) => {
    queue.current = queue.current.then(run).catch((error: unknown) => {
      setError(error instanceof Error ? error.message : "The image could not be saved.")
    })
    return queue.current
  }
  const refresh = async () => setEntries(await readImages(scope))
  const upload = async (entry: ImageDraftEntry) => {
    if (entry.mediaId || !entry.file) return
    try {
      const mediaId = await uploadImage(entry.file)
      const { file: _uploaded, ...rest } = entry
      await keepImage({ ...rest, mediaId })
    } catch (error) {
      throw new Error(
        `Upload failed. The attachment draft is kept in this browser. ${error instanceof Error ? error.message : "Reload to retry."}`
      )
    }
  }
  useEffect(() => {
    let live = true
    void enqueue(async () => {
      try {
        for (const entry of await readImages(scope)) await upload(entry)
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
    // The keyed part owns one scope; opening it replays its uploads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])
  const add = (picked: File[]) => {
    if (!ready) {
      setError("Wait for the chat to load before attaching.")
      return
    }
    void enqueue(async () => {
      setBusy(true)
      setError(null)
      try {
        const kept = await readImages(scope)
        const selected = imageFiles(picked)
        const large = selected.find((file) => file.size > ATTACHMENT_MAX_BYTES)
        if (large) throw new Error(`“${large.name}” is larger than ${formatByteSize(ATTACHMENT_MAX_BYTES)}.`)
        if (kept.length + selected.length > 32) throw new Error("A message can hold at most 32 attachments.")
        const firstPosition = Math.max(0, ...kept.map((entry) => entry.pendingPosition ?? 0)) + 1
        const added = selected.map((file, index): ImageDraftEntry => ({
          id: uuid(),
          scope,
          name: file.name || "Pasted image",
          file,
          pendingPosition: firstPosition + index
        }))
        // Keep the entire selection before any upload can fail or outlive this page.
        for (const entry of added) await keepImage(entry)
        await refresh()
        for (const entry of await readImages(scope)) {
          await upload(entry)
          await refresh()
        }
      } finally {
        setBusy(false)
      }
    })
  }
  const remove = (id: string) => {
    if (removing.current.has(id)) return
    removing.current.add(id)
    void enqueue(async () => {
      try {
        await dropImage(id)
      } catch (error) {
        removing.current.delete(id)
        throw error
      }
      setEntries((current) => current.filter((entry) => entry.id !== id))
      await refresh()
    })
  }
  const uploaded = entries.filter((entry) => entry.mediaId && !sending.has(entry.id))
  const asSent = (list: readonly ImageDraftEntry[]): MessageImages =>
    list.map((entry) => ({ mediaId: entry.mediaId!, altText: entry.name.slice(0, 2000) }))
  const capture = () => {
    const captured = uploaded.filter((entry) => !removing.current.has(entry.id))
    const ids = new Set(captured.map((entry) => entry.id))
    setSending((current) => new Set([...current, ...ids]))
    return {
      images: asSent(captured),
      finish: async (sent: boolean) => {
        await enqueue(async () => {
          if (sent) for (const entry of captured) await dropImage(entry.id)
          await refresh()
        })
        setSending((current) => new Set([...current].filter((id) => !ids.has(id))))
      }
    }
  }
  // The saved chat's composer replays its scope's entries (ImageScope): those uploaded attach
  // to its draft there.
  const carry = (chatId: string, forkId: string) =>
    enqueue(async () => {
      for (const entry of await readImages(scope)) {
        const { saved: _saved, sending: _sending, ...rest } = entry
        await keepImage({ ...rest, scope: `${user}:${chatId}:${forkId}` })
      }
      await refresh()
    })
  const value: PendingAttachments = {
    count: entries.length,
    images: asSent(uploaded),
    busy: !ready || busy || entries.some((entry) => !entry.mediaId),
    action: <AttachButton disabled={!ready || busy} onFiles={add} />,
    editor: (model) =>
      entries.length > 0 || error ? (
        <div className="flex flex-col gap-2" aria-label="Image attachments">
          {entries.length > 0 && (
            <>
              <AttachmentList
                label="Attached images"
                items={entries.map((entry) => ({
                  id: entry.id,
                  name: entry.name,
                  mediaId: entry.mediaId ?? null,
                  file: entry.file,
                  thumbnail: <DraftThumbnail entry={entry} />,
                  ...(sending.has(entry.id) ? { sending: true } : {})
                }))}
                removeHint="Removes this image from the message. It isn't sent."
                onRemove={remove}
              />
              <VisionNote vision={model?.vision} maxImages={model?.maxImages ?? 4} />
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error} Remove an image or reload to retry.
            </p>
          )}
        </div>
      ) : null,
    surface: {
      onDragOver: (event) => {
        if (event.dataTransfer.types.includes("Files") && !isAppDrag(event.dataTransfer)) event.preventDefault()
      },
      onDrop: (event) => {
        // Nothing dragged from inside the app is an attachment: a portrait goes to the frame as a tab.
        if (!event.dataTransfer.files.length || isAppDrag(event.dataTransfer)) return
        event.preventDefault()
        add(Array.from(event.dataTransfer.files))
      },
      onPaste: (event) => {
        const taken = imageFiles(event.clipboardData.files)
        if (!taken.length) return
        event.preventDefault()
        add(taken)
      }
    },
    capture,
    carry
  }
  return <PendingAttachmentsContext value={value}>{children}</PendingAttachmentsContext>
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
    <span
      data-layout-overlay="The image context toggle occupies the thumbnail's corner"
      className="absolute top-1 right-1 flex"
    >
      <ToggleIconButton
        label={label}
        hint={rule !== null ? label : `Click to ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
        icon={out ? "eyeOff" : "eye"}
        pressed={out}
        fillWhenPressed={false}
        disabled={rule !== null || busy}
        onClick={onToggle}
        className="tile-toggle"
      />
    </span>
  )
}

/**
 * A message's images in the timeline. A click opens one in the image column, the same viewer
 * and stack as portraits (owner, 2026-11-07), and a second click closes it; dragged onto a
 * frame it opens there as a tab. The viewer's own place where none is given (outside a chat):
 * a full-screen one.
 */
function ImageThumbnails(props: ComponentProps<typeof Thumbnails>) {
  if (!props.images.length) return null
  return (
    <EnsurePortraitViewer>
      <Thumbnails {...props} />
    </EnsurePortraitViewer>
  )
}

function Thumbnails({
  images,
  speaker,
  controls
}: {
  images: MessageImages
  /** Who the message is from, naming an image without a file name of its own ("Image from Mira"). */
  speaker: string
  /** A message's images: the context toggle and why each one isn't sent. */
  controls?: { entry: PathEntry; session: ChatSession }
}) {
  const viewer = usePortraitViewer()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const attachments = useFileAttachments()
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
  // A workshop's files of other types (§6.1) by name; the images' indexes are among images only.
  const pictures = imagesOnly(images)
  // A card file shows as a card among them, a PNG card too; its index stays among the images.
  const others = images.filter((image) => image.kind === "file" || image.card)
  return (
    <>
      {others.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Message files">
          {others.map((file, index) => (
            <li key={`${file.mediaId}:${index}`} className="min-w-0">
              <FileTile
                name={file.name ?? file.altText ?? "File"}
                href={attachments ? attachments.copyUrl(file.mediaId, file.name ?? file.altText ?? "file", true) : null}
                view={attachments ? attachments.copyUrl(file.mediaId, file.name ?? file.altText ?? "file") : null}
                show={attachments && file.path ? attachments.showHref(file.path) : null}
                card={
                  file.card
                    ? {
                        name: file.card.name,
                        picture: file.card.format === "png" ? mediaUrl(file.mediaId, 208) : null
                      }
                    : null
                }
              />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2 empty:hidden" aria-label="Message images">
        {pictures.map((image, index) => {
          if (image.card) return null
          const excluded = controls?.entry.excludedImages?.includes(image.mediaId) ?? false
          const left = controls && !excluded ? leftOutBy(leftOut, controls.entry, index) : null
          const reason = excluded ? "taken out of the context by you" : left ? left.message : null
          const picture = attachmentPicture(
            image.mediaId,
            attachmentName(image.altText, speaker, index, pictures.length)
          )
          const view = (
            <ImageMenu
              picture={picture}
              drags
              trigger={
                <Tooltip
                  label={
                    reason
                      ? `Not sent to the model: ${reason}`
                      : "Opens this image in the image viewer. Right-click, or drag it onto a frame, to open it as a tab."
                  }
                >
                  <button
                    type="button"
                    aria-label={`View image ${index + 1}${reason ? ` (not sent to the model: ${reason})` : ""}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      viewer?.open(picture)
                    }}
                    onDragStart={(event) => {
                      // Dropped on a frame, it opens there as a tab (features/workbench), never as an attachment.
                      carryOnDrag(event.dataTransfer, PICTURE_DRAG.id, viewer?.tabHref?.(picture))
                    }}
                    className="rounded-md border border-border outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <ContentImage
                      src={mediaUrl(image.mediaId, 320)}
                      alt={image.altText || `Image ${index + 1}`}
                      loading="lazy"
                      className={`max-h-48 max-w-full rounded-md object-contain ${reason ? "opacity-40 grayscale" : ""}`}
                    />
                  </button>
                </Tooltip>
              }
            />
          )
          return (
            <div
              key={`${image.mediaId}:${index}`}
              className="tile-toggle-surface relative"
              data-image-sent={reason ? "no" : "yes"}
            >
              {view}
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
    </>
  )
}
const noSubscribe = () => () => {}

function MessageThumbnails({ entry, session }: { entry: PathEntry; session: ChatSession }) {
  const cast = useCast()
  const speaker =
    nameOf(cast, entry.version.speakerEntityId ?? entry.firstSpeakerEntityId) ??
    (messageSide(entry, cast.cast) === "assistant" ? "the model" : "you")
  return <ImageThumbnails images={entry.version.images ?? []} speaker={speaker} controls={{ entry, session }} />
}

function QueuedThumbnails({ queued }: { queued: import("@dreamspan/shared/chat.ts").QueuedMessage }) {
  const cast = useCast()
  return <ImageThumbnails images={queued.images ?? []} speaker={nameOf(cast, queued.speakerEntityId) ?? "you"} />
}
export const registerImages = () => [
  chatComposer.register({ id: "chat.composer", order: 10, component: ImageComposer }),
  pendingAttachments.register({ id: "pending.images", component: PendingImageScope }),
  chatSurfaceProviders.register({ id: "chat.images", order: 40, component: ImageProvider }),
  messagePreviews.register({
    id: "message.images",
    order: 20,
    component: MessageThumbnails
  }),
  // A workshop message's cards, lorebooks and presets (spec/WORKSHOP-CARDS.md §4.2).
  messagePreviews.register({ id: "message.library", order: 25, component: MessageLibraryTiles }),
  messageEditorTools.register({ id: "message.editor-images", order: 5, component: EditorImages }),
  queuedPreviews.register({
    id: "queued.images",
    order: 10,
    component: QueuedThumbnails
  })
]
