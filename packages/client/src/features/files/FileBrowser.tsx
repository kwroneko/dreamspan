// The file manager (spec/FILES-AND-ENVIRONMENT.md §8.1): one component for the workshop's Files
// tab, a workbench tab and a phone's sheet (memory: side-panel editors are the mobile editors, with
// full parity). A breadcrumb with the full path and Copy path; folders first, sorted by name, size
// or date; per-row ⋯ menus and the same actions on a right click or a long press; upload of files
// and folders by the pickers or a drop; new folder, rename, delete, download, copy path; the
// working folder's mark and Set as working folder where the chat has one. A folder tree joins the
// list once the component is wide enough (a page, a wide panel). Opening a file shows it in place.
import { formatByteSize } from "@rp/shared/byteSize.ts"
import { formatMoment } from "@rp/shared/branchNaming.ts"
import {
  crumbsOf,
  isTop,
  joinPath,
  keepBothName,
  nameOf,
  nameProblem,
  parentOf,
  sortEntries,
  type FileEntry,
  type FileSort,
  type FolderListing
} from "@rp/shared/files.ts"
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react"
import type { FilesUsage } from "@rp/shared/filesQuotaApi.ts"
import { useAction } from "../../actions.tsx"
import { copyText } from "../../copyText.ts"
import { isAppDrag } from "../../ui/appDrags.ts"
import { Button } from "../../ui/Button.tsx"
import { ConfirmDialog, Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { ContextMenu, Menu, MenuItem, MenuRadioGroup, MenuSeparator } from "../../ui/Menu.tsx"
import { ProgressBar } from "../../ui/Spinner.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { FolderTree } from "./FolderTree.tsx"
import type { FilesSource } from "./source.ts"
import {
  batchSize,
  carriesFiles,
  itemsFromDrop,
  itemsFromInput,
  uploadAll,
  type ConflictAnswer,
  type UploadItem
} from "./upload.ts"
import { freeBytes, noRoomMessage, roomProblem, usageLine } from "./usage.ts"
import { NoViewer, viewerFor } from "./viewers.tsx"

/** The chat's working folder on its branch (§2.1), and how to change it where that's offered. */
export interface WorkingFolder {
  readonly path: string
  readonly set?: ((path: string) => Promise<void>) | undefined
}

export interface FileBrowserProps {
  readonly source: FilesSource
  /** The folder shown. */
  readonly folder: string
  readonly onFolder: (path: string) => void
  /** The name of the file open in it, or null for the list. */
  readonly opened: string | null
  readonly onOpened: (name: string | null) => void
  readonly working?: WorkingFolder | null | undefined
  /** A link to this folder or file as a tab of its own, where it isn't one already. */
  readonly tabHref?: ((folder: string, file: string | null) => string) | undefined
  readonly onOpenTab?: ((folder: string, file: string | null) => void) | undefined
}

type Loaded =
  { readonly for: string; readonly listing: FolderListing } | { readonly for: string; readonly error: string }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const SORTS: ReadonlyArray<{ value: FileSort; label: string; description: string }> = [
  { value: "name", label: "Name", description: "Folders first, then by name." },
  { value: "size", label: "Size", description: "Folders first, then the largest files first." },
  { value: "date", label: "Date", description: "Folders first, then the most recently changed first." }
]

const copyPath = async (path: string) => {
  try {
    await copyText(path)
    showToast({ title: "Path copied", description: path })
  } catch {
    showToast({ title: "Couldn't copy the path", description: "The browser didn't allow it." })
  }
}

const download = (source: FilesSource, path: string) => {
  const link = document.createElement("a")
  link.href = source.rawUrl(path, true)
  link.download = nameOf(path)
  link.rel = "noopener"
  document.body.append(link)
  link.click()
  link.remove()
}

export function FileBrowser(props: FileBrowserProps) {
  const { source, folder, onFolder, opened, onOpened, working } = props
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [version, setVersion] = useState(0)
  const [sort, setSort] = useState<FileSort>("name")
  const [renaming, setRenaming] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState<FileEntry | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [conflict, setConflict] = useState<((answer: ConflictAnswer | null) => void) | null>(null)
  const [dropping, setDropping] = useState(false)
  const [treeVersion, setTreeVersion] = useState(0)
  const filesInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  const [usage, setUsage] = useState<FilesUsage | null>(null)
  const usageAction = useAction()
  // Its registry and state setters are stable, so the first render's run serves throughout.
  const usageRun = useRef(usageAction.run)
  /**
   * Reads the account's usage: the server's last measurement plus what its own writes and
   * deletes changed since, so a refresh doesn't walk the whole folder. Null when it couldn't say.
   */
  const readUsage = useCallback(async () => {
    const result = await usageRun.current((client) => client("GetFilesUsage", { fresh: false }))
    if (!result.ok) return null
    setUsage(result.value)
    return result.value
  }, [])

  const reload = useCallback(() => {
    setVersion((v) => v + 1)
    setTreeVersion((v) => v + 1)
  }, [])

  useEffect(() => {
    let live = true
    source.list(folder).then(
      (listing) => live && setLoaded({ for: folder, listing }),
      (error: unknown) => live && setLoaded({ for: folder, error: message(error) })
    )
    return () => {
      live = false
    }
  }, [source, folder, version])

  useEffect(() => {
    void readUsage()
  }, [readUsage, version])

  const current = loaded?.for === folder ? loaded : null
  const listing = current && "listing" in current ? current.listing : null
  const readOnly = listing?.readOnly ?? false
  const names = new Set(listing?.entries.map((e) => e.name) ?? [])

  /** Runs a change, says what failed, and reads the folder again. */
  const change = async <A,>(run: () => Promise<A>, failed: string): Promise<A | null> => {
    setBusy(true)
    setFailure(null)
    try {
      return await run()
    } catch (error) {
      setFailure(`${failed}: ${message(error)}`)
      return null
    } finally {
      setBusy(false)
      reload()
    }
  }

  const rename = async (entry: FileEntry, next: string) => {
    const problem = nameProblem(next)
    if (problem) return setFailure(problem)
    if (next === entry.name) return setRenaming(null)
    if (names.has(next)) return setFailure(`“${next}” is taken here. Choose another name.`)
    const from = joinPath(folder, entry.name)
    const to = joinPath(folder, next)
    const done = await change(() => source.move(from, to), `“${entry.name}” wasn't renamed`)
    if (!done) return
    setRenaming(null)
    if (opened === entry.name) onOpened(next)
    showToast({
      title: `Renamed to “${next}”`,
      actions: [
        {
          label: "Undo",
          hint: `Gives it back its name, “${entry.name}”.`,
          onClick: () => void change(() => source.move(to, from), "The rename wasn't undone")
        }
      ]
    })
  }

  const createFolder = async (name: string) => {
    const problem = nameProblem(name)
    if (problem) return setFailure(problem)
    if (names.has(name)) return setFailure(`“${name}” is taken here. Choose another name.`)
    const path = joinPath(folder, name)
    const done = await change(() => source.createFolder(path), "The folder wasn't made")
    if (!done) return
    setCreating(false)
    showToast({
      title: `Made the folder “${name}”`,
      actions: [
        {
          label: "Undo",
          hint: "Deletes the new folder.",
          onClick: () => void change(() => source.remove(path), "The folder wasn't taken back")
        }
      ]
    })
  }

  const remove = async (entry: FileEntry) => {
    const path = joinPath(folder, entry.name)
    const done = await change(() => source.remove(path), `“${entry.name}” wasn't deleted`)
    setConfirm(null)
    if (!done) return
    if (opened === entry.name) onOpened(null)
    const binItemId = done.binItemId
    showToast({
      title: `Deleted “${entry.name}”`,
      ...(binItemId === null
        ? {}
        : {
            description: "It's in the bin.",
            actions: [
              {
                label: "Undo",
                hint: "Puts it back where it was.",
                onClick: () => void change(() => source.restore(binItemId), `“${entry.name}” wasn't put back`)
              }
            ]
          })
    })
  }

  const askDelete = (entry: FileEntry) => {
    if (listing?.bin) void remove(entry)
    else setConfirm(entry)
  }

  const upload = async (items: ReadonlyArray<UploadItem>) => {
    if (items.length === 0 || readOnly) return
    const before = new Set(names)
    setFailure(null)
    const size = batchSize(items)
    const now = await readUsage()
    const problem = now && roomProblem(size.bytes, size.files, now)
    if (problem) return setFailure(problem)
    setProgress({ done: 0, total: 1 })
    const report = await uploadAll(
      source,
      folder,
      items,
      () => new Promise<ConflictAnswer | null>((resolve) => setConflict(() => resolve)),
      (done, total) => setProgress({ done, total: Math.max(total, 1) })
    )
    setProgress(null)
    reload()
    if (report.noRoom) {
      const after = await readUsage()
      setFailure(
        after
          ? noRoomMessage(report.noRoom.bytes, freeBytes(after), report.noRoom.files)
          : "There's no room left for these files."
      )
    }
    const added = report.made.filter((path) => !before.has(nameOf(path)))
    const count = report.written.length
    if (report.failed.length > 0)
      setFailure(
        `${report.failed.length === 1 ? "1 item wasn't" : `${report.failed.length} items weren't`} uploaded: ${report.failed
          .slice(0, 3)
          .map((f) => `${f.relative} (${f.message})`)
          .join("; ")}`
      )
    if (count > 0 || report.skipped > 0)
      showToast({
        title: count === 1 ? "Uploaded 1 file" : `Uploaded ${count} files`,
        ...(report.skipped > 0 ? { description: `Skipped ${report.skipped} with taken names.` } : {}),
        actions:
          added.length > 0
            ? [
                {
                  label: "Undo",
                  hint: "Deletes what this upload added. Files it replaced stay as they are now.",
                  onClick: () =>
                    void change(async () => {
                      for (const path of added) await source.remove(path)
                    }, "The upload wasn't taken back")
                }
              ]
            : []
      })
  }

  const onDrag = (event: DragEvent<HTMLElement>) => {
    if (readOnly || !carriesFiles(event.dataTransfer) || isAppDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    if (!dropping) setDropping(true)
  }
  const onDrop = (event: DragEvent<HTMLElement>) => {
    setDropping(false)
    if (readOnly || !carriesFiles(event.dataTransfer) || isAppDrag(event.dataTransfer)) return
    event.preventDefault()
    void itemsFromDrop(event.dataTransfer).then(upload, (error: unknown) =>
      setFailure(`The drop couldn't be read: ${message(error)}`)
    )
  }

  const entry = opened === null ? null : (listing?.entries.find((e) => e.name === opened) ?? null)
  const folderName = nameOf(folder)
  const isWorking = working?.path === folder

  return (
    <div
      data-files-browser=""
      className="@container relative flex min-w-0 flex-col gap-3"
      onDragEnter={onDrag}
      onDragOver={onDrag}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={onDrop}
    >
      <PathBar folder={folder} file={opened} onFolder={onFolder} onOpened={onOpened} />
      <div className="flex flex-wrap items-center gap-2 empty:hidden">
        {isWorking ? (
          <Tooltip label="The assistant's commands start in this folder. It can still reach all your files.">
            <span tabIndex={0} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <Badge tone="accent">Working here</Badge>
            </span>
          </Tooltip>
        ) : (
          working?.set && (
            <Button
              variant="ghost"
              hint="Makes this the folder the assistant's commands start in, on this branch. It can still reach all your files."
              disabled={busy}
              onClick={() => void change(() => working.set!(folder), "The working folder wasn't changed")}
            >
              Set as working folder
            </Button>
          )
        )}
      </div>

      {opened !== null ? (
        <OpenedFile
          source={source}
          folder={folder}
          name={opened}
          entry={entry}
          loading={current === null}
          onClose={() => onOpened(null)}
          tab={props.onOpenTab ? () => props.onOpenTab!(folder, opened) : undefined}
          tabHref={props.tabHref?.(folder, opened)}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Files actions">
            <Button
              hint={`Uploads files from this device into “${folderName}”. You can also drop files and folders here.`}
              disabled={readOnly || progress !== null}
              onClick={() => filesInput.current?.click()}
            >
              <Icon name="upload" />
              Upload files
            </Button>
            <Button
              hint={`Uploads a folder from this device into “${folderName}”, with its subfolders.`}
              disabled={readOnly || progress !== null}
              onClick={() => folderInput.current?.click()}
            >
              <Icon name="folder" />
              Upload folder
            </Button>
            <Button
              hint={`Makes an empty folder in “${folderName}”.`}
              disabled={readOnly || busy}
              onClick={() => {
                setCreating(true)
                setFailure(null)
              }}
            >
              <Icon name="plus" />
              New folder
            </Button>
            <Menu
              label="Sort by"
              hint="How the list is ordered. Folders always come first."
              trigger={
                <button
                  type="button"
                  className="inline-flex h-9 items-center gap-1 rounded-md px-2 text-sm text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <Icon name="sortDown" />
                  {SORTS.find((s) => s.value === sort)!.label}
                </button>
              }
            >
              <MenuRadioGroup value={sort} onValueChange={setSort} items={SORTS} />
            </Menu>
            <IconButton
              icon="regenerate"
              label="Refresh"
              hint="Reads this folder again, for changes made elsewhere: by the assistant's commands, say."
              onClick={reload}
            />
            <input
              ref={filesInput}
              type="file"
              multiple
              hidden
              aria-label="Files to upload"
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])]
                event.currentTarget.value = ""
                void upload(itemsFromInput(files))
              }}
            />
            <input
              ref={folderInput}
              type="file"
              hidden
              aria-label="Folder to upload"
              {...{ webkitdirectory: "", directory: "" }}
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])]
                event.currentTarget.value = ""
                void upload(itemsFromInput(files))
              }}
            />
          </div>
          {usage && <UsageLine usage={usage} />}
          {readOnly && (
            <p className="text-sm text-muted">Shared with you to view: you can open and download, not change.</p>
          )}
          {progress !== null && (
            <ProgressBar label="Uploading" value={progress.done} max={progress.total} className="h-1.5" />
          )}
          <div className="grid min-w-0 gap-3 @3xl:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)]">
            <nav aria-label="Folders" className="hidden min-w-0 @3xl:block">
              <FolderTree source={source} folder={folder} onFolder={onFolder} version={treeVersion} />
            </nav>
            <div className="flex min-w-0 flex-col gap-1">
              {creating && (
                <NameForm
                  label="Name of the new folder"
                  initial={names.has("New folder") ? keepBothName("New folder", names) : "New folder"}
                  fresh={false}
                  saveLabel="Make folder"
                  saveHint="Makes the folder with this name."
                  pending={busy}
                  onSave={(name) => void createFolder(name)}
                  onCancel={() => setCreating(false)}
                />
              )}
              {current === null ? (
                <p role="status" className="text-sm text-muted">
                  Loading {folderName}…
                </p>
              ) : "error" in current ? (
                <div className="flex flex-col items-start gap-2">
                  <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">
                    {folderName} couldn’t be read: {current.error}
                  </p>
                  {!isTop(folder) && (
                    <Button hint="Shows the folder that holds this one." onClick={() => onFolder(parentOf(folder))}>
                      Up a folder
                    </Button>
                  )}
                </div>
              ) : current.listing.entries.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
                  {isTop(folder) ? "No files yet." : "This folder is empty."}{" "}
                  {readOnly ? "" : "Upload files or drop them here."}
                </p>
              ) : (
                <ul aria-label={`In ${folderName}`} className="flex min-w-0 flex-col" data-files-list="">
                  {sortEntries(current.listing.entries, sort).map((item) => (
                    <EntryRow
                      key={item.name}
                      entry={item}
                      folder={folder}
                      readOnly={readOnly}
                      busy={busy}
                      working={working}
                      renaming={renaming === item.name}
                      onOpen={() =>
                        item.kind === "folder" ? onFolder(joinPath(folder, item.name)) : onOpened(item.name)
                      }
                      onRename={() => {
                        setFailure(null)
                        setRenaming(item.name)
                      }}
                      onRenamed={(next) => void rename(item, next)}
                      onCancelRename={() => setRenaming(null)}
                      onDelete={() => askDelete(item)}
                      onDownload={() => download(source, joinPath(folder, item.name))}
                      onWorking={(path) => void change(() => working!.set!(path), "The working folder wasn't changed")}
                    />
                  ))}
                </ul>
              )}
              {current && "listing" in current && current.listing.more && (
                <p className="text-sm text-muted">More is in this folder than can be listed here.</p>
              )}
            </div>
          </div>
        </>
      )}
      {failure && (
        <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">
          {failure}
        </p>
      )}
      {dropping && (
        <div
          aria-hidden="true"
          data-layout-overlay="The drop target covers the file list while files are dragged over it"
          className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md border-2 border-dashed border-accent bg-surface/90 text-sm font-medium"
        >
          Drop to upload into “{folderName}”
        </div>
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Delete “${confirm?.name ?? ""}”?`}
        description={
          confirm?.kind === "folder"
            ? "The folder and everything in it will be gone. This can't be undone."
            : "The file will be gone. This can't be undone."
        }
        confirmLabel="Delete"
        confirmHint="Deletes it for good."
        pending={busy}
        onConfirm={() => confirm && void remove(confirm)}
      />
      <ConflictDialog
        open={conflict !== null}
        onAnswer={(answer) => {
          conflict?.(answer)
          setConflict(null)
        }}
      />
    </div>
  )
}

/** The full path as a breadcrumb: each folder opens, the last is where you are; Copy path beside it. */
function PathBar({
  folder,
  file,
  onFolder,
  onOpened
}: {
  folder: string
  file: string | null
  onFolder: (path: string) => void
  onOpened: (name: string | null) => void
}) {
  const crumbs = crumbsOf(folder)
  const full = file === null ? folder : joinPath(folder, file)
  return (
    <div className="flex min-w-0 items-start gap-1">
      <nav aria-label="Path" className="min-w-0 flex-1">
        <ol className="flex min-w-0 flex-wrap items-center gap-x-0.5 text-sm" data-files-path={full}>
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1 && file === null
            return (
              <li key={crumb.path} className="flex min-w-0 items-center gap-0.5">
                {i > 0 && (
                  <span aria-hidden="true" className="text-muted">
                    /
                  </span>
                )}
                {last ? (
                  <span aria-current="page" className="min-w-0 truncate px-1 py-1 font-medium">
                    {crumb.name}
                  </span>
                ) : (
                  <Tooltip label={`Shows ${crumb.path}`}>
                    <button
                      type="button"
                      className="min-w-0 truncate rounded px-1 py-1 text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
                      onClick={() => {
                        onOpened(null)
                        onFolder(crumb.path)
                      }}
                    >
                      {crumb.name}
                    </button>
                  </Tooltip>
                )}
              </li>
            )
          })}
          {file !== null && (
            <li className="flex min-w-0 items-center gap-0.5">
              <span aria-hidden="true" className="text-muted">
                /
              </span>
              <span aria-current="page" className="min-w-0 truncate px-1 py-1 font-medium [overflow-wrap:anywhere]">
                {file}
              </span>
            </li>
          )}
        </ol>
      </nav>
      <IconButton
        icon="copy"
        label="Copy path"
        hint={`Copies ${full}, the path the assistant's tools use for it.`}
        onClick={() => void copyPath(full)}
      />
    </div>
  )
}

function EntryRow({
  entry,
  folder,
  readOnly,
  busy,
  working,
  renaming,
  onOpen,
  onRename,
  onRenamed,
  onCancelRename,
  onDelete,
  onDownload,
  onWorking
}: {
  entry: FileEntry
  folder: string
  readOnly: boolean
  busy: boolean
  working: WorkingFolder | null | undefined
  renaming: boolean
  onOpen: () => void
  onRename: () => void
  onRenamed: (next: string) => void
  onCancelRename: () => void
  onDelete: () => void
  onDownload: () => void
  onWorking: (path: string) => void
}) {
  const [menu, setMenu] = useState(false)
  const path = joinPath(folder, entry.name)
  const opens = entry.kind === "file" || entry.kind === "folder"
  const kindText =
    entry.kind === "folder"
      ? "Folder"
      : entry.kind === "file"
        ? formatByteSize(entry.size)
        : entry.kind === "link"
          ? "Link: the app doesn't follow links"
          : "Special file: the app doesn't open it"
  const isWorking = working?.path === path
  if (renaming)
    return (
      <li className="py-1">
        <NameForm
          label={`New name for ${entry.name}`}
          initial={entry.name}
          fresh
          saveLabel="Rename"
          saveHint="Saves the new name."
          pending={busy}
          onSave={onRenamed}
          onCancel={onCancelRename}
        />
      </li>
    )
  // The same actions in the ⋯ menu and the row's context menu (memory: visible affordances).
  const items = (
    <>
      {opens && (
        <MenuItem
          description={entry.kind === "folder" ? "Shows what's in this folder." : "Shows the file here."}
          onClick={onOpen}
        >
          Open
        </MenuItem>
      )}
      {entry.kind === "file" && (
        <MenuItem description="Saves a copy on this device." onClick={onDownload}>
          Download
        </MenuItem>
      )}
      <MenuItem
        description={`Copies ${path}, the path the assistant's tools use for it.`}
        onClick={() => void copyPath(path)}
      >
        Copy path
      </MenuItem>
      {entry.kind === "folder" && working?.set && !isWorking && (
        <MenuItem
          description="Makes this the folder the assistant's commands start in, on this branch."
          disabled={busy}
          onClick={() => onWorking(path)}
        >
          Set as working folder
        </MenuItem>
      )}
      {!readOnly && (
        <>
          <MenuSeparator />
          <MenuItem description="Gives it another name in this folder." disabled={busy} onClick={onRename}>
            Rename
          </MenuItem>
          <MenuItem tone="danger" description="Deletes it." disabled={busy} onClick={onDelete}>
            Delete
          </MenuItem>
        </>
      )}
    </>
  )
  return (
    <li
      className="group flex min-w-0 items-center gap-1 rounded-md hover:bg-hover"
      data-file-row={entry.name}
      data-file-kind={entry.kind}
    >
      <ContextMenu
        label={`Actions for ${entry.name}`}
        open={menu}
        onOpenChange={setMenu}
        trigger={
          <button
            type="button"
            disabled={!opens}
            aria-label={`${entry.name}, ${kindText}`}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-default"
            onClick={onOpen}
          >
            <Icon
              name={entry.kind === "folder" ? "folder" : entry.kind === "file" ? "file" : "link"}
              className="text-muted"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">{entry.name}</span>
              <span className="truncate text-xs text-muted tabular-nums">
                {kindText}
                {entry.mtimeMs > 0 ? ` · ${formatMoment(entry.mtimeMs)}` : ""}
              </span>
            </span>
            {isWorking && <Badge tone="accent">Working here</Badge>}
          </button>
        }
      >
        {items}
      </ContextMenu>
      <Menu
        label={`Actions for ${entry.name}`}
        hint={`Actions for ${entry.name}`}
        trigger={
          <button
            type="button"
            aria-label={`Actions for ${entry.name}`}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-focus data-popup-open:bg-surface"
          >
            <Icon name="more" />
          </button>
        }
      >
        {items}
      </Menu>
    </li>
  )
}

/** A name being typed: a new folder's, or a rename. Enter saves, Escape cancels; both are buttons too. */
function NameForm({
  label,
  initial,
  fresh,
  saveLabel,
  saveHint,
  pending,
  onSave,
  onCancel
}: {
  label: string
  initial: string
  fresh: boolean
  saveLabel: string
  saveHint: string
  pending: boolean
  onSave: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const input = field.current
    if (!input) return
    input.focus()
    // The name without its extension, as file managers select it.
    const dot = initial.lastIndexOf(".")
    input.setSelectionRange(0, fresh && dot > 0 ? dot : initial.length)
  }, [initial, fresh])
  return (
    <form
      className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(value.trim())
      }}
    >
      <Input
        ref={field}
        aria-label={label}
        value={value}
        className="min-w-0 flex-1 basis-40"
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            onCancel()
          }
        }}
      />
      <Button type="submit" variant="primary" hint={saveHint} pending={pending}>
        {saveLabel}
      </Button>
      <Button hint="Leaves it as it was." onClick={onCancel}>
        Cancel
      </Button>
    </form>
  )
}

/** An open file: its viewer, or what it is and Download; Back to the folder. */
function OpenedFile({
  source,
  folder,
  name,
  entry,
  loading,
  onClose,
  tab,
  tabHref
}: {
  source: FilesSource
  folder: string
  name: string
  entry: FileEntry | null
  loading: boolean
  onClose: () => void
  tab: (() => void) | undefined
  tabHref: string | undefined
}) {
  const path = joinPath(folder, name)
  const Viewer = viewerFor(name)?.component
  let body: ReactNode
  if (loading)
    body = (
      <p role="status" className="text-sm text-muted">
        Loading {name}…
      </p>
    )
  else if (entry === null || entry.kind !== "file")
    body = (
      <p role="alert" className="text-sm text-danger">
        {name} isn’t in this folder any more. It may have been renamed, moved or deleted.
      </p>
    )
  else if (Viewer) body = <Viewer path={path} name={name} size={entry.size} source={source} />
  else body = <NoViewer name={name} size={entry.size} />
  return (
    <section aria-label={name} className="flex min-w-0 flex-col gap-2" data-file-open={path}>
      <div className="flex flex-wrap items-center gap-2">
        <Button hint={`Back to the list of “${nameOf(folder)}”.`} onClick={onClose}>
          <Icon name="back" />
          Back
        </Button>
        {entry?.kind === "file" && (
          <Button hint="Saves a copy on this device." onClick={() => download(source, path)}>
            <Icon name="download" />
            Download
          </Button>
        )}
        {tab && (
          <Button
            variant="ghost"
            hint="Opens this file in a tab of its own, beside the chat."
            onClick={tab}
            {...(tabHref ? { "data-href": tabHref } : {})}
          >
            Open as a tab
          </Button>
        )}
      </div>
      {body}
    </section>
  )
}

function ConflictDialog({ open, onAnswer }: { open: boolean; onAnswer: (answer: ConflictAnswer | null) => void }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onAnswer(null)}
      title="A name is taken"
      description="Some of what you're uploading has the same name as something already here. What should happen to each of them?"
    >
      <DialogActions>
        <Button hint="Stops the upload here. What's uploaded so far stays." onClick={() => onAnswer(null)}>
          Stop
        </Button>
        <Button hint="Leaves what's here as it is and doesn't upload those." onClick={() => onAnswer("skip")}>
          Skip
        </Button>
        <Button hint="Uploads them over what's here." onClick={() => onAnswer("replace")}>
          Replace
        </Button>
        <Button
          variant="primary"
          hint="Uploads them with a number added: “report (2).pdf”."
          onClick={() => onAnswer("keep")}
        >
          Keep both
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** "1.2 GB of 10 GB used", warning-styled when near or over the quota. */
function UsageLine({ usage }: { usage: FilesUsage }) {
  const line = usageLine(usage)
  return (
    <Tooltip
      label={
        usage.over
          ? "Your files are over their storage limit. Delete files you don't need to upload or change files again."
          : "How much of your storage your files use, with their earlier versions and the assistant's home folder."
      }
    >
      <p
        tabIndex={0}
        data-files-usage=""
        data-warn={line.warn ? "" : undefined}
        className={`w-fit rounded-md text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus ${line.warn ? "text-warning" : "text-muted"}`}
      >
        {line.text}
      </p>
    </Tooltip>
  )
}
