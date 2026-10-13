// The import page's folder browser (ARCHITECTURE.md §13): the folders where the app runs,
// from the home folder or a folder the page names, opened by clicking. Opening one fills
// the path field; folders that look like ST's are marked.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Forbidden } from "@rp/shared/errors.ts"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useMemo, useState } from "react"
import { FailureView } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Spinner } from "../../ui/Spinner.tsx"
import { Badge } from "../../ui/Surface.tsx"

const row =
  "flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"

const FolderIcon = () => (
  <svg aria-hidden viewBox="0 0 16 16" className="size-4 shrink-0 text-muted" fill="currentColor">
    <path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3.4l1.5 1.5H13A1.5 1.5 0 0 1 14.5 4.5v8A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z" />
  </svg>
)

/** Remount it (`key`) to start somewhere else. */
export function FolderBrowser({
  start,
  disabled,
  onOpen
}: {
  /** The folder shown first; null is the home folder. */
  start: string | null
  disabled: boolean
  /** A folder was opened by a click: its full path. Loading never fills the field, so typing isn't overwritten. */
  onOpen: (path: string) => void
}) {
  const [shown, setShown] = useState(start)
  const atom = useMemo(() => AppClient.query("ListFolder", { path: shown }), [shown])
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  const open = (path: string) => {
    setShown(path)
    onOpen(path)
  }

  return AsyncResult.match(result, {
    onInitial: () => <Spinner />,
    // Not an admin: browsing isn't theirs, and the path field says so when used.
    onFailure: (failure) =>
      Cause.squash(failure.cause) instanceof Forbidden ? null : <FailureView cause={failure.cause} onRetry={refresh} />,
    onSuccess: ({ value: listing, waiting }) => (
      <nav
        aria-label="Folders"
        className="flex max-h-72 flex-col overflow-y-auto rounded-md border border-border bg-canvas p-1"
      >
        {listing.parent !== null && (
          <button
            type="button"
            className={`${row} text-muted`}
            disabled={disabled || waiting}
            onClick={() => open(listing.parent!)}
          >
            <span aria-hidden>↑</span>
            <span className="min-w-0 truncate">Up to {listing.parent}</span>
          </button>
        )}
        {listing.folders.map((folder) => (
          <button
            key={folder.name}
            type="button"
            className={row}
            disabled={disabled || waiting}
            onClick={() => open(`${listing.path === "/" ? "" : listing.path}/${folder.name}`)}
          >
            <FolderIcon />
            <span className="min-w-0 truncate">{folder.name}</span>
            {folder.st && <Badge tone="success">SillyTavern</Badge>}
          </button>
        ))}
        {listing.folders.length === 0 && <p className="px-2 py-1.5 text-sm text-muted">No folders in here.</p>}
        {listing.truncated && <p className="px-2 py-1.5 text-sm text-muted">More folders aren't listed.</p>}
      </nav>
    )
  })
}
