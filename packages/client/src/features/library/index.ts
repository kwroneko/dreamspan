import { routes } from "../../routes.tsx"
import { ImportPage } from "./import.tsx"
import { LibraryPage } from "./list.tsx"

export const register = () => {
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
}
