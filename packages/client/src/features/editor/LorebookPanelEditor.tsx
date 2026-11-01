// One lorebook, edited in a narrow column (owner, 2026-11-01): the side panel's Lorebooks tab
// opens the book picked in its list here, below the list, and the card editor can show a
// card's own book the same way. It takes one book: a store and where the book is in its
// document (`[]` for a library lorebook, `["character_book"]` for a card's own). Its entries
// are the table's compact headers (LorebookTable `panel`), each opening to its text and keys,
// its settings a level further down. What's typed is used as it's typed; Save cuts a revision.
import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import type { FieldPath } from "@rp/shared/editing.ts"
import { useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { RecoveredNotice, RestoredNotice } from "./controls.tsx"
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
export function BookName({ store, root, fallback }: { store: EditorStore; root: FieldPath; fallback: string }) {
  const typed = useText(store, [...root, "name"])?.trim()
  if (root.length === 0) return <RefName store={store} onRenamed={(label) => store.setText(["name"], label)} />
  const shown = typed || fallback
  return (
    <InlineRename value={typed ?? ""} label={shown} onRename={(next) => store.setText([...root, "name"], next)}>
      <span className="min-w-0 [overflow-wrap:anywhere]">{shown}</span>
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
  const state = useEditorState(store)
  const book = useValue<LorebookDoc | undefined>(store, root)
  const [searching, setSearching] = useState(false)
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
        <div className="flex items-start gap-1">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium">
              <BookName store={store} root={root} fallback={fallbackName} />
            </span>
            {note && <p className="text-xs text-muted">{note}</p>}
          </div>
          {onOpenLarge && (
            <Button
              className="h-8 shrink-0 px-2.5"
              hint="The book in the large editor over the chat: its entries in a table with their columns."
              onClick={onOpenLarge}
            >
              <Icon name="expand" />
              Large editor
            </Button>
          )}
          {onClose && (
            <IconButton
              label="Close the lorebook"
              hint="Closes the book here; what you typed stays, used as it's typed."
              icon="close"
              onClick={onClose}
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
            <SaveRevision store={store} compact />
            <RestoredNotice count={state.restored} />
            <RecoveredNotice store={store} />
          </>
        )}
        {searching && (
          <div id="panel-lore-search" className="rounded-md border border-border p-2">
            <SearchDialog
              store={store}
              inline
              idPrefix="panel-lore-search"
              scopes={lorebookScopes(root)}
              onReveal={setMatch}
            />
          </div>
        )}
        {book ? (
          <LorebookTable
            store={store}
            root={root}
            book={book}
            panel
            tools={
              <Button
                variant="ghost"
                className="h-8! w-8! px-0!"
                aria-label="Search and replace"
                aria-expanded={searching}
                aria-controls="panel-lore-search"
                hint="Find and replace in the entries' text, their keys, or anywhere in the book."
                onClick={() => setSearching(!searching)}
              >
                <Icon name="search" />
              </Button>
            }
          />
        ) : (
          <p className="text-sm text-muted">This book has no entries.</p>
        )}
      </section>
    </SearchNavigation>
  )
}
