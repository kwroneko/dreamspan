/** Per-kind planning and tool policy, replaceable through ExecutionRegistry. */
export interface ChatKindProfile {
  readonly id: string
  readonly planner: string
  readonly allowsOutside: boolean
}

export const builtinChatKinds: ReadonlyArray<ChatKindProfile> = [
  { id: "rp", planner: "default", allowsOutside: false },
  { id: "workshop", planner: "workshop", allowsOutside: true }
]
