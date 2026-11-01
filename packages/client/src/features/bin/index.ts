import { routes } from "../../routes.tsx"
import { AffectedBranches } from "./AffectedBranches.tsx"
import { BinCapacity } from "./BinCapacity.tsx"
import { binPurgeBranches, binSettings } from "./BinPage.tsx"
import { BinPage } from "./BinPage.tsx"

// Linked from the header beside the account (shell.tsx), since the main navigation has no
// room on phones; every delete's toast leads here too.
export const register = () => {
  binSettings.register({ id: "bin.capacity", order: 10, component: BinCapacity })
  binPurgeBranches.register({ id: "bin.affected-branches", order: 10, component: AffectedBranches })
  routes.register({ id: "bin", parent: "app", path: "/bin", component: BinPage })
}
