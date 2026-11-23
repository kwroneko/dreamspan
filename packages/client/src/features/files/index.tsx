// Files in the client (spec/FILES-AND-ENVIRONMENT.md §8, track B1), registered as a plugin would:
// the store it reads (`filesSources`), the viewers (`fileViewers`), the workshop's Files tab before
// Changes, the Files page (reached from that tab and by its URL, not from the main navigation),
// and its workbench tabs (the browser one tab, each opened file a tab of its own).
import { routes } from "../../routes.tsx"
import { kindShows } from "../chat/kindLooks.ts"
import { chatPanels, lazyPanel, type PanelProps } from "../chat/panels.tsx"
import { tabKinds } from "../workbench/kinds.ts"
import { FilesPage } from "./FilesPage.tsx"
import { FILES_PAGE, filesHref } from "./href.ts"
import { FILES_TAB, FOLDER_CHIP } from "./ids.ts"
import { composerControls } from "../chat/composerControls.tsx"
import { FolderChip, useFolderChoices } from "./FolderChip.tsx"
import { workingFolderSources } from "./working.ts"
import { ATTACHMENTS_FOLDER, FILES_TOP, joinPath, nameOf, parentOf } from "@dreamspan/shared/files.ts"
import { fileAttachments } from "../chat/fileAttachments.ts"
import { userNoticeReceivers } from "../noticeContributions.tsx"
import { filesNoticeReceiver } from "./live.ts"
import { filesSources, httpFilesSource, useFilesSource } from "./source.ts"
import { AttachmentViewer, registerViewers, viewerFor } from "./viewers.tsx"

/** A file of Files shown where it is: its folder in the Files page, with it open. */
const showInFiles = (path: string) => filesHref(parentOf(path), nameOf(path))

export const register = () => [
  filesSources.register(httpFilesSource),
  userNoticeReceivers.register(filesNoticeReceiver),
  // The working-folder chip after Model and Preset, before the next request's size and cache (§2.2), workshops only.
  composerControls.register({
    id: FOLDER_CHIP,
    order: 35,
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
  // Attachments of any type in workshops (§6.1): saved in the working folder's Attachments folder
  // and attached by their path; a file of Files attached as it is.
  fileAttachments.register({
    id: "files.attachments",
    useFileAttacher: (session, view) => {
      const shows = kindShows(view.chat?.kind, FOLDER_CHIP)
      const folder = useFolderChoices(session, shows)
      const source = useFilesSource()
      if (!shows || !source) return null
      if (!folder.ready) return "loading"
      const target = joinPath(folder.choices?.current ?? FILES_TOP, ATTACHMENTS_FOLDER)
      return {
        folder: target,
        upload: async (file, name) => source.attach((await source.upload(joinPath(target, name), file, "keep")).path),
        attach: source.attach,
        copyUrl: source.attachmentUrl,
        showHref: showInFiles
      }
    },
    copyUrl: httpFilesSource.attachmentUrl,
    showHref: showInFiles,
    opens: (name: string) => viewerFor(name) !== null,
    Viewer: AttachmentViewer
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
