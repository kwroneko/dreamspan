// Presentation of the server-owned capability list; grants and choices belong to W4.
import { Atom } from "effect/reactivity"
import type { ChatId } from "@rp/shared/chat.ts"
import type { WorkshopCapability } from "@rp/shared/workshopApi.ts"
import { AppClient } from "../../rpc.ts"

export type { WorkshopCapability } from "@rp/shared/workshopApi.ts"

export const capabilitiesAtom = Atom.family((chatId: ChatId) =>
  AppClient.query("ListWorkshopCapabilities", { chatId }, { reactivityKeys: ["workshop-capabilities", chatId] })
)

export const modeText = (capability: WorkshopCapability) =>
  capability.always ? "Always allowed" : { allow: "Allowed", ask: "Asks first", off: "Off" }[capability.mode]

/** The chip's text: "Can: 6 · Asks: 2", leaving out a count of none. */
export const chipText = (capabilities: ReadonlyArray<WorkshopCapability>) => {
  const can = capabilities.filter((c) => c.mode === "allow").length
  const asks = capabilities.filter((c) => c.mode === "ask").length
  return [`Can: ${can}`, ...(asks > 0 ? [`Asks: ${asks}`] : [])].join(" · ")
}

/** The chip's accessible name, in words. */
export const chipLabel = (capabilities: ReadonlyArray<WorkshopCapability>) => {
  const can = capabilities.filter((c) => c.mode === "allow").length
  const asks = capabilities.filter((c) => c.mode === "ask").length
  return `What the assistant may do: ${can} allowed${asks > 0 ? `, ${asks} asking first` : ""}`
}
