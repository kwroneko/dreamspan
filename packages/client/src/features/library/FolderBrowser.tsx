// The import page's folder browser (ARCHITECTURE.md §13): the folders where the app runs,
// from the home folder or a folder the page names (the last one used), opened by clicking. Opening one fills
// the path field; folders that look like ST's are marked. With `kind="host"` it browses the
// folders on the server an admin may work in (HOST_FOLDERS, spec/FILES-AND-ENVIRONMENT.md §3.7),
// from the list of those folders.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Forbidden } from "@dreamspan/shared/errors.ts"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useMemo, useState } from "react"
import { FailureView } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"

const row =
  "flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"

const FolderIcon = () => (
  <svg aria-hidden viewBox="0 0 16 16" className="size-4 shrink-0 text-muted" fill="currentColor">
    <path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3.4l1.5 1.5H13A1.5 1.5 0 0 1 14.5 4.5v8A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z" />
  </svg>
)

interface Listing {
  readonly path: string | null
  /** "" goes back to the list of allowed folders (host). */
  readonly parent: string | null
  readonly folders: ReadonlyArray<{ readonly name: string; readonly path?: string; readonly st?: boolean }>
  readonly truncated: boolean
}

const importAtom = (path: string | null) => AppClient.query("ListFolder", { path })
const hostAtom = (path: string | null) => AppClient.query("ListHostFolders", { path })

/** Remount it (`key`) to start somewhere else. */
export function FolderBrowser({
  start,
  disabled,
  onOpen,
  kind = "import"
}: {
  /** The folder shown first; null is the home folder (host: the list of allowed folders). */
  start: string | null
  disabled: boolean
  /** A folder was opened by a click: its full path. Loading never fills the field, so typing isn't overwritten. */
  onOpen: (path: string) => void
  kind?: "import" | "host"
}) {
  const [shown, setShown] = useState(start)
  // Both answer a Listing; the import one's folders also say whether they look like ST's.
  const atom = useMemo(
    () => (kind === "host" ? (hostAtom(shown) as unknown as ReturnType<typeof importAtom>) : importAtom(shown)),
    [kind, shown]
  )
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  const open = (path: string) => {
    // Host: "" is the list of allowed folders, not a folder.
    setShown(path === "" ? null : path)
    if (path !== "") onOpen(path)
  }

  return AsyncResult.match(result, {
    onInitial: () => <Spinner />,
    // Not an admin: browsing isn't theirs, and the path field says so when used.
    onFailure: (failure) =>
      Cause.squash(failure.cause) instanceof Forbidden ? null : (
        <div className="flex flex-col gap-2">
          <FailureView cause={failure.cause} onRetry={refresh} />
          {/* The folder it started at may be gone since: the home folder still is. */}
          {shown !== null && (
            <Button
              variant="ghost"
              className="self-start"
              hint={kind === "host" ? "Lists the folders you may use." : "Opens the home folder."}
              onClick={() => setShown(null)}
            >
              {kind === "host" ? "Back to the server's folders" : "Go to the home folder"}
            </Button>
          )}
        </div>
      ),
    onSuccess: ({ value, waiting }) => {
      const listing = value as Listing
      return (
        <nav
          aria-label="Folders"
          className="flex max-h-72 flex-col overflow-y-auto rounded-md border border-border bg-canvas p-2"
        >
          {listing.parent !== null && (
            <Tooltip label={listing.parent === "" ? "Lists the folders you may use." : "Opens the parent folder."}>
              <button
                type="button"
                className={`${row} text-muted`}
                disabled={disabled || waiting}
                onClick={() => open(listing.parent!)}
              >
                <span aria-hidden>↑</span>
                <span className="min-w-0 truncate">
                  {listing.parent === "" ? "Back to the server's folders" : `Up to ${listing.parent}`}
                </span>
              </button>
            </Tooltip>
          )}
          {listing.folders.map((folder) => (
            <Tooltip
              key={folder.name}
              label={kind === "host" ? `Opens ${folder.name}.` : `Opens ${folder.name} and fills the folder path.`}
            >
              <button
                type="button"
                className={row}
                disabled={disabled || waiting}
                onClick={() => open(folder.path ?? `${listing.path === "/" ? "" : listing.path}/${folder.name}`)}
              >
                <FolderIcon />
                <span data-layout-name className="min-w-0 truncate">
                  {folder.name}
                </span>
                {folder.st && <Badge tone="success">SillyTavern</Badge>}
              </button>
            </Tooltip>
          ))}
          {listing.folders.length === 0 && <p className="px-2 py-1.5 text-sm text-muted">No folders in here.</p>}
          {listing.truncated && <p className="px-2 py-1.5 text-sm text-muted">More folders aren't listed.</p>}
        </nav>
      )
    }
  })
}
