import { routes } from "../../routes.tsx"
import { BinPage } from "./BinPage.tsx"

// Linked from the header beside the account (shell.tsx), since the main navigation has no
// room on phones; every delete's toast leads here too.
export const register = () => {
  routes.register({ id: "bin", parent: "app", path: "/bin", component: BinPage })
}
