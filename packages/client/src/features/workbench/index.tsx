// The center column's frames and tabs (owner, 2026-11-05; DESIGN §10.1), registered as the
// shell's center column, with the split buttons at the end of every center header.
import { CARD_DRAG, CHAT_DRAG, dragPayloads, PICTURE_DRAG } from "../../ui/appDrags.ts"
import { centerHeaderEnd } from "../../ui/CenterHeader.tsx"
import { centerColumn } from "../shell.tsx"
import { tabKinds } from "./kinds.ts"
import { SplitButtons, Workbench } from "./Workbench.tsx"
import { layoutParams } from "../../tabLayoutParams.ts"
import { WORKBENCH_PARAM } from "./layoutParam.ts"

export const register = () => [
  // The frames and tabs: the browser tab's layout, in its URL (layoutParam.ts).
  layoutParams.register({ id: "workbench.frames", keys: [WORKBENCH_PARAM] }),
  centerColumn.register({ id: "workbench", order: 10, component: Workbench }),
  centerHeaderEnd.register({ id: "workbench.split", order: 10, component: SplitButtons }),
  // What a frame opens when it's dropped there (owner, 2026-11-07): a portrait's picture, a
  // character's full-size editor, a chat. A plugin registers its own kind beside them.
  dragPayloads.register(PICTURE_DRAG),
  dragPayloads.register(CARD_DRAG),
  dragPayloads.register(CHAT_DRAG),
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
