import { defineSlot } from "../../slots.tsx"
import type { ShellLibrary } from "./shellData.tsx"

/** Above the home screen's characters: getting started, announcements. */
export const homeIntro = defineSlot<{ data: ShellLibrary }>("home.intro")
