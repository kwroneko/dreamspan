import { lorebookEditorSections } from "./cardSections.ts"
import { useCaller } from "./caller.ts"
import { addedTo } from "./StandaloneLorebook.tsx"
import type { ReactNode } from "react"
import { SlotOutlet } from "../../slots.tsx"
import { panelEditorActions } from "./panelActions.tsx"
import { SearchReplaceButton } from "../../ui/SearchReplace.tsx"
// One lorebook, edited in a narrow column (owner, 2026-11-01): the side panel's Lorebooks tab
// opens the book picked in its list here, below the list, and the card editor can show a
// card's own book the same way. It takes one book: a store and where the book is in its
// document (`[]` for a library lorebook, `["character_book"]` for a card's own). Its entries
// are the table's compact headers (LorebookTable `panel`), each opening to its text and keys,
// its settings a level further down. What's typed is used as it's typed; Save cuts a revision.
import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import type { FieldPath } from "@rp/shared/editing.ts"
import { useEffect, useRef, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { RecoveredNotice, RestoredNotice } from "./controls.tsx"
import { RefVariants } from "./RefVariants.tsx"
import { BookSettings } from "./LorebookForm.tsx"
import { LorebookTable } from "./LorebookTable.tsx"
import { RefName } from "./RefDialogs.tsx"
import { SaveRevision } from "./SaveRevision.tsx"
import { SearchDialog } from "./SearchDialog.tsx"
import { type SearchMatch, SearchNavigation } from "./searchNavigation.ts"
import { lorebookScopes } from "./searchScopes.ts"
import { type EditorStore, useEditorState, useLeaveGuard, useText, useValue } from "./store.ts"

/**
 * The book's name, renamed in place with the pencil. A library lorebook's is its library name,
 * and its document's `name` takes it too (exports carry it); a card's own book's is the
 * `character_book.name` field of the card.
 */
export function BookName({
  store,
  root,
  fallback,
  children
}: {
  store: EditorStore
  root: FieldPath
  fallback: string
  children?: ReactNode
}) {
  const typed = useText(store, [...root, "name"])?.trim()
  if (root.length === 0)
    return (
      <RefName store={store} onRenamed={(label) => store.setText(["name"], label)}>
        {children}
      </RefName>
    )
  const shown = typed || fallback
  return (
    <InlineRename value={typed ?? ""} label={shown} onRename={(next) => store.setText([...root, "name"], next)}>
      {children ?? <span className="min-w-0 [overflow-wrap:anywhere]">{shown}</span>}
    </InlineRename>
  )
}

export function LorebookPanelEditor({
  store,
  root,
  fallbackName,
  note,
  onClose,
  onOpenLarge,
  saveControls = true
}: {
  store: EditorStore
  root: FieldPath
  /** Its own Save and Revert; off inside an editor that has them already (a card's Lorebook tab). */
  saveControls?: boolean
  /** The name shown when the book has none: "Aria's lorebook". */
  fallbackName: string
  /** One line on what an edit reaches: "Part of Aria's card: saving it saves the card." */
  note?: string
  onClose?: () => void
  /** The book in the large editor over the chat. */
  onOpenLarge?: () => void
}) {
  const call = useCaller()
  const state = useEditorState(store)
  const book = useValue<LorebookDoc | undefined>(store, root)
  const [searching, setSearching] = useState(false)
  const findButton = useRef<HTMLButtonElement>(null)
  const [match, setMatch] = useState<SearchMatch | null>(null)
  useEffect(() => {
    if (store.snapshot === null) void store.load()
  }, [store])
  useLeaveGuard(store)
  if (state.loadError) return <ErrorAlert error={state.loadError} />
  if (!state.snapshot) return <p role="status">Loading the lorebook…</p>
  return (
    <SearchNavigation value={match}>
      <section aria-label={`Lorebook ${fallbackName}`} className="flex min-w-0 flex-col gap-3">
        <div data-editor-header className="flex items-start gap-0.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium">
              <BookName store={store} root={root} fallback={fallbackName} />
            </span>
            {note && <p className="text-xs text-muted">{note}</p>}
          </div>
          {onClose && (
            <IconButton label="Close the lorebook" hint="Closes this lorebook." icon="close" onClick={onClose} />
          )}
          {saveControls && <SaveRevision store={store} />}
          {onOpenLarge && (
            <IconButton
              label="Large editor"
              hint="Large editor: opens the lorebook over the chat, its entries in a table with their columns."
              icon="expand"
              onClick={onOpenLarge}
            />
          )}
        </div>
        {state.saveError && (
          <ErrorAlert
            error={{ ...state.saveError, message: `A change couldn't be kept: ${state.saveError.message}` }}
          />
        )}
        {saveControls && (
          <>
            <RestoredNotice count={state.restored} />
            <RecoveredNotice store={store} />
          </>
        )}
        {root.length === 0 && (
          <>
            <RefVariants store={store} />
            <p className="text-sm text-muted">{addedTo(state.snapshot.usedByChats)}</p>
            <SlotOutlet slot={lorebookEditorSections} only="lorebook.use" props={{ store, call }} />
          </>
        )}
        {book && <BookSettings store={store} root={root} entries={book.entries.length} />}
        {book ? (
          <LorebookTable
            store={store}
            root={root}
            book={book}
            panel
            tools={
              <div className="flex items-center gap-2">
                <SearchReplaceButton
                  ref={findButton}
                  className="@max-[30rem]:[&>span]:hidden"
                  open={searching}
                  controls="panel-lore-search"
                  onClick={() => setSearching(!searching)}
                />
                <SlotOutlet slot={panelEditorActions} props={{ store }} />
              </div>
            }
            toolPanel={
              searching && (
                <SearchDialog
                  store={store}
                  inline
                  idPrefix="panel-lore-search"
                  scopes={lorebookScopes(root)}
                  onReveal={setMatch}
                  onClose={() => {
                    setSearching(false)
                    findButton.current?.focus()
                  }}
                />
              )
            }
          />
        ) : (
          <p className="text-sm text-muted">This book has no entries.</p>
        )}
      </section>
    </SearchNavigation>
  )
}
