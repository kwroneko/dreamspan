import type { DisplayScriptListV1 } from "../../../../plugin-api/src/display.ts"

export const globalDisplayScripts = {
  api: 1,
  id: "display-regex.global",
  order: 10,
  source: import.meta.url,
  scripts: (context) => context.global
} satisfies DisplayScriptListV1
export const presetDisplayScripts = {
  api: 1,
  id: "display-regex.preset",
  order: 20,
  source: import.meta.url,
  scripts: (context) => context.preset
} satisfies DisplayScriptListV1
export const characterDisplayScripts = {
  api: 1,
  id: "display-regex.character",
  order: 30,
  source: import.meta.url,
  scripts: (context) => context.character
} satisfies DisplayScriptListV1
