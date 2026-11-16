// A newer version of a card the user added from a card source (spec/CARD-SOURCES.md §3.8):
// the notice under the card editor's actions, "A newer version is on cardex", and Check for a
// newer version in its Sources. The newer file is fetched only when the user opens the update,
// and then goes where a newer file from disk goes: staged on the card's import line for the
// merge review, or into the new-version dialog (Replace, Merge…, Add as a separate card).
// Nothing is sent to the source in the background (§9 D4).
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import {
  type CardOrigin,
  REMOTE_VERSION_HEADER,
  SOURCE_LINK_HEADER,
  SOURCE_VERSION_RECEIPT_HEADER
} from "@rp/shared/cardSources.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { AsyncResult } from "effect/reactivity"
import { lazy, Suspense, useContext, useMemo, useState } from "react"
import { invalidateKeys, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { stageVersion } from "../cardImport/upload.ts"
import { type EditorStore, useEditorState } from "../editor/store.ts"
import { problemText, useSourceCall } from "./remote.ts"

const MergeDialog = lazy(() => import("../forkMerge/MergeDialog.tsx").then((m) => ({ default: m.MergeDialog })))
const NewVersionDialog = lazy(() =>
  import("../cardImport/ImportNewVersion.tsx").then((m) => ({ default: m.NewVersionDialog }))
)

/** Invalidated by every write that changes a card's origin, with the library's. */
const ORIGIN_KEYS = ["library", "card-origin"]

/** The card's origin, when it was added from a source that's on; read locally. */
const originQuery = (entityId: string) => AppClient.query("CardOrigin", { entityId }, { reactivityKeys: ORIGIN_KEYS })

export function useOrigin(entityId: string): CardOrigin | null {
  const result = useAtomValue(useMemo(() => originQuery(entityId), [entityId]))
  return AsyncResult.isSuccess(result) ? result.value : null
}

type Fetched =
  | {
      readonly _tag: "Done"
      readonly file: File
      readonly version: string
      readonly link: string
      readonly receipt: string
    }
  | { readonly _tag: "Failed"; readonly message: string }

/** The file's name from `Content-Disposition` (`filename*=UTF-8''…`), else a name of the card's. */
const fileNameOf = (response: Response, fallback: string) => {
  const named = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get("content-disposition") ?? "")?.[1]
  try {
    return named ? decodeURIComponent(named) : fallback
  } catch {
    return fallback
  }
}

/** The source's newer file of the card, through this server, as a file from disk would be. */
async function fetchNewerFile(origin: CardOrigin): Promise<Fetched> {
  let response: Response
  try {
    response = await fetch(`/sources/held/${encodeURIComponent(origin.entityId)}/file`)
  } catch {
    return { _tag: "Failed", message: "The server couldn't be reached. Check that it's running." }
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    return {
      _tag: "Failed",
      message:
        typeof body?.error === "string" ? body.error : `Couldn't get the newer version from ${origin.sourceName}.`
    }
  }
  const version = decodeURIComponent(response.headers.get(REMOTE_VERSION_HEADER) ?? "")
  // The card's link back to its page there, which the version taken keeps (the file doesn't name it).
  const link = decodeURIComponent(response.headers.get(SOURCE_LINK_HEADER) ?? "")
  const bytes = await response.blob()
  return {
    _tag: "Done",
    file: new File([bytes], fileNameOf(response, `${origin.remoteId}.png`)),
    version,
    link,
    receipt: response.headers.get(SOURCE_VERSION_RECEIPT_HEADER) ?? ""
  }
}

/**
 * The notice's entry in `editorNotices`: for a card with a revision of its own, and for a
 * standalone lorebook added from a source (§3.9), in the full editor and the side panel alike.
 */
export function SourceUpdateNotice({ store }: { store: EditorStore }) {
  const snapshot = useEditorState(store).snapshot
  const ref = snapshot?.ref
  if (ref?.kind === "lorebook" && ref.entityId)
    return <LorebookUpdateNotice key={ref.entityId} entityId={ref.entityId} refId={ref.id} label={ref.label} />
  return ref && ref.kind === "card" && snapshot.revisionNumber > 0 ? (
    <UpdateNotice key={ref.entityId} entityId={ref.entityId} refId={ref.id} label={ref.label} />
  ) : null
}

/** Lorebook updates use the same explicit review as cards, in either editor. */
function LorebookUpdateNotice(props: { entityId: string; refId: RefId; label: string }) {
  return (
    <>
      <UpdateNotice {...props} what="lorebook" />
      <CheckForNewer entityId={props.entityId} name={props.label} what="lorebook" />
    </>
  )
}

type Open =
  | { readonly _tag: "Merge"; readonly revisionId: RevisionId; readonly fileName: string }
  | {
      readonly _tag: "Choices"
      readonly file: File
      readonly version: string
      readonly link: string
      readonly receipt: string
    }

function UpdateNotice({
  entityId,
  refId,
  label,
  what = "card"
}: {
  entityId: string
  refId: RefId
  label: string
  what?: "card" | "lorebook"
}) {
  const origin = useOrigin(entityId)
  const [open, setOpen] = useState<Open | null>(null)
  const [busy, setBusy] = useState<"merge" | "choices" | "ignore" | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const action = useAction()

  const take = async (version: string, receipt: string) => {
    await action.run((client) => client("TakeRemoteVersion", { entityId, version, receipt }), ORIGIN_KEYS)
  }

  const fetched = async (which: "merge" | "choices") => {
    if (!origin) return null
    setProblem(null)
    setBusy(which)
    const file = await fetchNewerFile(origin)
    if (file._tag === "Failed") {
      setBusy(null)
      setProblem(file.message)
      return null
    }
    return file
  }

  // Review and merge: the newer file staged on the import line, then the merge review.
  const review = async () => {
    const file = await fetched("merge")
    if (!file) return
    const staged = await stageVersion(
      what === "lorebook" ? new File([file.file], `${label}.json`) : file.file,
      refId,
      file.link
    )
    const revisionId = staged._tag === "Done" ? staged.result.library?.stagedRevisionId : undefined
    if (!revisionId) {
      setBusy(null)
      return setProblem(
        staged._tag === "Failed" ? staged.message : "The newer version couldn't be set aside for merging."
      )
    }
    // It waits on the import line now (the merge notice offers it until it's merged).
    await take(file.version, file.receipt)
    setBusy(null)
    setOpen({ _tag: "Merge", revisionId, fileName: file.file.name })
  }

  const choices = async () => {
    const file = await fetched("choices")
    setBusy(null)
    if (file)
      setOpen({ _tag: "Choices", file: file.file, version: file.version, link: file.link, receipt: file.receipt })
  }

  // Ignore future updates (owner, 2026-11-16): the notice and badges stay away until it's turned back on.
  const ignore = async () => {
    setBusy("ignore")
    const result = await action.run(
      (client) => client("SetRemoteUpdatesIgnored", { entityId, ignored: true }),
      ORIGIN_KEYS
    )
    setBusy(null)
    if (result.ok)
      showToast({
        title: `Ignoring updates to ${label || `this ${what}`}`,
        description: "Turn them back on in Metadata, under Sources."
      })
  }

  const addSeparate = async () => {
    const result = await action.run((client) => client("AddRemoteVersionAsCard", { entityId }), ORIGIN_KEYS)
    if (!result.ok) return result.error.message
    showToast({
      title: `Added the newer ${label} as a separate card`,
      description: "It's in your cards beside this one, which stays as it is."
    })
    return null
  }

  const sourceName = origin?.sourceName ?? "the source"
  return (
    <>
      {origin?.newerVersion && (
        <Alert
          title={`A newer version is on ${sourceName}`}
          actions={
            <>
              <Button
                hint={`Gets the newer version from ${sourceName} and shows its changes to pick which to take into this ${what}.`}
                pending={busy === "merge"}
                disabled={busy !== null}
                onClick={() => void review()}
              >
                Review and merge
              </Button>
              {what === "card" && (
                <Button
                  hint="Compares the newer version with this card, then replaces it, merges it or adds it as a separate card."
                  pending={busy === "choices"}
                  disabled={busy !== null}
                  onClick={() => void choices()}
                >
                  More choices…
                </Button>
              )}
              <Button
                hint={`Stops update notices and badges for this ${what}. You can turn them back on in its Sources.`}
                pending={busy === "ignore"}
                disabled={busy !== null}
                onClick={() => void ignore()}
              >
                Ignore future updates
              </Button>
            </>
          }
        >
          <p>Its changes aren't in this {what} until you take them.</p>
          {problem && <p className="text-danger">{problem}</p>}
          {action.error && <p className="text-danger">{action.error.message}</p>}
        </Alert>
      )}
      {open?._tag === "Merge" && (
        <Suspense fallback={null}>
          <MergeDialog
            refId={refId}
            theirsRevisionId={open.revisionId}
            fromFile={open.fileName}
            onClose={() => setOpen(null)}
          />
        </Suspense>
      )}
      {open?._tag === "Choices" && (
        <Suspense fallback={null}>
          <NewVersionDialog
            refId={refId}
            label={label}
            source={{
              name: sourceName,
              file: open.file,
              link: open.link,
              taken: () => take(open.version, open.receipt),
              addSeparate
            }}
            onClose={() => setOpen(null)}
          />
        </Suspense>
      )}
    </>
  )
}

/** Check for a newer version, in the card's Sources (§3.8): only for a card added from a source that's on. */
export function CheckForNewer({
  entityId,
  name,
  what = "card"
}: {
  entityId: string
  name: string
  what?: "card" | "lorebook"
}) {
  const origin = useOrigin(entityId)
  const call = useSourceCall()
  const registry = useContext(RegistryContext)
  const [pending, setPending] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const action = useAction()
  if (!origin) return null
  const setIgnored = (ignored: boolean) =>
    void action.run((client) => client("SetRemoteUpdatesIgnored", { entityId, ignored }), ORIGIN_KEYS)
  const check = async () => {
    setPending(true)
    setSaid(null)
    const outcome = await call((client) => client("CheckRemoteVersion", { entityId }))
    setPending(false)
    if (outcome === null) return
    // An unavailable successor also clears the existing update marker.
    invalidateKeys(registry, ORIGIN_KEYS)
    if (!outcome.ok) return setSaid(problemText(origin.sourceName, outcome.problem))
    setSaid(
      outcome.value.newerVersion
        ? `A newer version is on ${origin.sourceName}: the notice above offers it.`
        : `You have ${origin.sourceName}'s latest version.`
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 pt-2" data-card-source-check>
      <Button
        hint={`Asks ${origin.sourceName} whether ${name || `this ${what}`} has changed since you added it.`}
        pending={pending}
        onClick={() => void check()}
      >
        Check for a newer version
      </Button>
      {said && (
        <span role="status" className="text-sm text-muted">
          {said}
        </span>
      )}
      <Checkbox
        checked={origin.ignoreUpdates === true}
        onCheckedChange={setIgnored}
        hint={`While it's ticked, ${origin.sourceName}'s newer versions of this ${what} show no badge or notice.`}
      >
        Ignore future updates
      </Checkbox>
      {action.error && <span className="text-sm text-danger">{action.error.message}</span>}
    </div>
  )
}
