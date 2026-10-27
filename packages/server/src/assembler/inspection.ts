// The entire historical display is scrubbed on the main thread, with the effective request inventory.
import type { ContextSource, SourceActivation } from "@rp/shared/inspectorApi.ts"
import type { AssembledRequest, InspectionInputs, WireContext } from "./types.ts"

const activationOf = (
  activation: SourceActivation | null,
  scrub: (text: string) => string
): SourceActivation | null => {
  if (!activation) return activation
  if (activation.kind === "note")
    return activation.condition === undefined ? activation : { ...activation, condition: scrub(activation.condition) }
  if (activation.status === "skipped") return { ...activation, reason: scrub(activation.reason) }
  return {
    ...activation,
    why:
      activation.why.kind === "constant" || activation.why.kind === "pinned"
        ? activation.why
        : {
            ...activation.why,
            primaryKey: scrub(activation.why.primaryKey),
            secondaryKeys: activation.why.secondaryKeys.map(scrub),
            ...(activation.why.notes ? { notes: activation.why.notes.map(scrub) } : {})
          }
  }
}

export const inspectWire = (
  wire: WireContext,
  request: AssembledRequest,
  input: InspectionInputs,
  scrub: (text: string) => string
): WireContext => {
  const breakpoints = new Map(request.breakpoints.map((b) => [b.message, b.reason]))
  const prefill: ContextSource = { id: "prefill", kind: "preset", label: "Prefill", slotId: null, activation: null }
  return {
    ...wire,
    display: {
      model: input.model && {
        ...input.model,
        connection: scrub(input.model.connection),
        model: scrub(input.model.model),
        kind: scrub(input.model.kind)
      },
      preset: {
        ...input.preset,
        label: input.preset.label === null ? null : scrub(input.preset.label),
        scope: scrub(input.preset.scope)
      },
      issues: input.issues.map((issue) => ({ ...issue, message: scrub(issue.message) }))
    },
    messages: wire.messages.map((message) => ({
      ...message,
      sources: message.inputs
        .flatMap((i) => input.sources[i] ?? [prefill])
        .filter((source, i, all) => all.findIndex((s) => s.id === source.id) === i)
        .map((source) => ({
          ...source,
          label: scrub(source.label),
          activation: activationOf(source.activation, scrub)
        })),
      breakpoint: message.inputs.map((i) => breakpoints.get(i)).findLast((b) => b !== undefined) ?? null
    }))
  }
}
