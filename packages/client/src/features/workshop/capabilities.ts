// Presentation of the server-owned capability list (spec/WORKSHOP.md §3.4): how each stands in
// this workshop, the choices it offers, and the chip's words.
import { Atom } from "effect/reactivity"
import type { ChatId } from "@rp/shared/chat.ts"
import type { CapabilityMode, WorkshopCapability } from "@rp/shared/workshopApi.ts"
import { AppClient } from "../../rpc.ts"

export type { WorkshopCapability } from "@rp/shared/workshopApi.ts"

/** What the server's answers and grants invalidate. */
export const CAPABILITIES_KEY = "workshop-capabilities"

export const capabilitiesAtom = Atom.family((chatId: ChatId) =>
  AppClient.query("ListWorkshopCapabilities", { chatId }, { reactivityKeys: [CAPABILITIES_KEY, chatId] })
)

export const modeLabel: Record<CapabilityMode, string> = { off: "Off", ask: "Ask first", allow: "Allowed" }

/** Each choice's hover explanation. */
export const modeDescription: Record<CapabilityMode, string> = {
  off: "The assistant can't do this here. It's told so, and doesn't try.",
  ask: "The assistant asks you each time, showing what it will do, before it does it.",
  allow: "The assistant does this without asking. Each change can be undone from its step or Changes."
}

/** The choices in the order the row shows them: Off, Ask first, Allowed. */
const modeOrder: ReadonlyArray<CapabilityMode> = ["off", "ask", "allow"]
export const choicesOf = (capability: WorkshopCapability) => modeOrder.filter((m) => capability.modes.includes(m))

export const modeText = (capability: WorkshopCapability) =>
  capability.always ? "Always allowed" : modeLabel[capability.mode]

/** The chip's text: "Can: 6 · Asks: 2 · Off: 1", leaving out a count of none. */
export const chipText = (capabilities: ReadonlyArray<WorkshopCapability>) => {
  const can = capabilities.filter((c) => c.mode === "allow").length
  const asks = capabilities.filter((c) => c.mode === "ask").length
  const off = capabilities.filter((c) => c.mode === "off").length
  return [`Can: ${can}`, ...(asks > 0 ? [`Asks: ${asks}`] : []), ...(off > 0 ? [`Off: ${off}`] : [])].join(" · ")
}

/** The chip's accessible name, in words. */
export const chipLabel = (capabilities: ReadonlyArray<WorkshopCapability>) => {
  const can = capabilities.filter((c) => c.mode === "allow").length
  const asks = capabilities.filter((c) => c.mode === "ask").length
  const off = capabilities.filter((c) => c.mode === "off").length
  return `What the assistant may do: ${can} allowed${asks > 0 ? `, ${asks} asking first` : ""}${off > 0 ? `, ${off} off` : ""}`
}
