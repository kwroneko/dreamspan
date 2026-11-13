// Kind profiles are shared data; plugins install scoped registrations in each runtime.
import { makeRegistry } from "./registry.ts"

export interface ChatKindProfile {
  readonly id: string
  readonly planner: string
  readonly allowsOutside: boolean
  readonly rolloutKind: "generation" | "workshop"
  readonly purpose: "generation" | "workshop"
  readonly allowsSummaries: boolean
  readonly allowsMerge: boolean
  readonly allowsStImport: boolean
  readonly exportFormats: ReadonlyArray<"txt" | "jsonl">
  /** A workshop may be attached to a chat of this kind, to talk about it beside it (spec/WORKSHOP.md §4). */
  readonly allowsSideChat?: boolean
}

export const chatKinds = makeRegistry<ChatKindProfile>([
  {
    id: "rp",
    planner: "default",
    allowsOutside: false,
    rolloutKind: "generation",
    purpose: "generation",
    allowsSummaries: true,
    allowsMerge: true,
    allowsStImport: true,
    exportFormats: ["jsonl", "txt"],
    allowsSideChat: true
  },
  {
    id: "workshop",
    planner: "workshop",
    allowsOutside: true,
    rolloutKind: "workshop",
    purpose: "workshop",
    // Summaries cover a long workshop's messages (spec/WORKSHOP-CONTEXT.md §2.4).
    allowsSummaries: true,
    allowsMerge: false,
    allowsStImport: false,
    exportFormats: ["txt"]
  }
])
