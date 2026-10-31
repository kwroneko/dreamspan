import { routes } from "../../routes.tsx"
import { appBanners, appTools } from "../shell.tsx"
import { ImportPage } from "./import.tsx"
import { LibraryPage } from "./list.tsx"
import { registerItemActions } from "./registerItemActions.tsx"
import { stImportSections } from "./slots.ts"
import { StImportPage, stImportSectionEntries } from "./stImport.tsx"
import { StImportIndicator, StImportWatcher } from "./stJobs.tsx"

export const register = () => {
  registerItemActions()
  routes.register({
    id: "library",
    parent: "app",
    path: "/library",
    component: LibraryPage,
    nav: { label: "Library", order: 20 }
  })
  routes.register({
    id: "library.import",
    parent: "app",
    path: "/import",
    component: ImportPage,
    nav: { label: "Import", order: 30 }
  })
  routes.register({
    id: "library.st-import",
    parent: "app",
    path: "/import/st",
    // Reached from the import page; the main navigation has no room on phones.
    component: StImportPage
  })
  // ST imports run on the server: every screen hears about them and says when one runs or ends.
  appTools.register({ id: "library.st-import-watch", order: 20, component: StImportWatcher })
  appBanners.register({ id: "library.st-import-indicator", order: 10, component: StImportIndicator })
  for (const entry of stImportSectionEntries) stImportSections.register(entry)
}
