import { ConfirmDialog } from "../../ui/Dialog.tsx"
import { Fragment } from "react"
import { CenterHeaderContent, compactHeaderControls } from "../../ui/CenterHeader.tsx"
import { DocumentSwitcher } from "./DocumentSwitcher.tsx"
import { usePlaceParam } from "../../usePlaceParam.ts"
// A list of notes as blocks (owner, 2026-11-01), the shape a preset's prompts have (ui/Block):
// each note's header is always shown, its switch, its name renamed in place, and under it where
// it goes and when; opening it shows its text, with its settings folded away under it. Several
// can be open, each remembers whether it is, and a short list opens them all. Whoever lists
// notes (a chat's Notes tab, a card's editor) picks which and supplies what's theirs.
import type { BinItem } from "@dreamspan/shared/bin.ts"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { textField } from "@dreamspan/shared/editing.ts"
import type { ChatNotePosition } from "@dreamspan/shared/editorApi.ts"
import type { Doc, LibraryRef, RefId } from "@dreamspan/shared/library.ts"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { useSession } from "../../session.ts"
import {
  Block,
  BlockBody,
  BlockHeader,
  BlockMenuButton,
  BlockOptions,
  BlockOptionsToggle,
  ExpandCollapseAll
} from "../../ui/Block.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { Menu, MenuItem, MenuLinkItem, MenuSeparator } from "../../ui/Menu.tsx"
import { openOnPlainClick } from "../../ui/links.ts"
import { type OpenBlocks, useOpenBlocks } from "../../ui/openBlocks.ts"
import { revealAdded } from "../../ui/reveal.ts"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useTruncated } from "../../ui/useTruncated.ts"
import { WindowClose } from "../../ui/WindowClose.tsx"
import { browserEnv } from "./backup.ts"
import type { Caller } from "./caller.ts"
import { RecoveredNotice, RestoredNotice, TextField } from "./controls.tsx"
import { type NoteCard, NoteSettings, noteSettingLines, noteState, noteTitle, SharedBanner } from "./notes.tsx"
import { usePresetWorkspace } from "./PresetWorkspace.tsx"
import { RevisionsDialog } from "./RevisionsDialog.tsx"
import { SaveRevision } from "./SaveRevision.tsx"
import { EditorStore, useEditorState, useLeaveGuard, useText, useValue } from "./store.ts"
import { NOTE_FOCUS } from "./workspaceViews.ts"
import { SlotOutlet } from "../../slots.tsx"
import { noteMenuItems } from "./fieldViews.ts"
import { type NoteTargetNames, noteTarget, useNoteTargetNames } from "./noteTargets.ts"

/** A note as a list shows it. */
export interface NoteListEntry {
  readonly ref: LibraryRef
  /** The note as listed, shown until its editor has read it. */
  readonly doc: Doc
  /** The shared note it shows, when it's in the bin. */
  readonly sharedBinned?: boolean
  /** Its on/off switch, in a chat. */
  readonly control?: ReactNode
  /** A line under its header, shown closed too (a summary note's). */
  readonly detail?: ReactNode
  /** What a feature adds to it (the chat's `chatNoteActions`), above its text. */
  readonly extra?: ReactNode
  /** A chat's own note: where it's edited, its branch and the message shown. */
  readonly chatNote?: ChatNotePosition
  /** Offers Delete: the list's owner says what happens after. */
  readonly onDeleted?: (item: BinItem) => void
  /** Its editor starts again from the saved note when this changes (a relink). */
  readonly generation?: number
}

/** Under a note's name: where it goes and when, and its role ("End of tail · always · as system"). */
const headerState = (doc: Doc, cards: ReadonlyArray<NoteCard>, names: NoteTargetNames | null) => {
  const placement = doc["placement"] as { mode?: string; role?: string } | undefined
  // In a prompt's place it's sent as that prompt is.
  const inPlace = noteTarget(doc) !== null && doc["own_position"] !== true
  const role = placement?.mode === "none" || inPlace ? null : `as ${placement?.role ?? "system"}`
  return [
    noteState(doc, cards, names),
    role,
    doc["scan_lore"] === true ? "lorebook scan" : null,
    doc["agent_editable"] === true ? "agent may edit" : null
  ]
    .filter((part) => part !== null)
    .join(" · ")
}

/**
 * One note as a block, editing through its store: over a chat, the workspace's, which the
 * large editor shares (`large`: the same block filling the chat's column, always open).
 */
export function NoteBlock({
  entry,
  cards,
  call,
  open: shownOpen,
  onOpenChange,
  settingsOpen,
  onSettingsOpenChange,
  onRelinked,
  large,
  reveal = false,
  onRevealed
}: {
  entry: NoteListEntry
  cards: ReadonlyArray<NoteCard>
  call: Caller
  open: boolean
  onOpenChange: (open: boolean) => void
  settingsOpen: boolean
  onSettingsOpenChange: (open: boolean) => void
  /** Told after it was saved as a shared note, unlinked from one, or its shared note restored. */
  onRelinked?: (() => void) | undefined
  /** Shown in the large editor over the chat, with a way back. */
  large?:
    | {
        readonly onClose: () => void
        readonly choices?: ReadonlyArray<{ value: RefId; label: string; updatedAt?: number }>
        /** "New note" at the end of the header switcher's list. */
        readonly create?: { label: string; hint: string; run: () => Promise<RefId | null> }
      }
    | undefined
  /** Just added: once it has read its note, it scrolls into view and flashes. */
  reveal?: boolean | undefined
  onRevealed?: (() => void) | undefined
}) {
  const userId = useSession().user.id
  const { ref, chatNote } = entry
  const workspace = usePresetWorkspace()
  const [store] = useState(
    () => workspace?.store(ref.id, chatNote) ?? new EditorStore(ref.id, userId, call, browserEnv, chatNote)
  )
  const open = large !== undefined || shownOpen
  const [error, setError] = useState<AppError | null>(null)
  const [historyRef, setHistoryRef] = usePlaceParam("noteHistory", "")
  const history = historyRef === ref.id
  const setHistory = (open: boolean) => setHistoryRef(open ? ref.id : "")
  const state = useEditorState(store)
  useEffect(() => {
    // A store the large editor shares is read once; it reads again after a reply (useLeaveGuard).
    if (store.snapshot === null) void store.load()
  }, [store])
  // Mounted closed too: its unsaved text is guarded on leaving, and a copy kept in this browser
  // comes back as the list opens.
  useLeaveGuard(store)
  const loaded = state.snapshot !== null
  const box = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!reveal || !loaded || !box.current) return
    const element = box.current
    // After the text box has its height; told only then, so clearing `reveal` can't cancel it.
    const frame = requestAnimationFrame(() => {
      revealAdded(element)
      onRevealed?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [reveal, loaded, onRevealed])
  const typedTitle = useText(store, ["title"])
  const typedContent = useText(store, ["content"])
  const placement = useValue<unknown>(store, ["placement"])
  const condition = useValue<unknown>(store, ["condition"])
  const scanLore = useValue<unknown>(store, ["scan_lore"])
  const onByDefault = useValue<unknown>(store, ["on_by_default"])
  const exportable = useValue<unknown>(store, ["exportable"])
  const agentEditable = useValue<unknown>(store, ["agent_editable"])
  const replaces = useValue<unknown>(store, ["replaces"])
  const ownPosition = useValue<unknown>(store, ["own_position"])
  const targetNames = useNoteTargetNames()
  const link = useValue<EntityId | undefined>(store, ["link"])
  // What it is now: what's typed and set once its editor read it, the listed note until then.
  const doc: Doc = loaded
    ? {
        ...entry.doc,
        title: typedTitle,
        content: typedContent,
        placement,
        condition,
        scan_lore: scanLore,
        on_by_default: onByDefault,
        exportable,
        agent_editable: agentEditable,
        replaces,
        own_position: ownPosition,
        link
      }
    : entry.doc
  const { title, derived } = noteTitle(doc["title"], doc["content"], ref.label)
  const linked = doc["link"] !== undefined
  const settingsShown = settingsOpen
  /** Closed, the note opens with its settings; open, its settings open or close. */
  const toggleSettings = () => {
    if (!open) {
      onOpenChange(true)
      onSettingsOpenChange(true)
    } else onSettingsOpenChange(!settingsOpen)
  }
  const card = typeof (doc["owner"] as { card?: unknown } | undefined)?.card === "string"

  const [deleteWarning, setDeleteWarning] = useState(false)
  const remove = async () => {
    // What's typed goes with the note to the bin, and comes back with it.
    await store.flush()
    const result = await call((client) => client("DeleteNote", { noteRefId: ref.id }), ["library"])
    if (result.ok) entry.onDeleted?.(result.value)
    else setError(result.error)
  }
  /** Saving as or unlinking from a shared note takes the saved note: its changes are saved first. */
  const relink = async (action: "share" | "unlink") => {
    await store.flush()
    if (store.state().dirty > 0) {
      const saved = await store.commit(null)
      if (!saved.ok) return setError(saved.error)
    }
    const position = chatNote ? { chatNote } : {}
    const result = await call(
      (client) =>
        action === "share"
          ? client("CreateSharedNote", { title: "", content: "", fromNoteRefId: ref.id, ...position })
          : client("UnlinkNote", { noteRefId: ref.id, ...position }),
      ["library"]
    )
    if (!result.ok) return setError(result.error)
    setError(null)
    await store.refresh()
    onRelinked?.()
  }
  const restoreShared = async () => {
    const bin = await call((client) => client("ListBin", { limit: 500, before: null }))
    if (!bin.ok) return setError(bin.error)
    const item = bin.value.find((it) => it.kind === "entity" && it.targetId === link)
    if (!item)
      return setError({
        tag: "NotFound",
        message: "The shared note isn't in the bin any more.",
        problems: [],
        reason: null
      })
    const restored = await call((client) => client("RestoreBinItem", { itemId: item.id }), ["library"])
    if (!restored.ok) return setError(restored.error)
    setError(null)
    await store.refresh()
    onRelinked?.()
  }

  const summary = headerState(doc, cards, targetNames)
  const { ref: titleRef, truncated: titleTruncated } = useTruncated(title)
  const { ref: summaryRef, truncated: summaryTruncated } = useTruncated(summary)
  const titleHint = open ? "Hide the note's text" : "Show the note's text"
  const name = (
    <span ref={titleRef} data-note-title data-layout-name className="block min-w-0 truncate">
      {title}
    </span>
  )
  const HeaderRow = large ? CenterHeaderContent : Fragment
  const toggle = large ? (
    <Tooltip label={<span className="[overflow-wrap:anywhere]">{title}</span>} enabled={titleTruncated}>
      <h2 aria-label={title} className="min-w-0 text-base font-semibold sm:truncate">
        <DocumentSwitcher
          refId={ref.id}
          label={title}
          kind="note"
          focus={NOTE_FOCUS}
          items={large?.choices}
          create={large?.create}
        />
      </h2>
    </Tooltip>
  ) : (
    <Tooltip
      label={
        titleTruncated ? (
          <>
            <span className="[overflow-wrap:anywhere]">{title}</span>
            <br />
            <span>{titleHint}</span>
          </>
        ) : (
          titleHint
        )
      }
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
        onClick={() => onOpenChange(!open)}
        className={`flex min-w-0 shrink items-center gap-1 rounded-md px-1 py-1 text-left text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus ${derived ? "text-muted italic" : "font-medium"}`}
      >
        <Icon
          name="right"
          size={14}
          className={`shrink-0 text-muted transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        {name}
      </button>
    </Tooltip>
  )
  const status = (
    <div
      data-note-status
      className={`flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted ${large ? "pl-1" : "pl-[22px]"} ${entry.control ? "ml-11" : ""}`}
    >
      <Tooltip label={<span className="[overflow-wrap:anywhere]">{summary}</span>} enabled={summaryTruncated}>
        <span
          ref={summaryRef}
          data-note-summary
          tabIndex={summaryTruncated ? 0 : undefined}
          data-layout-name
          className="block min-w-0 flex-1 truncate outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {summary}
        </span>
      </Tooltip>
      {linked && (
        <Tooltip label="Shows a shared note's text. Editing it changes it everywhere it's used.">
          <span className="shrink-0 text-muted">
            <Icon name="link" />
            <span className="sr-only">Shared note</span>
          </span>
        </Tooltip>
      )}
      {!entry.control && doc["on_by_default"] === true && <Badge>On in every chat</Badge>}
      {entry.sharedBinned && <Badge tone="warning">linked note is in the bin</Badge>}
      {doc["exportable"] === false && card && <Badge>Private</Badge>}
      {doc["kind"] === "imported_summary" && <Badge>summary</Badge>}
    </div>
  )
  return (
    <li>
      <Block ref={box} aria-label={`Note ${title}`} className="bg-canvas">
        <BlockHeader className="@container/note-header block!">
          <HeaderRow>
            <div
              data-note-title-row
              // One size for the row's icon buttons, the rename pencil with them: 32 px, and 24 px
              // where the header is narrow (a side panel at 1024 px), so an open note's seven
              // buttons leave its title room instead of crushing it under the chevron.
              className={`flex w-full min-w-0 items-center gap-1 ${large ? `${compactHeaderControls} sm:[&_[data-rename-pencil]]:size-8! max-sm:[&_[data-rename-pencil]]:size-6!` : "@min-[22rem]/note-header:[&_[data-rename-pencil]]:size-8! @max-[22rem]/note-header:[&_[data-rename-pencil]]:size-6!"}`}
            >
              {/* The note's switch leads the header, as before, so nothing moves when opening
              the note adds its save cluster at the end (owner, 2026-11-03). */}
              {entry.control && (
                <span className="flex h-8 w-10 shrink-0 items-center justify-center">{entry.control}</span>
              )}
              {loaded ? (
                <InlineRename
                  place={`note-title:${ref.id}:${chatNote?.chatId ?? ""}:${chatNote?.forkId ?? ""}:${chatNote?.slotId ?? ""}`}
                  value={typedTitle}
                  label={title}
                  hint="Renames this note"
                  allowEmpty
                  // The pencil on the title's line, centred with it and with the header's buttons.
                  className="min-w-0 flex-1 gap-1!"
                  onRename={(next) => {
                    store.setText(["title"], next)
                    void store.save(textField(["title"]))
                  }}
                >
                  {toggle}
                </InlineRename>
              ) : (
                <span className="flex min-w-0 flex-1">{toggle}</span>
              )}
              {/* The open note's save cluster, its settings and ⋯, together at the end with even
              gaps (DESIGN §10.1); the settings button stays put when opening the note adds Save. */}
              <span
                data-note-controls
                className={`ml-auto flex shrink-0 items-center gap-1 ${large ? "" : "@max-[22rem]/note-header:[&_button]:size-6!"}`}
              >
                {open && loaded && (
                  <span data-note-save className="inline-flex h-8 items-center @max-[22rem]/note-header:h-6">
                    <SaveRevision store={store} />
                  </span>
                )}
                <BlockOptionsToggle
                  open={open && settingsShown}
                  onToggle={toggleSettings}
                  label={`Settings of ${title}`}
                  hint={
                    open && settingsShown
                      ? "Click to hide this note's settings."
                      : open
                        ? "Click to show this note's settings: position, depth, role and when it applies."
                        : "Click to open this note with its settings: position, depth, role and when it applies."
                  }
                />
                <Menu
                  label={`Actions for ${title}`}
                  hint={
                    workspace && !large
                      ? "More: Large editor, History, Save as shared note, Delete"
                      : "More: History, Save as shared note, Delete"
                  }
                  trigger={<BlockMenuButton label={`Actions for ${title}`} />}
                >
                  {workspace && !large && (
                    <MenuLinkItem
                      icon="expand"
                      description="Opens this note in the main column, where it stays open while the side panel changes."
                      render={
                        <a
                          href={workspace.href(ref.id, NOTE_FOCUS)}
                          onClick={openOnPlainClick(() => workspace.open(ref.id, NOTE_FOCUS))}
                        />
                      }
                    >
                      Large editor
                    </MenuLinkItem>
                  )}
                  {loaded && <SlotOutlet slot={noteMenuItems} props={{ store, title }} />}
                  <MenuItem
                    icon="history"
                    disabled={!loaded}
                    description="Shows this note's saved revisions and what changed in each."
                    onClick={() => setHistory(true)}
                  >
                    History
                  </MenuItem>
                  {!linked && (
                    <MenuItem
                      icon="link"
                      disabled={!loaded}
                      description="Turns this note's text into a shared note that other chats and cards can use too."
                      onClick={() => void relink("share")}
                    >
                      Save as shared note
                    </MenuItem>
                  )}
                  {entry.onDeleted && (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        icon="trash"
                        tone="danger"
                        description="Moves this note to the bin, from which it can be restored later."
                        onClick={() => (doc.move_group ? setDeleteWarning(true) : void remove())}
                      >
                        Delete the note
                      </MenuItem>
                    </>
                  )}
                </Menu>
                {large && <WindowClose onClick={large.onClose} />}
              </span>
            </div>
          </HeaderRow>
          {status}
        </BlockHeader>
        {entry.detail}
        {open && (
          <>
            {/* Opened by the header's settings button, in place under the header, as a prompt's options are. */}
            {settingsShown && loaded && (
              <BlockOptions onClose={() => onSettingsOpenChange(false)} closeLabel="Close these settings">
                <NoteSettings store={store} cards={cards} />
              </BlockOptions>
            )}
            <BlockBody>
              <div className="flex flex-col gap-2">
                {entry.extra}
                <RestoredNotice count={state.restored} />
                {loaded && <RecoveredNotice store={store} />}
                {!loaded ? (
                  <p className="text-sm text-muted">Loading the note…</p>
                ) : linked ? (
                  <SharedBanner
                    chatNote={chatNote}
                    link={link!}
                    onUnlink={() => void relink("unlink")}
                    onRestore={() => void restoreShared()}
                  />
                ) : (
                  <TextField
                    store={store}
                    path={["content"]}
                    label={`Text of ${title}`}
                    labelHidden
                    rows={
                      large
                        ? Math.max(12, String(doc["content"] ?? "").split("\n").length)
                        : Math.min(8, Math.max(3, String(doc["content"] ?? "").split("\n").length))
                    }
                  />
                )}
              </div>
            </BlockBody>
          </>
        )}
        {error && (
          <div className="px-2 pb-2">
            <ErrorAlert error={error} />
          </div>
        )}
      </Block>
      <ConfirmDialog
        open={deleteWarning}
        onOpenChange={setDeleteWarning}
        title="Delete this moved note?"
        description={
          doc.replaces
            ? "Deleting this replacement restores the original card field, including every moved passage, in chats using this replacement. The own-turn notes stay. Restore this note from the bin to bring the split back."
            : "This note will no longer be sent. The shared replacement stays as it is; deleting the note does not put the passage back there. Restore the note from the bin, or switch the moved group off in the chat to send the original field again."
        }
        confirmLabel="Delete the note"
        onConfirm={() => {
          setDeleteWarning(false)
          void remove()
        }}
      />
      {history && (
        <RevisionsDialog
          store={store}
          call={call}
          title={`History: ${title}`}
          settingLines={noteSettingLines(cards)}
          onClose={() => setHistory(false)}
        />
      )}
    </li>
  )
}

/** Which notes are open, and which have their settings open: per note, in the URL (`ui/openBlocks.ts`). */
export function useNoteBlocks(count: number) {
  const blocks = useOpenBlocks("notesOpen", count)
  // Existing notes default to folded settings; creation explicitly opens a new note's.
  const settings = useOpenBlocks("noteSettings", Number.POSITIVE_INFINITY)
  return { blocks, settings }
}

/** Expand all and Collapse all, over every note in `ids`. */
export function NoteListControls({ ids, blocks }: { ids: ReadonlyArray<string>; blocks: OpenBlocks }) {
  if (ids.length === 0) return null
  return (
    <ExpandCollapseAll
      compact
      anyOpen={ids.some((id) => blocks.isOpen(id))}
      allOpen={ids.every((id) => blocks.isOpen(id))}
      expandHint="Show every note's text"
      collapseHint="Fold every note to its header: its name, where it goes and when"
      onExpand={() => blocks.setAll(ids, true)}
      onCollapse={() => blocks.setAll(ids, false)}
    />
  )
}

/** Notes as blocks: those of `entries` that `filter` keeps (one card's, say), in their order. */
export function NoteList({
  label,
  entries,
  filter,
  cards,
  call,
  blocks,
  settings,
  onRelinked,
  added = null,
  onRevealed
}: {
  /** The list's accessible name. */
  label: string
  entries: ReadonlyArray<NoteListEntry>
  filter?: ((entry: NoteListEntry) => boolean) | undefined
  /** The cards a condition can name. */
  cards: ReadonlyArray<NoteCard>
  call: Caller
  blocks: OpenBlocks
  settings: OpenBlocks
  /** A note was saved as a shared note, unlinked from one, or had its shared note restored. */
  onRelinked?: ((entry: NoteListEntry) => void) | undefined
  /** The note just added (its ref id), revealed once it shows. */
  added?: string | null | undefined
  onRevealed?: (() => void) | undefined
}) {
  const shown = filter ? entries.filter(filter) : entries
  const groups = new Map<string, Array<NoteListEntry>>()
  for (const entry of shown) {
    const owner = (entry.doc.owner as { card?: string } | undefined)?.card ?? ""
    const key = typeof entry.doc.move_group === "string" ? `${owner}:${entry.doc.move_group}` : entry.ref.id
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  const block = (entry: NoteListEntry) => (
    <NoteBlock
      key={`${entry.ref.id}:${entry.chatNote?.forkId ?? ""}:${entry.chatNote?.slotId ?? ""}:${entry.generation ?? 0}`}
      entry={entry}
      cards={cards}
      call={call}
      open={blocks.isOpen(entry.ref.id)}
      onOpenChange={(open) => blocks.setOpen(entry.ref.id, open)}
      settingsOpen={settings.isOpen(entry.ref.id)}
      onSettingsOpenChange={(open) => settings.setOpen(entry.ref.id, open)}
      onRelinked={() => onRelinked?.(entry)}
      reveal={added === entry.ref.id}
      onRevealed={onRevealed}
    />
  )
  return (
    <ul aria-label={label} className="flex flex-col gap-1.5">
      {[...groups].map(([key, group]) =>
        group.length < 2 ? (
          block(group[0]!)
        ) : (
          <li key={key} data-moved-note-pair>
            <div
              role="group"
              aria-label="Moved card text"
              className="flex min-w-0 flex-col gap-1 rounded-md border border-border p-2"
            >
              <div className="flex items-center gap-2 px-2 py-2 text-sm font-medium">
                {
                  (
                    group.find((e) => e.doc.condition !== undefined && String(e.doc.content ?? "").trim() !== "") ??
                    group[0]!
                  ).control
                }
                {String(group.find((e) => e.doc.condition !== undefined)?.doc.title ?? "Moved card text")}
              </div>
              <ul className="flex min-w-0 flex-col gap-1.5">
                {group.map((entry) => block({ ...entry, control: undefined }))}
              </ul>
            </div>
          </li>
        )
      )}
    </ul>
  )
}
