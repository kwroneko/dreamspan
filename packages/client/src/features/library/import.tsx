import { SlotOutlet } from "../../slots.tsx"
import { importCards } from "./slots.ts"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
// The import screen: the way to a SillyTavern folder's import, first as the main path, and
// files picked or dropped, each uploaded in turn, with its report, and the whole library
// exported as one .zip (ARCHITECTURE.md §13b). With `?into=<ref>` it
// updates that library entry from a new version of its file, and offers only that.
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import type { RefId } from "@dreamspan/shared/library.ts"
import { MAX_IMPORT_BYTES } from "@dreamspan/shared/libraryImport.ts"
import { Link, useCanGoBack, useRouter, useSearch } from "@tanstack/react-router"
import { Effect } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useContext, useEffect, useRef, useState } from "react"
import { useAction } from "../../actions.tsx"
import { sessionAtom } from "../../session.ts"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import { FileDrop } from "../../ui/FileDrop.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { Alert, Badge, Card, CardHeader } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import { libraryAtom } from "./data.ts"
import { downloadLibraryArchive, uploadFile, type UploadOutcome } from "./files.ts"
import { ImportReportView } from "./report.tsx"
import { askMediaApproval } from "../savedMedia/approval.ts"

interface Upload {
  readonly id: number
  readonly file: File
  readonly status: "waiting" | "uploading" | "done"
  readonly outcome?: UploadOutcome
}

const STATUS = {
  waiting: { tone: "neutral", text: "waiting" },
  uploading: { tone: "accent", text: "importing" },
  imported: { tone: "success", text: "imported" },
  skipped: { tone: "warning", text: "not imported" },
  failed: { tone: "danger", text: "failed" }
} as const

const statusOf = (upload: Upload) => {
  if (upload.status !== "done") return STATUS[upload.status]
  if (upload.outcome?._tag !== "Done") return STATUS.failed
  return upload.outcome.result.library ? STATUS.imported : STATUS.skipped
}

/** The label of the entry an update goes into, once the library has loaded. */
function useIntoLabel(into: RefId | null) {
  const library = useAtomValue(libraryAtom)
  if (into === null || !AsyncResult.isSuccess(library)) return null
  const { card, lorebook, preset } = library.value
  return [...card, ...lorebook, ...preset].find((ref) => ref.id === into)?.label ?? null
}

function UploadRow({ upload }: { upload: Upload }) {
  const status = statusOf(upload)
  const outcome = upload.outcome
  return (
    <li className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{upload.file.name}</span>
        <span className="text-sm text-muted">{formatByteSize(upload.file.size)}</span>
        <Badge tone={status.tone}>
          {upload.status === "uploading" && <Spinner className="-ml-0.5 size-3" />}
          {status.text}
        </Badge>
      </div>
      {outcome?._tag === "Done" && <ImportReportView result={outcome.result} />}
      {(outcome?._tag === "Failed" || outcome?._tag === "Unauthorized") && (
        <Alert tone="danger">
          <p>
            {outcome._tag === "Failed"
              ? outcome.message
              : "Your session has ended. Log in again, then import the file again."}
          </p>
        </Alert>
      )}
    </li>
  )
}

/** The whole library as one .zip (ARCHITECTURE.md §13b), with what it received and a Stop. */
export function LibraryArchiveCard() {
  const [received, setReceived] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  const run = async () => {
    setError(null)
    setReceived(0)
    const controller = new AbortController()
    abort.current = controller
    const result = await downloadLibraryArchive(setReceived, controller.signal)
    abort.current = null
    setReceived(null)
    if (result !== null && result !== "aborted") setError(result)
  }
  return (
    <Card className="flex flex-col">
      <CardHeader
        title="Export the whole library"
        about="Every character, persona, lorebook, preset and chat with all its branches, as a .zip laid out like a SillyTavern data folder."
      />
      <p className="mb-3 text-sm text-muted">
        Includes archived entries and exportable card notes. Leaves out deleted items, workshops, chat pictures, saved
        card assets, chat notes, summaries, history, swipe marks, who wrote each swipe, status, and privacy or thread
        boundaries. Separate contexts become one transcript. SillyTavern ignores own-turn note rules. Changes made
        during export may appear in the files.
      </p>
      {error !== null && <Alert tone="danger">{error}</Alert>}
      <div className="mt-auto flex flex-wrap items-center gap-3">
        <Button
          hint="Downloads everything in your library as one .zip."
          variant="primary"
          pending={received !== null}
          onClick={() => void run()}
        >
          Export everything
        </Button>
        {received !== null && (
          <>
            <span role="status" className="text-sm text-muted">
              Exported {formatByteSize(received)}…
            </span>
            <Button hint="Stops the export. Discard any unfinished download." onClick={() => abort.current?.abort()}>
              Stop
            </Button>
          </>
        )}
      </div>
    </Card>
  )
}

export function ImportPage() {
  useTitle("Import")
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const registry = useContext(RegistryContext)
  const action = useAction()
  const search: { into?: unknown } = useSearch({ strict: false })
  const into = typeof search.into === "string" && search.into !== "" ? (search.into as RefId) : null
  const intoLabel = useIntoLabel(into)
  const [uploads, setUploads] = useState<ReadonlyArray<Upload>>([])
  const nextId = useRef(0)
  const left = uploads.filter((upload) => upload.status !== "done").length

  const update = (id: number, change: Partial<Upload>) =>
    setUploads((list) => list.map((upload) => (upload.id === id ? { ...upload, ...change } : upload)))

  const importFiles = async (files: ReadonlyArray<File>) => {
    const added: Array<Upload> = files.map((file) =>
      file.size > MAX_IMPORT_BYTES
        ? {
            id: nextId.current++,
            file,
            status: "done",
            outcome: { _tag: "Failed", message: `This file is larger than ${formatByteSize(MAX_IMPORT_BYTES)}.` }
          }
        : { id: nextId.current++, file, status: "waiting" }
    )
    setUploads((list) => [...added.toReversed(), ...list])
    // One at a time: the server parses a few files at once, and holds the rest back.
    const imported: RefId[] = []
    for (const upload of added) {
      if (upload.status === "done") continue
      update(upload.id, { status: "uploading" })
      // Through useAction, so the library lists reload after each file.
      const result = await action.run(() => Effect.promise(() => uploadFile(upload.file, into)), ["library"])
      const outcome: UploadOutcome = result.ok ? result.value : { _tag: "Failed", message: result.error.message }
      update(upload.id, { status: "done", outcome })
      if (outcome._tag === "Unauthorized") {
        registry.refresh(sessionAtom)
        return
      }
      if (outcome._tag === "Done" && outcome.result.library) imported.push(outcome.result.library.ref.id)
    }
    // One question for the whole batch: the new sites its media is on (spec/SAVED-MEDIA.md §3.2).
    askMediaApproval(imported)
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <CenterHeaderContent>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">{into ? "Update from a file" : "Import"}</h1>
          <div className="flex flex-wrap gap-2">
            {canGoBack ? (
              // Wherever the user came from: the shell's Import link is on every screen.
              <Button hint="Returns to file selection." variant="ghost" onClick={() => router.history.back()}>
                Back
              </Button>
            ) : (
              <Tooltip label="Returns to the library.">
                <Link to="/library" className={buttonClass("ghost")}>
                  Back to the library
                </Link>
              </Tooltip>
            )}
          </div>
        </header>
      </CenterHeaderContent>
      <div className={into ? "flex flex-col" : "grid gap-6 md:grid-cols-2"}>
        {!into && (
          <Card className="flex flex-col">
            <CardHeader
              title="Import a SillyTavern folder"
              about="Import characters, personas, chats, groups, lorebooks and chat-completion presets from SillyTavern. Re-import to add new and changed content."
            />
            <Tooltip label="Opens the SillyTavern folder importer.">
              <Link to="/import/st" className={`${buttonClass("primary")} mt-auto self-start`}>
                Choose the folder
              </Link>
            </Tooltip>
          </Card>
        )}
        <Card className="flex flex-col">
          <CardHeader
            title={into ? `Update “${intoLabel ?? "this entry"}”` : "Import files"}
            about={
              into
                ? "Pick its new version. Your own edits are merged with it; anything that conflicts is left as it was."
                : "Import character cards (PNG, JSON or CHARX), lorebooks and prompt presets. Import model and connection settings in Settings → Connections."
            }
          />
          <FileDrop
            label={into ? "Choose the new version, or drop it here" : "Choose files, or drop them here"}
            description={
              left > 0
                ? "Wait until these files are done to add more."
                : `Up to ${formatByteSize(MAX_IMPORT_BYTES)} each`
            }
            multiple={!into}
            accept=".png,.json,.charx,image/png,application/json"
            // One batch at a time: files dropped meanwhile would interleave with it.
            disabled={left > 0}
            onFiles={(files) => void importFiles(files)}
          />
        </Card>
        {!into && <SlotOutlet slot={importCards} props={{ into: null }} />}
      </div>
      {uploads.length > 0 && (
        <Card>
          <CardHeader
            title="Imported files"
            description={
              left > 0 ? (
                <span role="status" className="flex items-center gap-2">
                  <Spinner />
                  Importing, {left} {left === 1 ? "file" : "files"} to go…
                </span>
              ) : (
                "Done."
              )
            }
          />
          <ul aria-label="Imported files" className="flex flex-col divide-y divide-border">
            {uploads.map((upload) => (
              <UploadRow key={upload.id} upload={upload} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
