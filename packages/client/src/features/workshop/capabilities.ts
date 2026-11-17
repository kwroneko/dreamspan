// Presentation of the server-owned capability list (spec/WORKSHOP.md §3.4): how each stands in
// this workshop, the choices it offers, and the chip's words.
import { Atom } from "effect/reactivity"
import type { ChatId } from "@rp/shared/chat.ts"
import type { CapabilityMode, WorkshopCapability, WorkshopGrantChoice } from "@rp/shared/workshopApi.ts"
import { AppClient } from "../../rpc.ts"

export type { WorkshopCapability } from "@rp/shared/workshopApi.ts"

/** What the server's answers and grants invalidate. */
export const CAPABILITIES_KEY = "workshop-capabilities"

export const capabilitiesAtom = Atom.family((chatId: ChatId) =>
  AppClient.query("ListWorkshopCapabilities", { chatId }, { reactivityKeys: [CAPABILITIES_KEY, chatId] })
)

const modeLabel: Record<CapabilityMode, string> = { off: "Off", ask: "Ask first", allow: "Allowed" }

/** Each choice's hover explanation. */
const modeDescription: Record<CapabilityMode, string> = {
  off: "The assistant can't do this here. It's told so, and doesn't try.",
  ask: "The assistant asks you each time, showing what it will do, before it does it.",
  allow: "The assistant does this without asking. Each change can be undone from its step or Changes."
}

/**
 * An MCP server's row (spec/MCP.md §13.3) says On rather than Allowed: there's no asking, and
 * what it allows is the server's allowed tools.
 */
export const modeLabelOf = (capability: WorkshopCapability, mode: CapabilityMode) =>
  capability.target !== undefined && mode === "allow" ? "On" : modeLabel[mode]

export const modeDescriptionOf = (capability: WorkshopCapability, mode: CapabilityMode) =>
  capability.target === undefined
    ? modeDescription[mode]
    : mode === "allow"
      ? "The assistant may use its allowed tools here without asking."
      : "The assistant can't use it here."

/** The choices in the order the row shows them: Off, Ask first, Allowed. */
const modeOrder: ReadonlyArray<CapabilityMode> = ["off", "ask", "allow"]
export const choicesOf = (capability: WorkshopCapability) => modeOrder.filter((m) => capability.modes.includes(m))

export const modeText = (capability: WorkshopCapability) =>
  capability.always ? "Always allowed" : modeLabelOf(capability, capability.mode)

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

/**
 * What a workshop not made yet would offer (`ListNewWorkshopCapabilities`): one beside the story
 * `attachTo`, or ("") one of its own. Its composer's chip lists them before the first send.
 */
export const newCapabilitiesAtom = Atom.family((attachTo: string) =>
  AppClient.query("ListNewWorkshopCapabilities", attachTo === "" ? {} : { attachTo: attachTo as ChatId }, {
    reactivityKeys: [CAPABILITIES_KEY, `new:${attachTo}`]
  })
)

/** Grants chosen before the first send, by capability and target (`grantKey`), as `CreateWorkshop` takes them. */
export type PendingGrants = ReadonlyMap<string, WorkshopGrantChoice>

/** One row's key: its capability and, for an MCP server, its target. */
export const grantKey = (capability: string, target?: string) => JSON.stringify([capability, target ?? ""])

/** A choice on a row before the first send: its mode, or null for the default. */
export const choosePending = (
  grants: PendingGrants,
  capability: WorkshopCapability,
  mode: CapabilityMode | null
): PendingGrants => {
  const next = new Map(grants)
  next.set(grantKey(capability.id, capability.target), {
    capability: capability.id,
    mode,
    ...(capability.target === undefined ? {} : { target: capability.target })
  })
  return next
}

/** The rows as they'll stand once made: the server's, with the choices made before the first send. */
export const withPendingGrants = (
  capabilities: ReadonlyArray<WorkshopCapability>,
  grants: PendingGrants
): ReadonlyArray<WorkshopCapability> =>
  grants.size === 0
    ? capabilities
    : capabilities.map((capability) => {
        const choice = grants.get(grantKey(capability.id, capability.target))
        if (choice === undefined) return capability
        return choice.mode === null
          ? { ...capability, mode: capability.defaultMode, chosen: false }
          : { ...capability, mode: choice.mode, chosen: true }
      })
