// Share… (spec/FILES-AND-ENVIRONMENT.md §1.4): a folder of yours shared with named accounts, each
// Can view or Can edit, changed or stopped here. The other account finds it under
// Files/Shared/<your name>/<folder>.
import type { FolderShare, ShareMode } from "@dreamspan/shared/files.ts"
import { useEffect, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import type { FilesSource } from "./source.ts"

const MODES = [
  { value: "view", label: "Can view", description: "They can open and download what's in it, and change nothing." },
  {
    value: "edit",
    label: "Can edit",
    description: "They can also add, change, rename and delete what's in it. Your storage pays for it."
  }
] as const

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function ShareDialog({
  source,
  path,
  name,
  onClose
}: {
  source: FilesSource
  /** The folder; null: closed. */
  path: string | null
  name: string
  onClose: () => void
}) {
  const [shares, setShares] = useState<{ for: string; list: ReadonlyArray<FolderShare> } | null>(null)
  const [handle, setHandle] = useState("")
  const [mode, setMode] = useState<ShareMode>("view")
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (path === null || !source.shares) return
    let live = true
    source.shares(path).then(
      (list) => live && setShares({ for: path, list }),
      (error: unknown) => live && setFailure(message(error))
    )
    return () => {
      live = false
    }
  }, [path, source])
  const list = shares?.for === path ? shares.list : null

  const run = async (work: () => Promise<ReadonlyArray<FolderShare>>) => {
    setBusy(true)
    setFailure(null)
    try {
      setShares({ for: path!, list: await work() })
      return true
    } catch (error) {
      setFailure(message(error))
      return false
    } finally {
      setBusy(false)
    }
  }
  const share = async (who: string, how: ShareMode) =>
    run(async () => {
      const made = await source.share!(path!, who, how)
      return [...(list ?? []).filter((entry) => entry.id !== made.id), made]
    })
  const stop = (entry: FolderShare) =>
    run(async () => {
      await source.unshare!(entry.id)
      return (list ?? []).filter((other) => other.id !== entry.id)
    })

  return (
    <Dialog
      open={path !== null}
      onOpenChange={(open) => {
        if (open) return
        setHandle("")
        setFailure(null)
        onClose()
      }}
      title={`Share “${name}”`}
      description={`Who you share it with finds it in their files, under Shared.`}
    >
      <form
        className="flex min-w-0 flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (handle.trim() === "") return
          void share(handle.trim(), mode).then((ok) => ok && setHandle(""))
        }}
      >
        <Field label="Account name">
          <Input
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-share-handle=""
          />
        </Field>
        <Segmented label="What they can do" options={MODES} value={mode} onValueChange={setMode} />
        {failure && (
          <p role="alert" className="text-sm text-danger">
            {failure}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            hint="Shares the folder with this account."
            disabled={handle.trim() === ""}
            pending={busy}
          >
            Share
          </Button>
        </div>
      </form>
      <section aria-label="Shared with" className="flex min-w-0 flex-col gap-2" data-share-list="">
        <h3 className="text-sm font-medium">Shared with</h3>
        {list === null ? (
          <p role="status" className="text-sm text-muted">
            Loading…
          </p>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted">Nobody yet.</p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-2">
            {list.map((entry) => (
              <li key={entry.id} className="flex min-w-0 flex-wrap items-center gap-2" data-share-row={entry.handle}>
                <span className="min-w-0 grow text-sm [overflow-wrap:anywhere]">
                  {entry.displayName}
                  {entry.displayName !== entry.handle && <span className="text-muted"> ({entry.handle})</span>}
                </span>
                <Segmented
                  label={`What ${entry.displayName} can do`}
                  inlineDescription
                  options={MODES}
                  value={entry.mode}
                  onValueChange={(next) => void share(entry.handle, next)}
                />
                <Button
                  variant="ghost"
                  hint={`Stops sharing it with ${entry.displayName}. Their next look no longer finds it.`}
                  disabled={busy}
                  onClick={() => void stop(entry)}
                >
                  Stop sharing
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <DialogActions>
        <Button hint="Closes this." onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  )
}
