// The Files page (spec/FILES-AND-ENVIRONMENT.md §8.1): the same file manager as the workshop's Files
// tab, full width, with the folder tree beside the list where there's room. Its place is its URL
// (`?path=` the folder, `?file=` the file open in it), so it opens as a workbench tab, splits and
// reloads like any page; each file opened from the list is a tab of its own (the `files` kind).
import { FILES_TOP, nameOf, normalizePath } from "@dreamspan/shared/files.ts"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import { FileBrowser } from "./FileBrowser.tsx"
import { filesHref } from "./href.ts"
import { useFilesSource } from "./source.ts"

/** The router reads search values as JSON where they parse: a file named "12" comes back a number. */
const text = (value: unknown) =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null

export function FilesPage() {
  const folder = normalizePath(
    useSearch({ strict: false, select: (s: Record<string, unknown>) => text(s.path) }) ?? FILES_TOP
  )
  const file = useSearch({ strict: false, select: (s: Record<string, unknown>) => text(s.file) })
  useTitle(file ?? (folder === FILES_TOP ? "Files" : nameOf(folder)))
  const navigate = useNavigate()
  const source = useFilesSource()
  const go = (next: string, open: string | null) => void navigate({ href: filesHref(next, open) })
  return (
    <Card className="min-w-0">
      <CardHeader center title="Files" />
      {source ? (
        <FileBrowser
          source={source}
          folder={folder}
          onFolder={(path) => go(path, null)}
          opened={file}
          onOpened={(name) => go(folder, name)}
        />
      ) : (
        <p className="text-sm text-muted">Files aren’t available here.</p>
      )}
    </Card>
  )
}
