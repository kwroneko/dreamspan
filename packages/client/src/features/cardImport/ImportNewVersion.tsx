// "Import a new version…" of a card (ARCHITECTURE.md §11.1; owner, 2026-11-01: "Cards
// participate in chats, so it can make sense to replace them with a new version wholesale
// everywhere"). Pick a file, see what it changes and what the card keeps, then Replace: the
// file's content becomes the card's next revision, an ordinary one History can undo. There's
// no Merge here yet: the three-way merge for cards is a later job's.
import { AsyncResult } from "effect/reactivity"
import { useAtomValue } from "@effect/atom-react"
import type { CardReplacePreview } from "@rp/shared/cardReplace.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { MAX_IMPORT_BYTES } from "@rp/shared/libraryImport.ts"
import { Effect } from "effect"
import { type ReactNode, useCallback, useMemo, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { formatByteSize } from "@rp/shared/byteSize.ts"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { AboutHint, LabelWithHelp } from "../../ui/AboutHint.tsx"
import { FileDrop } from "../../ui/FileDrop.tsx"
import { mediaUrl } from "../../ui/mediaImage.ts"
import { MenuAction, MenuItem } from "../../ui/Menu.tsx"
import { ReadableDiff } from "../../ui/ReadableDiff.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { ValueDiff } from "../editor/diff.tsx"
import type { FieldChange } from "../editor/fields.ts"
import { flushOpenEditors, refreshOpenEditors } from "../editor/openEditors.ts"
import { chatsLine, versionPlan, type VersionPlan } from "./preview.ts"
import { previewVersion, replaceWithVersion } from "./upload.ts"

const EXPLAIN = {
  action:
    "Replace this card with a new version of its file (PNG, JSON or CHARX): you see what changes first. Its notes, favourite, cutout and chats stay.",
  pick: "Choose the new version's file. It's only read to compare; nothing is stored until you press Replace.",
  replace:
    "Make the file's version this card's next revision. Chats that follow the card use it from then on; History can restore the one before.",
  another: "Pick a different file to compare instead.",
  cancel: "Close without changing anything."
}

const isText = (value: unknown) => value === undefined || typeof value === "string"

function Change({ change, open }: { change: FieldChange & { label: string }; open: boolean }) {
  return (
    <details open={open} className="min-w-0 rounded-md border border-border p-2">
      <summary className="cursor-pointer text-sm font-medium [overflow-wrap:anywhere]">{change.label}</summary>
      <div className="mt-2">
        {isText(change.before) && isText(change.after) ? (
          <ValueDiff before={change.before} after={change.after} />
        ) : (
          <ReadableDiff before={change.before} after={change.after} />
        )}
      </div>
    </details>
  )
}

/** The file's picture from the preview's bytes, through a `blob:` URL (the page's CSP allows no `data:` images). */
function FileImage({ image }: { image: { readonly mime: string; readonly base64: string } }) {
  const ref = useCallback(
    (node: HTMLImageElement | null) => {
      if (!node) return
      const bytes = Uint8Array.from(atob(image.base64), (c) => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: image.mime }))
      node.src = url
      return () => URL.revokeObjectURL(url)
    },
    [image]
  )
  return <img ref={ref} alt="The file's picture" className="h-full w-full object-contain" />
}

function Picture({ plan }: { plan: VersionPlan }) {
  const picture = plan.picture
  if (picture._tag !== "New")
    return (
      <p className="text-sm text-muted">
        {picture._tag === "Same" ? "The picture is the same as the card's." : "The file has no picture."}
      </p>
    )
  const frame =
    "relative flex h-40 w-28 items-center justify-center overflow-hidden rounded-md border border-border bg-canvas"
  // With images hidden in public (ui/imagePrefs.ts), a word shows in the picture's place.
  const hidden = (
    <span data-image-fallback className="absolute inset-0 items-center justify-center text-sm text-muted">
      Picture hidden
    </span>
  )
  return (
    <div className="flex flex-wrap gap-4" aria-label="Picture">
      <figure className="flex flex-col gap-1">
        <div className={frame}>
          {picture.before ? (
            <img
              src={mediaUrl(picture.before, 192)}
              alt="The card's picture now"
              className="h-full w-full object-contain"
            />
          ) : (
            <span className="text-sm text-muted">None</span>
          )}
          {picture.before && hidden}
        </div>
        <figcaption className="text-sm text-muted">Now</figcaption>
      </figure>
      <figure className="flex flex-col gap-1">
        <div className={frame}>
          {picture.after ? (
            <FileImage image={picture.after} />
          ) : (
            <span className="p-2 text-center text-sm text-muted">Too large to show here</span>
          )}
          {picture.after && hidden}
        </div>
        <figcaption className="text-sm text-muted">From the file</figcaption>
      </figure>
    </div>
  )
}

type Step =
  | { readonly _tag: "Pick" }
  | { readonly _tag: "Reading"; readonly file: File }
  | { readonly _tag: "Shown"; readonly file: File; readonly preview: CardReplacePreview }

/** The dialog: pick a file, see the comparison, Replace. */
export function NewVersionDialog({ refId, label, onClose }: { refId: RefId; label: string; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ _tag: "Pick" })
  const [problem, setProblem] = useState<string | null>(null)
  const [replaceProblem, setReplaceProblem] = useState<string | null>(null)
  const action = useAction()

  const read = async (file: File) => {
    setProblem(null)
    if (file.size > MAX_IMPORT_BYTES) {
      setProblem(`This file is larger than ${formatByteSize(MAX_IMPORT_BYTES)}.`)
      return
    }
    setStep({ _tag: "Reading", file })
    const outcome = await previewVersion(file, refId)
    if (outcome._tag !== "Done") {
      setStep({ _tag: "Pick" })
      setProblem(outcome._tag === "Failed" ? outcome.message : "Log in again to import a file.")
      return
    }
    if (outcome.result.card === null || outcome.result.docJson === null) {
      setStep({ _tag: "Pick" })
      const errors = outcome.result.report.issues.filter((issue) => issue.level === "error")
      setProblem(errors.map((issue) => issue.message).join(" ") || "This file can't be read as a card.")
      return
    }
    setStep({ _tag: "Shown", file, preview: outcome.result })
  }

  const shown = step._tag === "Shown" ? step : null
  const plan = shown ? versionPlan({ ...shown.preview, card: shown.preview.card! }) : null

  const replace = async () => {
    if (!shown) return
    // What's typed and not yet on the server goes there first, so the new text settles it.
    await flushOpenEditors()
    setReplaceProblem(null)
    // Through useAction, so the library, the chats' cards and the editors' queries read again.
    const result = await action.run(
      () => Effect.promise(() => replaceWithVersion(shown.file, refId, shown.preview.card!.headRevisionId)),
      ["library"]
    )
    const outcome = result.ok ? result.value : { _tag: "Failed" as const, message: result.error.message }
    if (outcome._tag !== "Done") {
      setReplaceProblem(outcome._tag === "Failed" ? outcome.message : "Log in again to import a file.")
      return
    }
    await refreshOpenEditors()
    showToast({ title: `${label} is now the file's version`, description: "History can restore the one before." })
    onClose()
  }

  const warnings = shown?.preview.report.issues.filter((issue) => issue.level === "warning") ?? []
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} wide title={`Import a new version of ${label}`}>
      {problem && (
        <Alert tone="danger" title="Couldn't read this file">
          <p>{problem}</p>
        </Alert>
      )}
      <ErrorAlert error={action.error} title="Couldn't replace the card" />
      {replaceProblem && (
        <Alert tone="danger" title="Couldn't replace the card">
          <p>{replaceProblem}</p>
        </Alert>
      )}
      {step._tag === "Pick" && (
        <div className="flex flex-col gap-2">
          <LabelWithHelp
            help={
              <AboutHint heading="Card file">
                The file replaces the card’s content everywhere the card is used.
              </AboutHint>
            }
          >
            <span className="inline text-sm font-medium">Card file</span>
          </LabelWithHelp>
          <FileDrop
            label="Choose the new version's file"
            description="A PNG, JSON or CHARX card, or drop it here. It's only read to compare; nothing is stored yet."
            accept=".png,.json,.charx,image/png,application/json"
            onFiles={(files) => files[0] && void read(files[0])}
          />
        </div>
      )}
      {step._tag === "Reading" && (
        <p role="status" className="text-sm text-muted">
          Reading {step.file.name}…
        </p>
      )}
      {shown && plan && (
        <div className="flex min-w-0 flex-col gap-4">
          <section aria-labelledby="new-version-changes" className="flex flex-col gap-2">
            <h3 id="new-version-changes" className="font-medium">
              What the file changes
            </h3>
            {plan.changes.length === 0 ? (
              <p className="text-sm text-muted">The file's text and settings are the same as the card's.</p>
            ) : (
              <ul className="flex flex-col gap-2" aria-label="Changed fields">
                {plan.changes.map((change) => (
                  <li key={change.path.join("/")}>
                    <Change change={change} open={plan.changes.length <= 3} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="new-version-picture" className="flex flex-col gap-2">
            <h3 id="new-version-picture" className="font-medium">
              Picture
            </h3>
            <Picture plan={plan} />
          </section>
          <section aria-labelledby="new-version-kept" className="flex flex-col gap-2">
            <h3 id="new-version-kept" className="font-medium">
              Kept from this card
            </h3>
            <ul className="list-disc pl-5 text-sm" aria-label="Kept from this card">
              {plan.kept.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
          {plan.notes.length > 0 && (
            <section aria-labelledby="new-version-notes" className="flex flex-col gap-2">
              <h3 id="new-version-notes" className="font-medium">
                Also note
              </h3>
              <ul className="list-disc pl-5 text-sm" aria-label="Also note">
                {plan.notes.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="new-version-chats" className="flex flex-col gap-2">
            <h3 id="new-version-chats" className="font-medium">
              Chats and undo
            </h3>
            <p className="text-sm">{chatsLine(plan)}</p>
            <p className="text-sm">
              Fields typed since the last save take the file's text; what you typed stays one step back in each field's
              edit history.
            </p>
            <p className="text-sm">
              It's an ordinary revision: History → restore revision {plan.revisionNumber} undoes it.
            </p>
          </section>
          {warnings.length > 0 && (
            <Alert tone="warning" title="About this file">
              <ul className="list-disc pl-5">
                {warnings.map((issue, index) => (
                  <li key={index}>{issue.message}</li>
                ))}
              </ul>
            </Alert>
          )}
        </div>
      )}
      <DialogActions>
        <Button hint={EXPLAIN.cancel} onClick={onClose}>
          Cancel
        </Button>
        {shown && (
          <Button hint={EXPLAIN.another} onClick={() => setStep({ _tag: "Pick" })}>
            Choose another file
          </Button>
        )}
        {shown && (
          <Button variant="primary" hint={EXPLAIN.replace} pending={action.pending} onClick={() => void replace()}>
            Replace
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}

const familyQuery = (entityId: EntityId) => AppClient.query("CardFamily", { entityId }, { reactivityKeys: ["library"] })

/** The card's library ref when the place showing it doesn't know it (the card page). */
function useCardRef(entityId: EntityId) {
  const result = useAtomValue(useMemo(() => familyQuery(entityId), [entityId]))
  const family = AsyncResult.isSuccess(result) ? result.value : null
  return family?.members.find((member) => member.entityId === entityId)?.refId ?? undefined
}

/** Reads the card's family for its ref, only where the place doesn't know it. */
function WithCardRef({ entityId, children }: { entityId: EntityId; children: (ref: RefId | undefined) => ReactNode }) {
  return children(useCardRef(entityId))
}

/**
 * The action as a button with its dialog: in the editor's header, the card page, a
 * chat's character tab. `refId` when the place knows the card's library entry.
 */
export function ImportNewVersion({
  refId,
  entityId,
  label,
  compact = false
}: {
  refId?: RefId
  entityId: EntityId
  label: string
  /** A row of ghost actions (the chat's character tab). */
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  // The Cast tab knows every card's ref: a family read per card there was an N+1 (night/tabperf).
  const action = (ref: RefId | undefined) => (
    <>
      <MenuAction
        variant={compact ? "ghost" : "secondary"}
        className={compact ? "h-8! px-2!" : ""}
        hint={EXPLAIN.action}
        disabled={!ref}
        onClick={() => setOpen(true)}
      >
        Import a new version…
      </MenuAction>
      {open && ref && <NewVersionDialog refId={ref} label={label} onClose={() => setOpen(false)} />}
    </>
  )
  return refId ? action(refId) : <WithCardRef entityId={entityId}>{action}</WithCardRef>
}

/** The library item menu's entry; the host mounts the dialog outside the menu. */
export function NewVersionMenuItem({
  openDialog,
  description
}: {
  openDialog: () => void
  description?: string | undefined
}) {
  return (
    <MenuItem icon="regenerate" description={description} onClick={openDialog}>
      Import a new version…
    </MenuItem>
  )
}
