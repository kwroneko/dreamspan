// Cards, lorebooks and presets attached to a workshop's message (spec/WORKSHOP-CARDS.md §4):
// the kinds the composer's paperclip offers are registered parts (the workshop feature registers
// cards, lorebooks and presets), each with its picker and its tile's picture, so a plugin can add
// a kind or replace one. The items wait in the composer's draft on the server
// (`GetComposerLibrary`), so a reload keeps them, and go with the message the user sends.
import type { MessageLibrary, PathEntry, VersionLibrary } from "@dreamspan/shared/chat.ts"
import type { ComposerLibraryItem } from "@dreamspan/shared/composerApi.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import {
  type ComponentType,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import { makeRegistry } from "../../registry.ts"
import { CARD_DRAG, isAppDrag } from "../../ui/appDrags.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Icon, type IconName } from "../../ui/Icon.tsx"
import { linkMenuProps } from "../../ui/linkMenuState.ts"
import { Menu, MenuItem } from "../../ui/Menu.tsx"
import { CornerIconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { openNearProps } from "../workbench/kinds.ts"
import type { ChatSession } from "./session.ts"
import { replacedDraftOf } from "./chatStarted.ts"

type LibraryKind = ComposerLibraryItem["kind"]

/** The composer control id a chat kind shows to take library items (kindLooks.ts `shows`). */
export const LIBRARY_ATTACH = "composer.library-attach"

export interface LibraryPickerProps {
  /** Ticked in this picking. */
  readonly chosen: ReadonlySet<RefId>
  readonly toggle: (refId: RefId) => void
  /** Already in the message: shown ticked and left as they are. */
  readonly attached: ReadonlySet<string>
  readonly focusRef: RefObject<HTMLElement | null>
}

export interface LibraryAttachKind {
  readonly id: LibraryKind
  readonly order: number
  /** The paperclip menu's item ("Cards…") and its explanation. */
  readonly label: string
  readonly hint: string
  readonly icon: IconName
  /** "card", "lorebook", "preset": what the dialog and the Attach button count. */
  readonly noun: string
  /** The dialog's list, with ticks for several. */
  readonly Picker: ComponentType<LibraryPickerProps>
  /** A tile's picture: a card's portrait, else the kind's icon. */
  readonly Picture: ComponentType<{ readonly refId: string; readonly name: string }>
}

/** @public The workshop feature registers cards, lorebooks and presets here. */
export const libraryAttachKinds = makeRegistry<LibraryAttachKind>()

const useLibraryAttachKinds = () => {
  const snapshot = useSyncExternalStore(
    libraryAttachKinds.subscribe,
    libraryAttachKinds.snapshot,
    libraryAttachKinds.snapshot
  )
  return [...snapshot.entries].sort((a, b) => a.order - b.order)
}

export interface ComposerLibrary {
  readonly items: ReadonlyArray<ComposerLibraryItem>
  readonly ready: boolean
  readonly busy: boolean
  readonly error: string | null
  /** By id: the server knows each one's kind. True once the server has them. `hold`: as `LiveLibraryComposer`'s. */
  readonly add: (refIds: ReadonlyArray<string>, hold?: boolean) => Promise<boolean>
  readonly remove: (refId: string) => void
  /** What a send carries: the items shown now. */
  readonly capture: () => MessageLibrary
  /** After a send the server took them off the draft: read the list again. */
  readonly reload: () => void
  /** A send took them: what was handed over is spent. */
  readonly sent: () => void
}

const MAX = 16
/** How long a handover that didn't reach the server waits before it's tried again. */
const HANDOVER_RETRY_MS = 2_000

/**
 * What was handed over (`hold`) to new chat `chatId`'s composer in this browser tab and not sent
 * or removed since, kept for a reload: a chat opened in its place after a sweep (its composer
 * and attachments gone with it) gets them too, though the URL no longer names them (rev-dd4a #2).
 * Read (`next` undefined) or kept (empty: none).
 */
const handedOver = (chatId: string, next?: ReadonlyArray<string>): ReadonlyArray<string> => {
  const key = `dreamspan.handover:${chatId}`
  try {
    if (next === undefined) {
      const kept: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]")
      return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : []
    }
    if (next.length === 0) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify(next))
  } catch {
    // Storage unavailable: a sweep while this tab sleeps takes the items with it.
  }
  return next ?? []
}

/**
 * A workshop composer mounted in this browser tab (every workbench tab's view stays mounted):
 * what "Work on in a workshop" lists and puts an item into (spec/WORKSHOP-CARDS.md §4.1 point 3).
 */
export interface LiveLibraryComposer {
  readonly chatId: string
  readonly title: string
  /** Its workbench tab, null outside a workbench. */
  readonly tabId: string | null
  /**
   * True once the server has them on the composer's draft. `hold`: a handover the message must
   * carry (a new workshop's item): tried again until the server takes or refuses it, the send
   * waiting meanwhile.
   */
  readonly add: (refIds: ReadonlyArray<string>, hold?: boolean) => Promise<boolean>
  readonly focus: () => void
}

const live = new Set<LiveLibraryComposer>()
let liveSnapshot: ReadonlyArray<LiveLibraryComposer> = []
const liveListeners = new Set<() => void>()
const liveChanged = () => {
  liveSnapshot = [...live]
  for (const listener of liveListeners) listener()
}
const subscribeLive = (listener: () => void) => {
  liveListeners.add(listener)
  return () => void liveListeners.delete(listener)
}
/** The workshop composers mounted now, in the order they mounted. */
export const useLiveLibraryComposers = () => useSyncExternalStore(subscribeLive, () => liveSnapshot)

/** Lists this composer while it's mounted and takes library items (`composer` null: it takes none). */
export function useLiveLibraryComposer(composer: Omit<LiveLibraryComposer, "add" | "focus"> | null) {
  const handle = useRef<Pick<LiveLibraryComposer, "add" | "focus">>({
    add: () => Promise.resolve(false),
    focus: () => {}
  })
  const chatId = composer?.chatId
  const title = composer?.title
  const tabId = composer?.tabId
  useEffect(() => {
    if (chatId === undefined) return
    const entry: LiveLibraryComposer = {
      chatId,
      title: title ?? "",
      tabId: tabId ?? null,
      add: (refIds, hold) => handle.current.add(refIds, hold),
      focus: () => handle.current.focus()
    }
    live.add(entry)
    liveChanged()
    return () => {
      live.delete(entry)
      liveChanged()
    }
  }, [chatId, title, tabId])
  return handle
}

/**
 * A composer draft's library items, or null where the chat takes none. Every change goes to the
 * server in turn; the list shown is the server's answer.
 */
export function useComposerLibrary(
  session: ChatSession,
  draftId: string | null,
  takes: boolean
): ComposerLibrary | null {
  const [items, setItems] = useState<ReadonlyArray<ComposerLibraryItem>>([])
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The draft whose items were read: before that, the send waits. */
  const [loaded, setLoaded] = useState<string | null>(null)
  /** Handovers not on the server yet: the send waits for them (rev-dfu1 #5). */
  const [holding, setHolding] = useState(0)
  /** The last call's failure: refused (the item can't be attached) or not (try again). */
  const refused = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const queue = useRef(Promise.resolve())
  const shown = useRef(items)
  // Added before the draft was known (a new workshop's page handing over what it was opened
  // with): attached once it is, after its first read.
  const early = useRef<ReadonlyArray<RefId>>([])
  /** Those adds, told once the server has them. */
  const earlyDone = useRef<Array<(ok: boolean) => void>>([])
  useEffect(() => {
    shown.current = items
  }, [items])
  /** Runs `work` after the calls before it: true when the server answered with the list. */
  const run = (work: () => Promise<ReadonlyArray<ComposerLibraryItem> | null>) => {
    const done = queue.current.then(async () => {
      setBusy(true)
      try {
        const next = await work()
        if (next !== null) setItems(next)
        return next !== null
      } finally {
        setBusy(false)
      }
    })
    queue.current = done.then(
      () => undefined,
      () => undefined
    )
    return done.catch(() => false)
  }
  const call = async (
    rpc: "GetComposerLibrary" | "SetComposerLibrary",
    change?: { add: ReadonlyArray<RefId>; remove: ReadonlyArray<RefId> }
  ) => {
    if (draftId === null) return null
    const key = { chatId: session.chatId, draftId }
    const outcome = await session.call((client) =>
      rpc === "GetComposerLibrary"
        ? client("GetComposerLibrary", key)
        : client("SetComposerLibrary", { ...key, add: change!.add, remove: change!.remove })
    )
    if (!outcome.ok) {
      refused.current = outcome.error.tag === "NotFound"
      setError(
        outcome.error.tag === "NotFound" && change?.add.length
          ? "Only cards, lorebooks and presets in your library can be attached."
          : outcome.error.message
      )
      return null
    }
    setError(null)
    return outcome.value
  }
  useEffect(() => {
    if (!takes || draftId === null) return
    let live = true
    // The items the draft holds, read until a read succeeds: until then a send would go
    // without the ones attached before a reload, so it waits (rev-dd3 #6).
    const read = async () => {
      const items = await call("GetComposerLibrary")
      if (!live) return null
      setReady(true)
      if (items === null) setTimeout(() => live && void run(read), HANDOVER_RETRY_MS)
      else {
        setLoaded(draftId)
        // Opened in place of a new chat swept with what was handed over to it: those come here.
        const replaced = replacedDraftOf(session.chatId)
        const carried = replaced === null ? [] : handedOver(replaced)
        if (replaced !== null && carried.length > 0) {
          handedOver(session.chatId, [...new Set([...handedOver(session.chatId), ...carried])])
          handedOver(replaced, [])
          const missing = carried.filter((refId) => !items.some((there) => there.refId === refId))
          if (missing.length > 0) void addHeld(missing)
        }
      }
      return items
    }
    void run(read)
    if (early.current.length > 0) {
      const waiting = early.current
      const told = earlyDone.current
      early.current = []
      earlyDone.current = []
      void run(() => call("SetComposerLibrary", { add: waiting, remove: [] })).then((ok) => {
        for (const tell of told) tell(ok)
      })
    }
    return () => {
      live = false
    }
    // One read per draft: the queue and the calls read the newest state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takes, draftId])
  const addOnce = (added: ReadonlyArray<string>) => {
    const fresh = [...new Set(added as ReadonlyArray<RefId>)].filter(
      (refId) => !shown.current.some((there) => there.refId === refId)
    )
    if (fresh.length === 0) return Promise.resolve(true)
    if (draftId === null) {
      early.current = [...new Set([...early.current, ...fresh])]
      return new Promise<boolean>((resolve) => earlyDone.current.push(resolve))
    }
    if (shown.current.length + fresh.length > MAX) {
      // Refused: tried again it would only hold the send (rev-dd3 #7).
      refused.current = true
      setError(`A message can carry at most ${MAX} cards, lorebooks and presets.`)
      return Promise.resolve(false)
    }
    return run(() => call("SetComposerLibrary", { add: fresh, remove: [] }))
  }
  // A handover tried again goes to the draft as it is then (known by now, when it wasn't).
  const latestAdd = useRef(addOnce)
  useLayoutEffect(() => {
    latestAdd.current = addOnce
  })
  /** A handover the message must carry: tried again until the server takes or refuses it. */
  const addHeld = (added: ReadonlyArray<string>) => {
    setHolding((n) => n + 1)
    const attempt = async (): Promise<boolean> => {
      refused.current = false
      const ok = await latestAdd.current(added)
      if (ok || refused.current || !mounted.current) return ok
      await new Promise((resolve) => setTimeout(resolve, HANDOVER_RETRY_MS))
      return mounted.current ? attempt() : false
    }
    return attempt()
      .then((ok) => {
        if (ok) handedOver(session.chatId, [...new Set([...handedOver(session.chatId), ...added])])
        return ok
      })
      .finally(() => setHolding((n) => n - 1))
  }
  if (!takes) return null
  return {
    items,
    ready,
    busy: busy || holding > 0 || (draftId !== null && loaded !== draftId),
    error,
    add: (added, hold = false) => (hold ? addHeld(added) : addOnce(added)),
    remove: (refId) => {
      handedOver(
        session.chatId,
        handedOver(session.chatId).filter((id) => id !== refId)
      )
      void run(() => call("SetComposerLibrary", { add: [], remove: [refId as RefId] }))
    },
    capture: () => shown.current.map(({ kind, refId }) => ({ kind, refId })),
    reload: () => void run(() => call("GetComposerLibrary")),
    sent: () => {
      handedOver(session.chatId, [])
      void run(() => call("GetComposerLibrary"))
    }
  }
}

/** Where a tile's click opens the item: where a card editor is shown beside the chat (workbench). */
const EDITOR_KIND = "library.editor"
const libraryHref = (refId: string) => `/library/${encodeURIComponent(refId)}`

/**
 * The library item a drop carries, by its ref: a card dragged from a tile, the library or the
 * Cast (`CARD_DRAG`), or a link of this app's to `/library/<ref>`. Null for anything else.
 */
export const libraryRefOfDrop = (data: DataTransfer): string | null => {
  const href =
    data.getData(CARD_DRAG.mime) || (isAppDrag(data) ? (data.getData("text/uri-list").split("\n")[0] ?? "") : "")
  if (!href) return null
  try {
    const url = new URL(href, location.origin)
    const match = url.origin === location.origin ? /^\/library\/([^/]+)$/.exec(url.pathname) : null
    return match ? decodeURIComponent(match[1]!) : null
  } catch {
    return null
  }
}

/** While a drag is over (its data unreadable until the drop): whether it may carry a library item. */
export const mayCarryLibrary = (data: DataTransfer) =>
  data.types.includes(CARD_DRAG.mime) ||
  (isAppDrag(data) && data.types.includes("text/uri-list") && !data.types.includes("Files"))

const toggled = (set: ReadonlySet<RefId>, refId: RefId) => {
  const next = new Set(set)
  if (!next.delete(refId)) next.add(refId)
  return next
}

/** A kind's picker in a dialog: ticks for several, then Attach with the count. */
function PickDialog({
  kind,
  attached,
  onAttach,
  onClose
}: {
  kind: LibraryAttachKind
  attached: ReadonlySet<string>
  onAttach: (refIds: ReadonlyArray<RefId>) => void
  onClose: () => void
}) {
  const [chosen, setChosen] = useState<ReadonlySet<RefId>>(new Set())
  const focusRef = useRef<HTMLElement>(null)
  const Picker = kind.Picker
  const count = chosen.size
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={`Attach ${kind.noun}s`}
      description={kind.hint}
      initialFocus={() => focusRef.current}
    >
      {/* A fixed height: the list scrolls inside, and the buttons stay where they are as it filters. */}
      <div className="flex h-[min(28rem,55dvh)] min-h-0 flex-col gap-2">
        <Picker
          chosen={chosen}
          toggle={(refId) => {
            if (!attached.has(refId)) setChosen((current) => toggled(current, refId))
          }}
          attached={attached}
          focusRef={focusRef}
        />
      </div>
      <DialogActions>
        <Button variant="ghost" hint="Closes this list without attaching anything." onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={count === 0}
          hint={
            count === 0
              ? `Tick the ${kind.noun}s to attach first.`
              : `Puts the ticked ${count === 1 ? kind.noun : `${kind.noun}s`} in your message. They're sent with it.`
          }
          onClick={() => {
            onAttach([...chosen])
            onClose()
          }}
        >
          {count === 0 ? "Attach" : `Attach ${count}`}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/**
 * A workshop's paperclip: a menu in the same button (spec/WORKSHOP-CARDS.md §4.1), with files
 * from this device and each registered kind's picker.
 */
export function AttachMenu({
  disabled,
  filesHint,
  onFiles,
  library
}: {
  disabled: boolean
  filesHint: string
  onFiles: (files: File[]) => void
  library: ComposerLibrary
}) {
  const picker = useRef<HTMLInputElement>(null)
  const kinds = useLibraryAttachKinds()
  const [picking, setPicking] = useState<LibraryAttachKind | null>(null)
  return (
    <>
      <input
        ref={picker}
        className="sr-only"
        disabled={disabled}
        type="file"
        multiple
        aria-label="Choose files"
        onChange={(event) => {
          onFiles(Array.from(event.currentTarget.files ?? []))
          event.currentTarget.value = ""
        }}
      />
      <Menu
        label="Attach"
        side="top"
        align="start"
        hint="Attach files, or cards, lorebooks and presets from your library. You can also paste or drop them here."
        trigger={
          <Button variant="ghost" aria-label="Attach" disabled={disabled} className="w-9 px-0!">
            <Icon name="paperclip" />
          </Button>
        }
      >
        <MenuItem icon="file" description={filesHint} onClick={() => picker.current?.click()}>
          Files from this device…
        </MenuItem>
        {kinds.map((kind) => (
          <MenuItem
            key={kind.id}
            icon={kind.icon}
            description={kind.hint}
            disabled={!library.ready}
            onClick={() => setPicking(kind)}
          >
            {kind.label}
          </MenuItem>
        ))}
      </Menu>
      {picking && (
        <PickDialog
          kind={picking}
          attached={new Set(library.items.map((item) => item.refId))}
          onAttach={library.add}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  )
}

/**
 * An attached item as a tile (§4.2): its picture in the attachments' 104 px box, its name under
 * it, opening it where a card editor is shown beside the chat. `corner` is the remove X.
 */
function LibraryTile({
  item,
  hint,
  corner
}: {
  item: { readonly kind: string; readonly refId: string; readonly name: string }
  hint: string
  corner?: ReactNode
}) {
  const kind = useLibraryAttachKinds().find((entry) => entry.id === item.kind)
  const Picture = kind?.Picture
  return (
    <div data-library-tile={item.refId} className="flex w-26 flex-col items-center gap-1">
      <div className="tile-toggle-surface relative">
        <Tooltip label={hint}>
          <a
            href={libraryHref(item.refId)}
            aria-label={`Open ${item.name}`}
            className="flex h-26 w-26 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-raised outline-none focus-visible:ring-2 focus-visible:ring-focus"
            {...openNearProps(EDITOR_KIND)}
            {...linkMenuProps}
          >
            {Picture ? <Picture refId={item.refId} name={item.name} /> : <Icon name="file" className="text-muted" />}
          </a>
        </Tooltip>
        {corner}
      </div>
      <span className="w-full truncate text-center text-xs text-muted" title={item.name}>
        {item.name}
      </span>
    </div>
  )
}

/** The composer's attached items, as list rows beside its files and images, each with its X. */
export function ComposerLibraryTiles({ library }: { library: Pick<ComposerLibrary, "items" | "remove"> }) {
  return library.items.map((item) => (
    <li key={item.refId} className="flex flex-col items-center gap-1">
      <LibraryTile
        item={item}
        hint={`Opens ${item.name}. It goes with your message, and the assistant can read and change it from then on.`}
        corner={
          <span
            data-layout-overlay="The remove X straddles the thumbnail's corner"
            className="absolute -top-3 -right-3 flex"
          >
            <CornerIconButton
              label={`Remove ${item.name}`}
              icon="close"
              hint={`Takes ${item.name} out of this message. It stays in your library.`}
              onClick={() => library.remove(item.refId)}
              className="tile-action relative"
            />
          </span>
        }
      />
    </li>
  ))
}

/** A sent message's items (§4.2): the same tiles, by the names they had when sent. */
export function MessageLibraryTiles({ entry }: { entry: PathEntry }) {
  const items: VersionLibrary = entry.version.library ?? []
  if (items.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-3" aria-label="Attached from your library">
      {items.map((item) => (
        <li key={`${item.kind}:${item.refId}`}>
          <LibraryTile
            item={item}
            hint={`Opens ${item.name} as it is now. Attached: the assistant can read and change it from here on.`}
          />
        </li>
      ))}
    </ul>
  )
}
