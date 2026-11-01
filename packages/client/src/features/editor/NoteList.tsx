// A list of notes as blocks (owner, 2026-11-01), the shape a preset's prompts have (ui/Block):
// each note's header is always shown, its switch, its name renamed in place, and under it where
// it goes and when; opening it shows its text, with its settings folded away under it. Several
// can be open, each remembers whether it is, and a short list opens them all. Whoever lists
// notes (a chat's Notes tab, a card's editor) picks which and supplies what's theirs.
import type { BinItem } from "@rp/shared/bin.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import { textField } from "@rp/shared/editing.ts"
import type { ChatNotePosition } from "@rp/shared/editorApi.ts"
import type { Doc, LibraryRef } from "@rp/shared/library.ts"
import { type ReactNode, useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { useSession } from "../../session.ts"
import {
  Block,
  BlockBody,
  BlockHeader,
  BlockMenuButton,
  BlockSection,
  BlockToggle,
  ExpandCollapseAll
} from "../../ui/Block.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { Menu, MenuItem, MenuSeparator } from "../../ui/Menu.tsx"
import { type OpenBlocks, useOpenBlocks } from "../../ui/openBlocks.ts"
import { Popover } from "../../ui/Popover.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { iconButtonClass, Tooltip } from "../../ui/Tooltip.tsx"
import { browserEnv } from "./backup.ts"
import type { Caller } from "./caller.ts"
import { RecoveredNotice, RestoredNotice, TextField } from "./controls.tsx"
import {
  type NoteCard,
  NoteSettings,
  noteSettingLines,
  noteState,
  noteTitle,
  SharedBanner,
  settingsSummary
} from "./notes.tsx"
import { RevisionsDialog } from "./RevisionsDialog.tsx"
import { SaveRevision } from "./SaveRevision.tsx"
import { EditorStore, useEditorState, useLeaveGuard, useText, useValue } from "./store.ts"

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

const BRANCH_EXPLANATION =
  "A chat's note is tied to its branch: a change applies from the branch's latest message on, and earlier messages keep what they were sent with. Each branch keeps its own version, and its own unsaved changes. History says where each change took effect."

/** Where a chat's own note's change applies, said only when it matters (owner, 2026-11-01). */
function BranchLine({ store }: { store: EditorStore }) {
  const [open, setOpen] = useState(false)
  const at = useEditorState(store).snapshot?.chatNote
  if (!at || (at.latest && !at.otherBranches)) return null
  const text = !at.latest
    ? `Changes apply from message ${at.message ?? 1} on; later messages keep the current text`
    : "Other branches have their own version"
  return (
    <p className="flex items-center gap-1 px-2 pb-1 pl-10 text-xs text-muted">
      <span>{text}</span>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger={<Icon name="info" size={14} />}
        triggerLabel="How a chat's note follows its branch"
        hint="How a chat's note follows its branch"
        title="Tied to its branch"
        triggerClassName={`${iconButtonClass()} size-6!`}
        side="bottom"
      >
        <p className="text-sm">{BRANCH_EXPLANATION}</p>
      </Popover>
    </p>
  )
}

/** One note as a block, editing through its own store. */
function NoteBlock({
  entry,
  cards,
  call,
  open,
  onOpenChange,
  settingsOpen,
  onSettingsOpenChange,
  onRelinked
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
}) {
  const userId = useSession().user.id
  const { ref, chatNote } = entry
  const [store] = useState(() => new EditorStore(ref.id, userId, call, browserEnv, chatNote))
  const [error, setError] = useState<AppError | null>(null)
  const [history, setHistory] = useState(false)
  const state = useEditorState(store)
  useEffect(() => {
    void store.load()
  }, [store])
  // Mounted closed too: its unsaved text is guarded on leaving, and a copy kept in this browser
  // comes back as the list opens.
  useLeaveGuard(store)
  const loaded = state.snapshot !== null
  const typedTitle = useText(store, ["title"])
  const typedContent = useText(store, ["content"])
  const placement = useValue<unknown>(store, ["placement"])
  const condition = useValue<unknown>(store, ["condition"])
  const scanLore = useValue<unknown>(store, ["scan_lore"])
  const onByDefault = useValue<unknown>(store, ["on_by_default"])
  const exportable = useValue<unknown>(store, ["exportable"])
  const agentEditable = useValue<unknown>(store, ["agent_editable"])
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
        link
      }
    : entry.doc
  const { title, derived } = noteTitle(doc["title"], doc["content"], ref.label)
  const linked = doc["link"] !== undefined
  const card = typeof (doc["owner"] as { card?: unknown } | undefined)?.card === "string"

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
    onRelinked?.()
  }

  const status = (
    <span className="flex flex-wrap items-center gap-1 text-xs text-muted">
      <span>{noteState(doc, cards)}</span>
      {/* Without a switch (a card's editor), whether a card's note is on in every chat. */}
      {!entry.control && doc["on_by_default"] === true && <Badge>On in every chat</Badge>}
      {entry.sharedBinned && <Badge tone="warning">linked note is in the bin</Badge>}
      {doc["exportable"] === false && card && <Badge>Private</Badge>}
      {doc["kind"] === "imported_summary" && <Badge>summary</Badge>}
    </span>
  )
  const name = (
    <span className="flex min-w-0 items-center gap-1.5">
      {linked && (
        <Tooltip label="Shows a shared note: its text is the shared note's">
          <span className="shrink-0 text-muted">
            <Icon name="link" />
            <span className="sr-only">Shared note</span>
          </span>
        </Tooltip>
      )}
      <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
    </span>
  )
  const toggle = (
    <BlockToggle
      open={open}
      onToggle={() => onOpenChange(!open)}
      label={title}
      name={name}
      detail={status}
      derived={derived}
      hint={open ? "Hide the note's text" : "Show the note's text"}
    />
  )
  return (
    <li>
      <Block aria-label={`Note ${title}`} className="bg-canvas">
        <BlockHeader>
          {entry.control && <span className="flex h-8 w-10 shrink-0 items-center justify-center">{entry.control}</span>}
          {loaded ? (
            <InlineRename
              value={typedTitle}
              label={title}
              allowEmpty
              className="min-w-0 flex-1"
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
          <Menu
            label={`Actions for ${title}`}
            hint="More: its History, Save as shared note, Delete"
            trigger={<BlockMenuButton label={`Actions for ${title}`} />}
          >
            <MenuItem
              icon="history"
              disabled={!loaded}
              description="Its revisions, what changed in each (settings in words), and where each took effect"
              onClick={() => setHistory(true)}
            >
              History
            </MenuItem>
            {!linked && (
              <MenuItem
                icon="link"
                disabled={!loaded}
                description="Makes its text a shared note this one shows, so other cards and chats can use it too"
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
                  description="Moves it to the bin, where it can be restored"
                  onClick={() => void remove()}
                >
                  Delete the note
                </MenuItem>
              </>
            )}
          </Menu>
        </BlockHeader>
        <BranchLine store={store} />
        {entry.detail}
        {open && (
          <>
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
                    rows={Math.min(8, Math.max(3, String(doc["content"] ?? "").split("\n").length))}
                  />
                )}
              </div>
            </BlockBody>
            {loaded && (
              <BlockSection
                open={settingsOpen}
                onToggle={() => onSettingsOpenChange(!settingsOpen)}
                title="Settings"
                label={title}
                summary={settingsSummary(doc)}
                hint={settingsOpen ? "Hide the note's settings" : "Its position, role, when it applies, and switches"}
              >
                <NoteSettings store={store} cards={cards} />
              </BlockSection>
            )}
            {loaded && (
              <div className="flex flex-wrap items-center gap-2 border-t border-border px-2 py-1.5">
                <SaveRevision store={store} compact />
              </div>
            )}
          </>
        )}
        {error && (
          <div className="px-2 pb-2">
            <ErrorAlert error={error} />
          </div>
        )}
      </Block>
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

/** Which notes are open, and which have their settings open: remembered per note in this browser. */
export function useNoteBlocks(count: number) {
  const userId = useSession().user.id
  const blocks = useOpenBlocks(`rp.noteBlocks.${userId}`, count)
  // Settings stay folded until a note's are opened.
  const settings = useOpenBlocks(`rp.noteSettings.${userId}`, Number.POSITIVE_INFINITY)
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
  onRelinked
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
}) {
  const shown = filter ? entries.filter(filter) : entries
  return (
    <ul aria-label={label} className="flex flex-col gap-1.5">
      {shown.map((entry) => (
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
        />
      ))}
    </ul>
  )
}
