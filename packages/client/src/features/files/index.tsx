// Files in the client (spec/FILES-AND-ENVIRONMENT.md §8, track B1), registered as a plugin would:
// the store it reads (`filesSources`), the viewers (`fileViewers`), the workshop's Files tab before
// Changes, the Files page (reached from that tab and by its URL, not from the main navigation),
// and its workbench tabs (the browser one tab, each opened file a tab of its own).
import { routes } from "../../routes.tsx"
import { kindShows } from "../chat/kindLooks.ts"
import { chatPanels, lazyPanel, type PanelProps } from "../chat/panels.tsx"
import { tabKinds } from "../workbench/kinds.ts"
import { FilesPage } from "./FilesPage.tsx"
import { FILES_PAGE } from "./href.ts"
import { FILES_TAB, FOLDER_CHIP } from "./ids.ts"
import { composerControls } from "../chat/composerControls.tsx"
import { FolderChip, useFolderChoices } from "./FolderChip.tsx"
import { workingFolderSources } from "./working.ts"
import { FILES_TOP } from "@dreamspan/shared/files.ts"
import { userNoticeReceivers } from "../noticeContributions.tsx"
import { filesNoticeReceiver } from "./live.ts"
import { filesSources, httpFilesSource } from "./source.ts"
import { registerViewers } from "./viewers.tsx"

export const register = () => [
  filesSources.register(httpFilesSource),
  userNoticeReceivers.register(filesNoticeReceiver),
  // The working-folder chip after Model and Preset, before the cache chip (§2.2), workshops only.
  composerControls.register({
    id: FOLDER_CHIP,
    order: 25,
    placement: "strip",
    available: ({ view }) => kindShows(view.chat?.kind, FOLDER_CHIP),
    component: FolderChip
  }),
  // The Files tab opens at the branch's working folder and offers Set as working folder.
  workingFolderSources.register({
    id: "files.working",
    useWorkingFolder: (session, view) => {
      const shows = kindShows(view.chat?.kind, FOLDER_CHIP)
      const folder = useFolderChoices(session, shows)
      if (!shows || !folder.ready) return null
      return { path: folder.choices?.current ?? FILES_TOP, set: folder.choose }
    }
  }),
  ...registerViewers(),
  chatPanels.register({
    id: FILES_TAB,
    label: "Files",
    description: "Your files: the folder the assistant works in, uploads, and what it made.",
    order: 90,
    icon: "folder",
    savedOnly: true,
    available: (view) => kindShows(view.chat?.kind, FILES_TAB),
    component: lazyPanel(
      () =>
        import("./FilesPanel.tsx").then((m) => ({
          default: (props: PanelProps) => <m.FilesPanel session={props.session} view={props.view} />
        })),
      "files"
    )
  }),
  routes.register({
    id: "files",
    parent: "app",
    path: FILES_PAGE,
    component: FilesPage
  }),
  tabKinds.register({
    id: "files",
    order: 800,
    match: (url) => (url.pathname === FILES_PAGE ? (url.searchParams.get("file") === null ? "" : url.search) : null),
    title: (url) => url.searchParams.get("file") ?? "Files",
    icon: "folder"
  })
]
