import { routes } from "../../routes.tsx"
import { ImportPage } from "./import.tsx"
import { LibraryPage } from "./list.tsx"
import { registerItemActions } from "./registerItemActions.tsx"
import { StImportPage } from "./stImport.tsx"

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
}
