// The folders as a tree beside the list, where there's room (spec/FILES-AND-ENVIRONMENT.md §8.1):
// each folder opens one level at a time, read when it's first opened; the folders down to the one
// shown are open. A click shows that folder in the list.
import { crumbsOf, FILES_TOP, isWithin, joinPath, nameOf, sortEntries } from "@dreamspan/shared/files.ts"
import { useEffect, useRef, useState } from "react"
import { Icon } from "../../ui/Icon.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { FilesSource } from "./source.ts"

type Children = ReadonlyArray<string> | "failed"

export function FolderTree({
  source,
  folder,
  onFolder,
  version
}: {
  source: FilesSource
  folder: string
  onFolder: (path: string) => void
  /** Changes when the folders may have changed: read the open ones again. */
  version: number
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(crumbsOf(folder).map((c) => c.path)))
  const [children, setChildren] = useState<ReadonlyMap<string, Children>>(new Map())
  // The folders down to the one shown open as it changes.
  const [shownFor, setShownFor] = useState(folder)
  if (shownFor !== folder) {
    setShownFor(folder)
    setOpen((before) => new Set([...before, ...crumbsOf(folder).map((c) => c.path)]))
  }
  const [readFor, setReadFor] = useState(version)
  if (readFor !== version) {
    setReadFor(version)
    setChildren(new Map())
  }

  // Reads each open folder once per version; an answer for an older version is dropped.
  const current = useRef(version)
  const asked = useRef(new Set<string>())
  useEffect(() => {
    current.current = version
  }, [version])
  useEffect(() => {
    const at = version
    const wanted = [...open].filter((path) => !children.has(path) && !asked.current.has(`${at}\0${path}`))
    const settle = (path: string, value: Children) => {
      if (current.current === at) setChildren((before) => new Map(before).set(path, value))
    }
    for (const path of wanted) asked.current.add(`${at}\0${path}`)
    for (const path of wanted)
      source.list(path).then(
        (listing) =>
          settle(
            path,
            sortEntries(listing.entries, "name")
              .filter((e) => e.kind === "folder")
              .map((e) => joinPath(path, e.name))
          ),
        () => settle(path, "failed")
      )
  }, [open, children, source, version])

  const toggle = (path: string) =>
    setOpen((before) => {
      const next = new Set(before)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const branch = (path: string, depth: number) => {
    const isOpen = open.has(path)
    const kids = children.get(path)
    const shown = path === folder
    return (
      <li key={path} role="treeitem" aria-expanded={isOpen} aria-selected={shown}>
        <div className="flex min-w-0 items-center" style={{ paddingLeft: `${depth * 0.75}rem` }}>
          <Tooltip label={isOpen ? `Hides the folders in ${nameOf(path)}.` : `Shows the folders in ${nameOf(path)}.`}>
            <button
              type="button"
              aria-label={`${isOpen ? "Collapse" : "Expand"} ${nameOf(path)}`}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
              onClick={() => toggle(path)}
            >
              <Icon name={isOpen ? "down" : "right"} size={14} />
            </button>
          </Tooltip>
          <button
            type="button"
            aria-current={shown || undefined}
            title={path}
            className={`flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded px-1 text-left text-sm outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus ${
              shown ? "bg-hover font-medium" : isWithin(folder, path) ? "" : "text-muted"
            }`}
            onClick={() => onFolder(path)}
          >
            <Icon name="folder" size={14} className="text-muted" />
            <span className="truncate">{nameOf(path)}</span>
          </button>
        </div>
        {isOpen && (
          <ul role="group">
            {kids === undefined ? (
              <li className="py-1 text-xs text-muted" style={{ paddingLeft: `${(depth + 1) * 0.75 + 1.75}rem` }}>
                Loading…
              </li>
            ) : kids === "failed" ? (
              <li className="py-1 text-xs text-danger" style={{ paddingLeft: `${(depth + 1) * 0.75 + 1.75}rem` }}>
                Couldn’t be read
              </li>
            ) : (
              kids.map((child) => branch(child, depth + 1))
            )}
          </ul>
        )}
      </li>
    )
  }

  return (
    <ul role="tree" aria-label="Folders" className="flex min-w-0 flex-col rounded-md border border-border p-2">
      {branch(FILES_TOP, 0)}
    </ul>
  )
}
