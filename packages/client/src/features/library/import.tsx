// The import screen: pick or drop files, each uploaded in turn, with its report. With
// `?into=<ref>` it updates that library entry from a new version of its file.
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import type { RefId } from "@rp/shared/library.ts"
import { MAX_IMPORT_BYTES } from "@rp/shared/libraryImport.ts"
import { Link, useSearch } from "@tanstack/react-router"
import { Effect } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useContext, useRef, useState } from "react"
import { useAction } from "../../actions.tsx"
import { sessionAtom } from "../../session.ts"
import { buttonClass } from "../../ui/Button.tsx"
import { FileDrop } from "../../ui/FileDrop.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { Alert, Badge, Card, CardHeader } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import { libraryAtom } from "./data.ts"
import { uploadFile, type UploadOutcome } from "./files.ts"
import { ImportReportView } from "./report.tsx"

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

/** 900 B, 12 KB, 1.5 MB, 64 MB. */
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`

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
        <span className="text-sm text-muted">{size(upload.file.size)}</span>
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

export function ImportPage() {
  useTitle("Import")
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
            outcome: { _tag: "Failed", message: `This file is larger than ${size(MAX_IMPORT_BYTES)}.` }
          }
        : { id: nextId.current++, file, status: "waiting" }
    )
    setUploads((list) => [...added.toReversed(), ...list])
    // One at a time: the server parses a few files at once, and holds the rest back.
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
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{into ? "Update from a file" : "Import"}</h1>
        <div className="flex flex-wrap gap-2">
          {!into && (
            <Link to="/import/st" className={buttonClass("secondary")}>
              Import a SillyTavern folder
            </Link>
          )}
          <Link to="/library" className={buttonClass("ghost")}>
            Back to the library
          </Link>
        </div>
      </header>
      <Card>
        <CardHeader
          title={into ? `Update “${intoLabel ?? "this entry"}”` : "Files"}
          description={
            into
              ? "Pick its new version. Your own edits and variants are merged with it; anything that conflicts is left as it was."
              : "Character cards (PNG, JSON or CHARX), SillyTavern World Info files and chat-completion presets. The format is read from the file itself."
          }
        />
        <FileDrop
          label={into ? "Choose the new version, or drop it here" : "Choose files, or drop them here"}
          description={
            left > 0 ? "Wait until these files are done to add more." : `Up to ${size(MAX_IMPORT_BYTES)} each`
          }
          multiple={!into}
          accept=".png,.json,.charx,image/png,application/json"
          // One batch at a time: files dropped meanwhile would interleave with it.
          disabled={left > 0}
          onFiles={(files) => void importFiles(files)}
        />
      </Card>
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
