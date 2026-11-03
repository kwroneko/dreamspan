import type { Extension } from "@codemirror/state"
import { makeRegistry } from "../registry.ts"

/** Replaceable CodeMirror contributions, including prompt macro highlighting. */
export const editorExtensions = makeRegistry<{ readonly id: string; readonly load: () => Promise<Extension> }>()
