// What the workshop's assistant may do, as its capability chip lists it (spec/WORKSHOP.md §3.1).
// A registry, so the setup tools add theirs as they arrive and a plugin can add its own. Until
// choosing is built (W4) each says only how it stands.
import { makeRegistry } from "../../registry.ts"

type CapabilityMode = "allow" | "ask" | "off"

export interface WorkshopCapability {
  readonly id: string
  readonly order: number
  /** Short: "Read your library". */
  readonly label: string
  /** One line: what it lets the assistant do. */
  readonly explanation: string
  readonly mode: CapabilityMode
  /** Can't be turned off: the assistant is no use without it. */
  readonly always?: boolean
}

export const workshopCapabilities = makeRegistry<WorkshopCapability>()

export const registerCapabilities = () => [
  workshopCapabilities.register({
    id: "library.read",
    order: 10,
    label: "Read your library",
    explanation: "Looks up your cards, presets and lorebooks.",
    mode: "allow",
    always: true
  })
]

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
