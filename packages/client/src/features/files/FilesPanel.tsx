// The workshop's Files tab (spec/FILES-AND-ENVIRONMENT.md §8.1): the file manager in the chat's
// side panel, and on a phone in its sheet, opening at the branch's working folder. A file opened
// here shows in the tab; Open as a tab puts it in a frame of its own where frames fit.
import { FILES_TOP } from "@dreamspan/shared/files.ts"
import { useState, type ReactNode } from "react"
import type { PanelProps } from "../chat/panels.tsx"
import type { ChatSession, ChatView } from "../chat/session.ts"
import { openBeside, useCanOpenBeside } from "../workbench/OpenBeside.tsx"
import { requestAttach } from "../chat/fileAttachments.ts"
import { FileBrowser, type WorkingFolder } from "./FileBrowser.tsx"
import { filesHref } from "./href.ts"
import { useFilesSource } from "./source.ts"
import { useWorkingFolderSource, type WorkingFolderSource } from "./working.ts"

export function FilesPanel({ session, view }: Pick<PanelProps, "session" | "view">) {
  const working = useWorkingFolderSource()
  // Keyed by the source, so a source registered later starts its hook afresh.
  return working ? (
    <WithWorkingFolder key={working.id} source={working} session={session} view={view}>
      {(folder) => <Files working={folder} onAttach={(path) => requestAttach(session.chatId, path)} />}
    </WithWorkingFolder>
  ) : (
    <Files working={null} />
  )
}

function WithWorkingFolder({
  source,
  session,
  view,
  children
}: {
  source: WorkingFolderSource
  session: ChatSession
  view: ChatView
  children: (working: WorkingFolder | null) => ReactNode
}) {
  const { useWorkingFolder } = source
  return children(useWorkingFolder(session, view))
}

function Files({ working, onAttach }: { working: WorkingFolder | null; onAttach?: (path: string) => void }) {
  const source = useFilesSource()
  const [chosen, setChosen] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const beside = useCanOpenBeside()
  if (!source) return <p className="text-sm text-muted">Files aren’t available here.</p>
  const folder = chosen ?? working?.path ?? FILES_TOP
  return (
    <FileBrowser
      source={source}
      folder={folder}
      onFolder={(path) => {
        setChosen(path)
        setOpened(null)
      }}
      opened={opened}
      onOpened={setOpened}
      working={working}
      {...(working && onAttach ? { onAttach } : {})}
      tabHref={filesHref}
      {...(beside ? { onOpenTab: (at: string, file: string | null) => openBeside(filesHref(at, file)) } : {})}
    />
  )
}
