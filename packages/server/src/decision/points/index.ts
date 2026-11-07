// The built-in decision points, registered by the engine as a plugin's would be.
import type { AnyDecisionPoint } from "../engine.ts"
import { lorePoint } from "./lore.ts"
import { nextPoint } from "./next.ts"
import { presencePoint } from "./presence.ts"

export const builtinPoints: ReadonlyArray<AnyDecisionPoint> = [lorePoint, presencePoint, nextPoint]
