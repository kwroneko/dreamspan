// Share… (spec/FILES-AND-ENVIRONMENT.md §1.4): a folder of yours offered to named accounts, each
// Can view or Can edit, changed or stopped here. The other account accepts it, then finds it under
// Files/Shared/<your name>/<folder>. Whether a name is an account isn't said: an invitation is
// listed under the name as typed either way. A share whose folder is no longer at its path
// (moved by a command, replaced, or deleted and restored) is unavailable until shared again.
import type { FolderShare, ShareMode } from "@dreamspan/shared/files.ts"
import { useEffect, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
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
  const again = (entry: FolderShare) =>
    run(async () => {
      const made = await source.shareAgain!(entry.id)
      return (list ?? []).map((other) => (other.id === entry.id ? made : other))
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
      description="They get an invitation, and find it in their files under Shared once they accept."
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
            hint="Sends this account an invitation to the folder. Nothing is shared until they accept."
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
                {entry.status !== "active" && <StatusBadge status={entry.status} />}
                {entry.status !== "unavailable" && (
                  <Segmented
                    label={`What ${entry.displayName} can do`}
                    inlineDescription
                    options={MODES}
                    value={entry.mode}
                    onValueChange={(next) => void share(entry.handle, next)}
                  />
                )}
                {entry.status === "unavailable" && source.shareAgain && (
                  <Button
                    hint={`Shares this folder with ${entry.displayName} again. They see what's in it from now on, not its earlier versions.`}
                    disabled={busy}
                    onClick={() => void again(entry)}
                  >
                    Share again
                  </Button>
                )}
                <Button
                  variant="ghost"
                  hint={
                    entry.status === "invited"
                      ? `Takes back the invitation to “${entry.handle}”.`
                      : `Stops sharing it with ${entry.displayName}. Their next look no longer finds it.`
                  }
                  disabled={busy}
                  onClick={() => void stop(entry)}
                >
                  {entry.status === "invited" ? "Take back" : "Stop sharing"}
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

const STATUS = {
  invited: {
    label: "Invited",
    hint: "Shared once they accept. If no account has this name, nobody gets the invitation."
  },
  unavailable: {
    label: "Unavailable",
    hint: "This isn't the folder you shared: it was moved, replaced or deleted since. Share again to share this one."
  }
} as const

function StatusBadge({ status }: { status: keyof typeof STATUS }) {
  return (
    <Tooltip label={STATUS[status].hint}>
      <span tabIndex={0} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus">
        <Badge tone="neutral">{STATUS[status].label}</Badge>
      </span>
    </Tooltip>
  )
}
