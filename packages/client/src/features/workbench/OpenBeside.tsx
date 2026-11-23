// "Open beside" for an opener outside a tab (the sidebar's rows and tiles): VS Code's Open to
// the Side. It lives in the shared UI (ui/openBeside.ts), so a link's own context menu offers it
// too; the workbench listens for its event (Workbench.tsx).
export { OPEN_BESIDE, OPEN_BESIDE_HINT, openBeside, useCanOpenBeside } from "../../ui/openBeside.ts"
