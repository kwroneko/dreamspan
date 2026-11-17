// Files in the client (spec/FILES-AND-ENVIRONMENT.md §8, track B1), registered as a plugin would:
// the store it reads (`filesSources`), the viewers (`fileViewers`), the workshop's Files tab before
// Changes, the Files page in the main navigation, and its workbench tabs (the browser one tab,
// each opened file a tab of its own).
import { routes } from "../../routes.tsx"
import { kindShows } from "../chat/kindLooks.ts"
import { chatPanels, lazyPanel, type PanelProps } from "../chat/panels.tsx"
import { tabKinds } from "../workbench/kinds.ts"
import { FilesPage } from "./FilesPage.tsx"
import { FILES_PAGE } from "./href.ts"
import { FILES_TAB } from "./ids.ts"
import { filesSources, httpFilesSource } from "./source.ts"
import { registerViewers } from "./viewers.tsx"

export const register = () => [
  filesSources.register(httpFilesSource),
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
    component: FilesPage,
    nav: { label: "Files", icon: "folder", description: "Your files, and what the assistant made.", order: 25 }
  }),
  tabKinds.register({
    id: "files",
    order: 800,
    match: (url) => (url.pathname === FILES_PAGE ? (url.searchParams.get("file") === null ? "" : url.search) : null),
    title: (url) => url.searchParams.get("file") ?? "Files",
    icon: "folder"
  })
]
