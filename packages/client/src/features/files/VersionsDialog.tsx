// Versions (spec/FILES-AND-ENVIRONMENT.md §1.3): a file's earlier contents, newest first, each with
// when, what replaced it and who, when it wasn't you; Restore puts one back. What was there is kept
// as a version first, so the toast's Undo restores that.
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import { formatMoment } from "@dreamspan/shared/branchNaming.ts"
import type { FileVersionEntry } from "@dreamspan/shared/files.ts"
import { useEffect, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { showToast } from "../../ui/Toast.tsx"
import type { FilesSource } from "./source.ts"

/** What a version is, by what replaced it (the content a command left is the exception). */
const versionLabel = (version: FileVersionEntry) => {
  const label =
    {
      upload: "Before an upload",
      editor: "Before a save",
      agent: "Before the assistant's edit",
      command: "After a command",
      restore: "Before a restore",
      delete: "Before it was deleted"
    }[version.origin] ?? "Earlier"
  return version.actor ? `${label} by ${version.actor.displayName}` : label
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function VersionsDialog({
  source,
  path,
  name,
  onClose
}: {
  source: FilesSource
  /** The file; null: closed. */
  path: string | null
  name: string
  onClose: () => void
}) {
  const [versions, setVersions] = useState<{ for: string; list: ReadonlyArray<FileVersionEntry> } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (path === null || !source.versions) return
    let live = true
    source.versions(path).then(
      (list) => live && setVersions({ for: path, list }),
      (error: unknown) => live && setFailure(message(error))
    )
    return () => {
      live = false
    }
  }, [path, source, reload])
  const list = versions?.for === path ? versions.list : null

  const restore = async (version: FileVersionEntry) => {
    if (path === null) return
    setBusy(version.id)
    setFailure(null)
    try {
      const restored = await source.restoreVersion!(path, version.id)
      setReload((n) => n + 1)
      const kept = restored.keptVersionId
      showToast({
        title: `Restored “${name}” from ${formatMoment(version.createdAt)}`,
        actions: kept
          ? [
              {
                label: "Undo",
                hint: "Puts back what was there before the restore.",
                onClick: () => {
                  source.restoreVersion!(path, kept).then(
                    () => setReload((n) => n + 1),
                    (error: unknown) => showToast({ title: "The restore wasn't undone", description: message(error) })
                  )
                }
              }
            ]
          : []
      })
    } catch (error) {
      setFailure(message(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      open={path !== null}
      onOpenChange={(open) => {
        if (open) return
        setFailure(null)
        onClose()
      }}
      title={`Versions of “${name}”`}
      description="Earlier contents are kept for 30 days."
    >
      {failure && (
        <p role="alert" className="text-sm text-danger">
          {failure}
        </p>
      )}
      {list === null ? (
        <p role="status" className="text-sm text-muted">
          Loading…
        </p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted">No earlier versions.</p>
      ) : (
        <ul aria-label="Versions" className="flex min-w-0 flex-col gap-2" data-file-versions="">
          {list.map((version) => (
            <li key={version.id} className="flex min-w-0 flex-wrap items-center gap-2" data-file-version={version.id}>
              <span className="flex min-w-0 grow flex-col">
                <span className="text-sm">{versionLabel(version)}</span>
                <span className="text-xs text-muted">
                  {formatMoment(version.createdAt)} · {formatByteSize(version.byteSize)}
                </span>
              </span>
              <Button
                hint={
                  version.restorable
                    ? "Puts this content back. What's there now is kept as a version."
                    : "Its content wasn't kept."
                }
                disabled={!version.restorable || busy !== null}
                pending={busy === version.id}
                onClick={() => void restore(version)}
              >
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
      <DialogActions>
        <Button hint="Closes this." onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  )
}
