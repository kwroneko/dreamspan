// The lorebooks a prompt preset sends (owner, 2026-11-01): style and rules entries that come in
// when their words appear, which prompts can't do. Each is a block with its own switch, listed
// with the prompts in the large editor and the Prompt preset tab; every chat using the preset
// scans them, as it does its own books. A preset's `lorebooks` are field drafts like its
// prompts': the switch is live, and Save cuts a revision.
import type { PresetLorebook } from "@rp/shared/docs/preset.ts"
import type { LibraryRef, RefId } from "@rp/shared/library.ts"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { useLibraryLorebooks } from "./libraryLorebooks.ts"
import { LorebookPicker } from "./LorebookPicker.tsx"
import { type EditorStore, useValue } from "./store.ts"

const NONE: ReadonlyArray<PresetLorebook> = []

/** Where the large editor scrolls for "From the preset" in the chat's Lorebooks tab. */
export const PRESET_LOREBOOKS_FOCUS = "lorebooks"

export function PresetLorebooks({
  store,
  column = false,
  onOpen
}: {
  store: EditorStore
  column?: boolean
  /** Opens a book's editor (over the chat); without it, a link to its page. */
  onOpen?: ((ref: RefId) => void) | undefined
}) {
  const books = useValue<ReadonlyArray<PresetLorebook> | undefined>(store, ["lorebooks"]) ?? NONE
  const library = useLibraryLorebooks()
  const [adding, setAdding] = useState(false)
  const byId = new Map((library ?? []).map((ref) => [ref.id as string, ref]))
  const attach = (ref: LibraryRef) => {
    setAdding(false)
    const entry = { id: ref.id, enabled: true }
    if (store.value(["lorebooks"]) === undefined) store.setValue(["lorebooks"], [entry])
    else store.setValue(["lorebooks", `id=${ref.id}`], entry)
  }
  return (
    <section
      aria-labelledby="preset-lorebooks"
      data-preset-lorebooks
      className={`flex min-w-0 flex-col gap-1.5 ${column ? "pt-3" : "pt-4"} scroll-mt-[var(--preset-toolbar-height,1rem)]`}
    >
      <h3 id="preset-lorebooks" className="text-xs font-medium tracking-wide text-muted uppercase">
        Lorebooks sent with this preset
      </h3>
      <p className="text-xs text-muted">
        Every chat using this preset scans them, as it does its own books: for style and rules entries that come in when
        their words appear.
      </p>
      {books.length > 0 && (
        <ul aria-label="Lorebooks sent with this preset" className="flex flex-col gap-1">
          {books.map((book) => {
            const ref = byId.get(book.id)
            const name = ref?.label ?? (library === null ? "…" : "A lorebook no longer in the library")
            return (
              <li
                key={book.id}
                className={`flex items-center gap-1 rounded-md border border-border px-2 py-1.5 ${book.enabled ? "" : "opacity-70"}`}
              >
                <Icon name="book" className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1 pl-1">
                  <Switch
                    checked={book.enabled}
                    disabled={!ref}
                    onCheckedChange={(next) => store.setValue(["lorebooks", `id=${book.id}`, "enabled"], next)}
                    hint="Off, the preset keeps the book but doesn't send it, in every chat using it. Used as you switch it; Save cuts a revision."
                    description={ref?.subtitle || undefined}
                  >
                    {name}
                  </Switch>
                </div>
                {ref &&
                  (onOpen ? (
                    <Button
                      variant="ghost"
                      className="h-8 shrink-0 px-2"
                      aria-label={`Open ${name}`}
                      hint="Opens the book's editor. It's the library's book: a change there reaches every chat and preset using it."
                      onClick={() => onOpen(ref.id)}
                    >
                      Open
                    </Button>
                  ) : (
                    <Tooltip label="Opens the book's page. It's the library's book: a change there reaches every chat and preset using it.">
                      <Link
                        to="/library/$refId"
                        params={{ refId: ref.id }}
                        className="shrink-0 px-2 text-sm text-accent underline-offset-4 hover:underline"
                        aria-label={`Open ${name}`}
                      >
                        Open
                      </Link>
                    </Tooltip>
                  ))}
                <IconButton
                  label={`Take ${name} off the preset`}
                  hint="Takes the book off this preset (the library keeps it). Revert or History brings it back."
                  icon="close"
                  onClick={() => void store.removeItem(["lorebooks", `id=${book.id}`])}
                />
              </li>
            )
          })}
        </ul>
      )}
      {adding ? (
        <LorebookPicker
          title="Attach a lorebook"
          lorebooks={(library ?? []).filter((ref) => !books.some((book) => book.id === ref.id))}
          onPick={attach}
          onClose={() => setAdding(false)}
        />
      ) : (
        <div>
          <Button
            className={column ? "h-8 px-2.5" : ""}
            disabled={library === null}
            hint="Picks a book from your library for this preset to send, in every chat using it."
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" />
            Attach a lorebook
          </Button>
        </div>
      )}
    </section>
  )
}
