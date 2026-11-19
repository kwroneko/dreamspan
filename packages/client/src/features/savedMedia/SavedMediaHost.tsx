// The signed-in app's part of saved card media: it answers the renderer's lookups
// (ui/html/savedMedia.ts) and shows the dialog that approves new sites (approval.ts).
import type { MediaApprovalHost, MediaChoice, MediaKind } from "@dreamspan/shared/savedMedia.ts"
import { useEffect, useState, useSyncExternalStore } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Select, type SelectItem } from "../../ui/Select.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { savedMedia } from "../../ui/html/savedMedia.ts"
import { useCaller } from "../editor/caller.ts"
import { approvalRequest, closeApproval, subscribeApproval } from "./approval.ts"

const CHOICES: ReadonlyArray<SelectItem<MediaChoice>> = [
  { value: "approve", label: "Approve", description: "Adds the site to your approved list and saves its files." },
  {
    value: "approve-subdomains",
    label: "Approve with subdomains",
    description: "Adds the site and every site under it (like i.example.com) and saves their files."
  },
  { value: "once", label: "This time only", description: "Saves these files without adding the site to your list." },
  { value: "decline", label: "Don't download", description: "Leaves these files on the other site." }
]

const KIND_NAMES: Record<MediaKind, readonly [string, string]> = {
  image: ["image", "images"],
  audio: ["sound", "sounds"],
  video: ["video", "videos"],
  font: ["font", "fonts"]
}

/** "3 images, 1 font". */
const describeKinds = (kinds: MediaApprovalHost["kinds"]) =>
  kinds.map(({ kind, files }) => `${files} ${KIND_NAMES[kind][files === 1 ? 0 : 1]}`).join(", ")

function ApprovalDialog() {
  const request = useSyncExternalStore(subscribeApproval, approvalRequest, approvalRequest)
  const call = useCaller()
  // What the server listed for which request: a new request shows nothing until its list arrives.
  const [loaded, setLoaded] = useState<{
    readonly key: string
    readonly hosts: ReadonlyArray<MediaApprovalHost> | null
    readonly error: AppError | null
  } | null>(null)
  const [choices, setChoices] = useState<Readonly<Record<string, MediaChoice>>>({})
  const [pending, setPending] = useState(false)
  const [applyError, setError] = useState<AppError | null>(null)
  const refIds = request?.refIds ?? null
  const key = request === null ? null : JSON.stringify(refIds)
  const current = loaded !== null && loaded.key === key ? loaded : null
  const hosts = current?.hosts ?? null
  const error = applyError ?? current?.error ?? null

  useEffect(() => {
    if (key === null) return
    let active = true
    void call((client) => client("ListMediaApproval", { refIds: refIds === null ? null : [...refIds] })).then(
      (result) => {
        if (!active) return
        // Nothing new to decide: no dialog at all.
        if (result.ok && result.value.length === 0) closeApproval()
        else if (result.ok) setLoaded({ key, hosts: result.value, error: null })
        else setLoaded({ key, hosts: null, error: result.error })
      }
    )
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the request
  }, [key, call])

  if (request === null || (hosts === null && error === null)) return null
  const close = () => {
    closeApproval()
    setChoices({})
  }
  const decided = Object.entries(choices)
  const apply = async () => {
    setPending(true)
    setError(null)
    const result = await call(
      (client) =>
        client("DecideMediaApproval", {
          refIds: refIds === null ? null : [...refIds],
          decisions: decided.map(([host, choice]) => ({ host, choice }))
        }),
      ["mediaHosts", "savedMedia"]
    )
    setPending(false)
    if (!result.ok) return setError(result.error)
    savedMedia.forget()
    close()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      title="Save media from new sites?"
      description="Saving a file contacts its site once. After that it shows from this app, and viewing never contacts the site."
    >
      <ErrorAlert error={error} />
      {hosts === null ? (
        <Spinner />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {hosts.map((host) => (
            <li key={host.host} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium [overflow-wrap:anywhere]">{host.host}</span>
                <span className="text-sm text-muted">{describeKinds(host.kinds)}</span>
              </div>
              <Select
                items={CHOICES}
                value={choices[host.host] ?? null}
                placeholder="Decide later"
                className="sm:w-56 sm:shrink-0"
                ariaLabel={`What to do with ${host.host}`}
                onValueChange={(choice) => setChoices((all) => ({ ...all, [host.host]: choice }))}
              />
            </li>
          ))}
        </ul>
      )}
      <DialogActions>
        <Button
          hint="Closes this. The files keep waiting, and the entry's Saved media section can open this again."
          onClick={close}
        >
          Not now
        </Button>
        <Button
          variant="primary"
          hint="Applies your choices. Sites left on “Decide later” keep waiting."
          disabled={decided.length === 0}
          pending={pending}
          onClick={() => void apply()}
        >
          Apply
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export function SavedMediaHost() {
  const call = useCaller()
  useEffect(() => {
    savedMedia.install(async (urls) => {
      const result = await call((client) => client("LookupSavedMedia", { urls: [...urls] }))
      return result.ok ? result.value : null
    })
    return () => savedMedia.install(null)
  }, [call])
  return <ApprovalDialog />
}
