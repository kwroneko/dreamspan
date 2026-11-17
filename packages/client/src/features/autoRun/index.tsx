// Auto replies (DESIGN §2.3): two parts, registered like a plugin's, so either can be replaced
// or removed: the Cast tab's Auto replies beside One reply at a time (owner, 2026-11-17: not in
// the composer), and the run's row above the box, which shows the dialog and drives the run.
import { castSections } from "../chat/presentation.tsx"
import { composerControls } from "../chat/composerControls.tsx"
import { AutoRunEntry, AutoRunRow } from "./AutoRun.tsx"

export const register = () => [
  castSections.register({ id: "cast.auto-replies", order: 7, component: AutoRunEntry }),
  composerControls.register({ id: "composer.auto-run", order: 25, placement: "queue", component: AutoRunRow })
]
