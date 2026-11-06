// The center column's frames and tabs (owner, 2026-11-05; DESIGN §10.1), registered as the
// shell's center column, with the split buttons at the end of every center header.
import { centerHeaderEnd } from "../../ui/CenterHeader.tsx"
import { centerColumn } from "../shell.tsx"
import { tabKinds } from "./kinds.ts"
import { SplitButtons, Workbench } from "./Workbench.tsx"

export const register = () => [
  centerColumn.register({ id: "workbench", order: 10, component: Workbench }),
  centerHeaderEnd.register({ id: "workbench.split", order: 10, component: SplitButtons }),
  // Pages without a kind of their own are one tab per path; these name theirs.
  tabKinds.register({
    id: "home",
    order: 900,
    match: (url) => (url.pathname === "/" ? "" : null),
    title: () => "Home",
    icon: "home"
  }),
  tabKinds.register({
    id: "settings",
    order: 900,
    match: (url) => (url.pathname === "/settings" || url.pathname.startsWith("/settings/") ? "" : null),
    title: () => "Settings",
    icon: "sliders"
  }),
  tabKinds.register({
    id: "bin",
    order: 900,
    match: (url) => (url.pathname === "/bin" ? "" : null),
    title: () => "Bin",
    icon: "trash"
  }),
  tabKinds.register({
    id: "import",
    order: 900,
    match: (url) => (url.pathname === "/import" || url.pathname.startsWith("/import/") ? "" : null),
    title: () => "Import",
    icon: "download"
  }),
  // A login page is never a tab to come back to.
  tabKinds.register({
    id: "login",
    order: 0,
    match: (url) => (url.pathname === "/login" ? "" : null),
    persist: () => null
  })
]
