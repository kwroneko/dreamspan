import type { Snippet } from "@rp/shared/snippetsApi.ts"
import { defineSlot } from "../../slots.tsx"
import type { SnippetWorkspace } from "./workspace.ts"

/** Actions beside the selected snippet's text: history, delete, or a plugin's own. */
export const snippetTools = defineSlot<{ store: SnippetWorkspace; item: Snippet }>("snippets.tools")
