import { routes } from "../../routes.tsx"
import { BinCapacity } from "./BinCapacity.tsx"
import { binSettings } from "./BinPage.tsx"
import { BinPage } from "./BinPage.tsx"

// Linked from the header beside the account (shell.tsx), since the main navigation has no
// room on phones; every delete's toast leads here too.
export const register = () => {
  binSettings.register({ id: "bin.capacity", order: 10, component: BinCapacity })
  routes.register({ id: "bin", parent: "app", path: "/bin", component: BinPage })
}
