// Auto replies (DESIGN §2.3): two composer controls, registered like a plugin's, so either can
// be replaced or removed: the strip's chip that opens the dialog, and the run's row above the box.
import { composerControls } from "../chat/composerControls.tsx"
import { AutoRunChip, AutoRunRow } from "./AutoRun.tsx"
import { runStoreOf } from "./run.ts"

export const register = () => [
  composerControls.register({
    id: "composer.auto",
    order: 55,
    placement: "strip",
    // A group's control: with one character there is no one to take turns with.
    available: ({ reply, session }) => reply.candidates.length >= 2 || runStoreOf(session).get() !== null,
    component: AutoRunChip
  }),
  composerControls.register({ id: "composer.auto-run", order: 25, placement: "queue", component: AutoRunRow })
]
