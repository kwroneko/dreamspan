// Text files in the viewer (spec/FILES-AND-ENVIRONMENT.md §8.2): the code editor, whose unsaved
// edits are drafts (`fileDraft.ts`) and whose Save writes the file only while it still is what the
// text was typed on; a conflict offers Compare, Load the latest and Save as a copy. Markdown shows
// rendered with Edit beside it, CSV and TSV as a table, HTML as its source with an opt-in preview in
// the sandboxed document frame, never on the app's origin. Larger text opens read-only, a page at a
// time. An attachment's copy as sent (no path in Files) is read-only.
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import {
  encodeText,
  joinPath,
  keepBothName,
  nameOf,
  parentOf,
  TEXT_EDIT_MAX_CHARS,
  TEXT_OPEN_MAX_BYTES,
  type TextFile
} from "@dreamspan/shared/files.ts"
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { useAction } from "../../actions.tsx"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { CodeEditor } from "../../ui/CodeEditor.tsx"
import { languageOf } from "../../ui/codeLanguages.ts"
import { Dialog } from "../../ui/Dialog.tsx"
import { HtmlMessageContext, type HtmlMessage } from "../../ui/html/messageHtml.ts"
import { effectiveDocumentRenderer } from "../../ui/html/parts.ts"
import { Markdown } from "../../ui/Markdown.tsx"
import { RevisionDiff } from "../../ui/RevisionDiff.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Alert, Badge } from "../../ui/Surface.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { FileDraft, type Run } from "./fileDraft.ts"
import { onFolderChanged } from "./live.ts"
import { FileChanged, type FilesSource } from "./source.ts"
import { parseTable, TABLE_ROWS_SHOWN } from "./table.ts"
import type { ViewerProps } from "./viewers.tsx"

/** A page of a large text file, read-only (§8.2). */
const PAGE_BYTES = 256 * 1024

export type TextMode = "text" | "markdown" | "table" | "html"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A text file: editable where it's a file of Files that fits, read-only otherwise. */
export function TextViewer(props: ViewerProps & { mode: TextMode }) {
  if (props.size > TEXT_OPEN_MAX_BYTES) return <PagedText {...props} />
  if (props.path !== null && props.source !== null)
    return <EditableText key={props.path} {...props} path={props.path} source={props.source} />
  return <CopyText {...props} />
}

/** Fetches a text, the copy as sent of an attachment, read-only. */
function CopyText(props: ViewerProps & { mode: TextMode }) {
  const [text, setText] = useState<{ for: string; value: string } | { for: string; error: string } | null>(null)
  useEffect(() => {
    let live = true
    fetch(props.url, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`The server answered ${response.status}.`)
        // A copy larger than the editor opens shows its first part; Download has the rest.
        const bytes = new Uint8Array(await response.arrayBuffer())
        let end = Math.min(bytes.length, TEXT_OPEN_MAX_BYTES)
        if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
        return { value: new TextDecoder().decode(bytes.subarray(0, end)), cut: end < bytes.length }
      })
      .then(
        ({ value, cut }) =>
          live &&
          setText({
            for: props.url,
            value: cut
              ? `${value}\n\n[Only the first ${formatByteSize(TEXT_OPEN_MAX_BYTES)} is shown. Download the file for the rest.]`
              : value
          }),
        (error: unknown) => live && setText({ for: props.url, error: message(error) })
      )
    return () => {
      live = false
    }
  }, [props.url])
  const shown = text?.for === props.url ? text : null
  if (shown === null) return <Loading name={props.name} />
  if ("error" in shown) return <Failed name={props.name} error={shown.error} />
  return <Shown {...props} text={shown.value} readOnly onChange={null} />
}

function Loading({ name }: { name: string }) {
  return (
    <p role="status" className="text-sm text-muted">
      Loading {name}…
    </p>
  )
}

function Failed({ name, error }: { name: string; error: string }) {
  return (
    <p role="alert" className="text-sm text-danger">
      {name} couldn’t be read: {error}
    </p>
  )
}

/** What a text shows as: the editor, or its rendered form with the editor one choice away. */
function Shown({
  mode,
  name,
  text,
  base,
  readOnly,
  onChange,
  tools
}: {
  mode: TextMode
  name: string
  text: string
  base?: string
  readOnly: boolean
  onChange: ((text: string) => void) | null
  tools?: ReactNode
}) {
  const [view, setView] = useState<"rendered" | "source">(mode === "html" ? "source" : "rendered")
  const editor = (
    <CodeEditor
      label={`Contents of ${name}`}
      value={text}
      base={base ?? text}
      readOnly={readOnly || onChange === null}
      mono
      quietMarkers
      language={languageOf(name)}
      textActions={false}
      rows={16}
      onChange={onChange ?? (() => undefined)}
    />
  )
  if (mode === "text")
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {tools}
        {editor}
      </div>
    )
  const choices =
    mode === "markdown"
      ? [
          { value: "rendered" as const, label: "Preview", description: "Shows the text formatted." },
          { value: "source" as const, label: readOnly ? "Text" : "Edit", description: "Shows the text itself." }
        ]
      : mode === "table"
        ? [
            { value: "rendered" as const, label: "Table", description: "Shows the rows and columns." },
            { value: "source" as const, label: "Edit as text", description: "Shows the text itself." }
          ]
        : [
            { value: "source" as const, label: "Source", description: "Shows the page's text." },
            {
              value: "rendered" as const,
              label: "Preview",
              description: "Shows the page in a sealed-off frame. Its scripts don't run."
            }
          ]
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Show as" options={choices} value={view} onValueChange={setView} />
        {tools}
      </div>
      {view === "source" ? editor : mode === "markdown" ? <MarkdownPreview text={text} /> : null}
      {view === "rendered" && mode === "table" && <TablePreview text={text} name={name} />}
      {view === "rendered" && mode === "html" && <HtmlPreview text={text} />}
    </div>
  )
}

/**
 * A file's preview is never a message's (§8.2): its own context with scripts and the internet
 * off, whatever message it was opened from (React context crosses the dialog's portal).
 */
const FILE_PREVIEW: HtmlMessage = {
  key: "file-preview",
  permit: { scripts: false, network: false, ask: null }
}

export function MarkdownPreview({ text }: { text: string }) {
  return (
    <HtmlMessageContext value={FILE_PREVIEW}>
      <div
        className="max-h-[70vh] min-w-0 overflow-auto rounded-md border border-border bg-canvas p-3"
        data-file-markdown=""
      >
        <Markdown text={text} streaming={false} />
      </div>
    </HtmlMessageContext>
  )
}

function TablePreview({ text, name }: { text: string; name: string }) {
  const table = parseTable(text, name.toLowerCase().endsWith(".tsv") ? "\t" : ",")
  const [head, ...rows] = table.rows
  if (!head) return <p className="text-sm text-muted">This table is empty.</p>
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="max-h-[70vh] overflow-auto rounded-md border border-border" data-file-table="">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-surface-raised">
            <tr>
              {head.map((cell, i) => (
                <th key={i} scope="col" className="border-b border-border px-2 py-1 text-left font-medium">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="even:bg-canvas">
                {row.map((cell, i) => (
                  <td key={i} className="border-b border-border px-2 py-1 align-top [overflow-wrap:anywhere]">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.total > TABLE_ROWS_SHOWN && (
        <p className="text-xs text-muted">
          Showing the first {TABLE_ROWS_SHOWN.toLocaleString()} of {table.total.toLocaleString()} rows. Edit as text to
          see them all.
        </p>
      )}
    </div>
  )
}

/** The page in the message renderer's sandboxed document frame: an opaque origin, scripts off. */
export function HtmlPreview({ text }: { text: string }) {
  const Frame = effectiveDocumentRenderer()?.component
  if (!Frame) return <p className="text-sm text-muted">Previews aren’t available here.</p>
  return (
    <HtmlMessageContext value={FILE_PREVIEW}>
      <div className="min-w-0 rounded-md border border-border" data-file-html-preview="">
        <Frame source={text} index={0} />
      </div>
    </HtmlMessageContext>
  )
}

/** A file of Files, opened whole: the editor with its draft, Save, and the conflict's choices. */
function EditableText(props: ViewerProps & { mode: TextMode; path: string; source: FilesSource }) {
  const { path, source } = props
  const [file, setFile] = useState<{ for: string; value: TextFile } | { for: string; error: string } | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let live = true
    source.readText(path).then(
      (value) => live && setFile({ for: path, value }),
      (error: unknown) => live && setFile({ for: path, error: message(error) })
    )
    return () => {
      live = false
    }
  }, [path, source, version])
  const shown = file?.for === path ? file : null
  if (shown === null) return <Loading name={props.name} />
  if ("error" in shown) return <Failed name={props.name} error={shown.error} />
  return (
    <Editing
      {...props}
      file={shown.value}
      readOnly={props.readOnly || shown.value.text.length > TEXT_EDIT_MAX_CHARS}
      onReread={() => setVersion((v) => v + 1)}
    />
  )
}

function Editing({
  mode,
  name,
  path,
  source,
  file,
  readOnly,
  onReread
}: ViewerProps & {
  mode: TextMode
  path: string
  source: FilesSource
  file: TextFile
  readOnly: boolean
  onReread: () => void
}) {
  const userId = useSession().user.id
  const action = useAction()
  // Its registry and state setters are stable, so the first render's run serves throughout.
  const [store] = useState(() => new FileDraft(action.run as Run, source, userId, path, file))
  const view = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const [comparing, setComparing] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void store.open()
    return () => store.dispose()
  }, [store])
  // A file read again (after a save elsewhere, Undo, Load the latest) reaches the edit.
  useEffect(() => store.update(file), [store, file])
  // Changed on disk while open (a command, the assistant, another tab): read again, so the box
  // shows it when nothing's typed, and a conflict when something is.
  useEffect(
    () =>
      onFolderChanged(parentOf(path), () => {
        source.readText(path).then(
          (latest) => {
            if (latest.sha256 !== store.current.sha256) store.update(latest)
          },
          () => undefined
        )
      }),
    [path, source, store]
  )

  const save = async () => {
    setBusy(true)
    const saved = await store.save()
    setBusy(false)
    if (saved === null || saved === "changed") return
    showToast({
      title: `“${name}” saved`,
      description: "The earlier text is kept as a version.",
      actions: [
        {
          label: "Undo",
          hint: "Puts back the text it had before this save.",
          onClick: () => {
            source
              .saveText(path, saved.before.text, saved.after.sha256, saved.before)
              .then(onReread, (error: unknown) =>
                showToast({
                  title: "Not undone",
                  description: error instanceof FileChanged ? "Changed since. Open its versions." : message(error)
                })
              )
          }
        }
      ]
    })
  }

  const loadLatest = async () => {
    setBusy(true)
    try {
      const latest = await source.readText(path)
      if (await store.discard(latest)) {
        setComparing(false)
        showToast({ title: "The latest text is shown", description: "Your edit is in the bin's recovered texts." })
      }
    } catch (error) {
      showToast({ title: "The latest text couldn’t be read", description: message(error) })
    } finally {
      setBusy(false)
    }
  }

  const saveCopy = async () => {
    setBusy(true)
    try {
      const folder = parentOf(path)
      const listing = await source.list(folder)
      const copyName = keepBothName(name, new Set(listing.entries.map((entry) => entry.name)))
      const bytes = encodeText(view.text, file.lineEnding, file.bom) as Uint8Array<ArrayBuffer>
      const outcome = await source.upload(joinPath(folder, copyName), new Blob([bytes]), "keep")
      if (await store.ended()) {
        store.update(await source.readText(path))
        setComparing(false)
        showToast({ title: `Saved as “${nameOf(outcome.path)}”`, description: `“${name}” is as it was on disk.` })
      }
    } catch (error) {
      showToast({ title: "The copy wasn’t saved", description: message(error) })
    } finally {
      setBusy(false)
    }
  }

  const discard = async () => {
    setBusy(true)
    await store.discard()
    setBusy(false)
  }

  if (view.loading) return <Loading name={name} />
  const tools = readOnly ? (
    <Badge tone="neutral">Read-only</Badge>
  ) : (
    <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Editing">
      <Button
        variant="primary"
        hint="Writes your changes to the file. The earlier text is kept as a version."
        disabled={!view.changed || view.conflict}
        pending={busy}
        onClick={() => void save()}
      >
        Save
      </Button>
      <Button
        variant="ghost"
        hint="Throws your changes away and shows the file as it is. Your text goes to the bin's recovered texts."
        disabled={!view.changed || busy}
        onClick={() => void discard()}
      >
        Discard changes
      </Button>
      <span className="text-xs text-muted" data-file-edit-state="">
        {view.unsaved ? "Typing…" : view.changed ? "Changes not saved to the file" : "Saved"}
      </span>
    </div>
  )
  return (
    <div className="flex min-w-0 flex-col gap-2" data-file-editor={path}>
      {view.conflict && (
        <Alert
          tone="warning"
          title="This file changed since you started editing"
          actions={
            <>
              <Button hint="Shows the file as it is now beside your text." onClick={() => setComparing(true)}>
                Compare
              </Button>
              <Button
                hint="Shows the file as it is now. Your text goes to the bin's recovered texts."
                disabled={busy}
                onClick={() => void loadLatest()}
              >
                Load the latest
              </Button>
              <Button
                hint="Saves your text as a new file beside it, and leaves this one as it is."
                disabled={busy}
                onClick={() => void saveCopy()}
              >
                Save as a copy
              </Button>
            </>
          }
        >
          Your changes are kept. Save is off until you choose.
        </Alert>
      )}
      {view.error && (
        <p role="alert" className="text-sm text-danger">
          {view.error.message}
        </p>
      )}
      {readOnly && file.text.length > TEXT_EDIT_MAX_CHARS && (
        <p className="text-xs text-muted">
          Files over {TEXT_EDIT_MAX_CHARS.toLocaleString()} characters open read-only here.
        </p>
      )}
      <Shown
        mode={mode}
        name={name}
        text={view.text}
        base={file.text}
        readOnly={readOnly}
        onChange={readOnly ? null : (text) => store.setText(text)}
        tools={tools}
      />
      <Dialog
        open={comparing}
        onOpenChange={setComparing}
        title="Compare"
        description="The file as it is now, and your text."
        wide
      >
        <RevisionDiff before={store.current.text} after={view.text} beforeLabel="The file now" afterLabel="Your text" />
      </Dialog>
    </div>
  )
}

/** A text file too large to open whole: a page at a time, read-only, by Range requests. */
function PagedText(props: ViewerProps & { mode: TextMode }) {
  const [start, setStart] = useState(0)
  const [page, setPage] = useState<{ for: string; text: string; next: number } | { for: string; error: string } | null>(
    null
  )
  const key = `${props.url}#${start}`
  useEffect(() => {
    let live = true
    fetch(props.url, { cache: "no-store", headers: { range: `bytes=${start}-${start + PAGE_BYTES + 3}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`The server answered ${response.status}.`)
        return new Uint8Array(await response.arrayBuffer())
      })
      .then(
        (bytes) => {
          // Ends on a whole character: the page's last bytes may start one that the next page holds.
          let end = Math.min(bytes.length, PAGE_BYTES)
          if (start + end < props.size) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
          const text = new TextDecoder().decode(bytes.subarray(0, end))
          if (live) setPage({ for: key, text, next: start + end })
        },
        (error: unknown) => live && setPage({ for: key, error: message(error) })
      )
    return () => {
      live = false
    }
  }, [key, props.url, props.size, start])
  const shown = page?.for === key ? page : null
  const from = start
  return (
    <div className="flex min-w-0 flex-col gap-2" data-file-paged="">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          hint="Shows the page before this one."
          disabled={start === 0}
          onClick={() => setStart(Math.max(0, start - PAGE_BYTES))}
        >
          Previous page
        </Button>
        <Button
          hint="Shows the next part of the file."
          disabled={shown === null || "error" in shown || shown.next >= props.size}
          onClick={() => shown && !("error" in shown) && setStart(shown.next)}
        >
          Next page
        </Button>
        <span className="text-xs text-muted">
          {formatByteSize(from)} to {formatByteSize(shown && !("error" in shown) ? shown.next : from)} of{" "}
          {formatByteSize(props.size)}. Files this large open read-only.
        </span>
      </div>
      {shown === null ? (
        <Loading name={props.name} />
      ) : "error" in shown ? (
        <Failed name={props.name} error={shown.error} />
      ) : (
        <Shown mode="text" name={props.name} text={shown.text} readOnly onChange={null} />
      )}
    </div>
  )
}
