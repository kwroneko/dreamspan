import { Tooltip } from "../../ui/Tooltip.tsx"
// A search over the library's lorebooks, to add one to a chat or attach one to a preset.
import type { LibraryRef } from "@rp/shared/library.ts"
import { Link } from "@tanstack/react-router"
import { useId, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Input } from "../../ui/Field.tsx"

export function LorebookPicker({
  title,
  lorebooks,
  onPick,
  onClose
}: {
  /** "Add a lorebook", "Attach a lorebook". */
  title: string
  /** The books that can be picked: those not there yet. */
  lorebooks: ReadonlyArray<LibraryRef>
  onPick: (ref: LibraryRef) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const id = useId()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = lorebooks.filter((ref) =>
    words.every((word) => `${ref.label} ${ref.subtitle}`.toLowerCase().includes(word))
  )
  return (
    <section aria-label={title} className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {title}
        </label>
        <span className="flex-1" />
        <Button variant="ghost" className="h-8 px-2" hint="Closes the search; nothing is added." onClick={onClose}>
          Close
        </Button>
      </div>
      <Input
        id={id}
        type="search"
        placeholder="Search the library's lorebooks"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        autoFocus
      />
      {lorebooks.length === 0 ? (
        <p className="text-sm text-muted">
          Every lorebook in the library is here already, or there are none:{" "}
          <Tooltip label="Opens lorebook import.">
            <Link to="/library" className="text-accent hover:underline">
              import one in the library
            </Link>
          </Tooltip>
          .
        </p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted">No lorebook matches “{query}”.</p>
      ) : (
        <ul aria-label="Lorebooks to add" className="flex max-h-72 flex-col overflow-y-auto p-2">
          {shown.map((ref) => (
            <li key={ref.id}>
              <Tooltip label="Adds this lorebook to the current list.">
                <button
                  type="button"
                  className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                  onClick={() => onPick(ref)}
                >
                  <span className="font-medium">{ref.label}</span>
                  {ref.subtitle && <span className="text-xs text-muted">{ref.subtitle}</span>}
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
