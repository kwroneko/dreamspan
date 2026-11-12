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
    exportFormats: ["jsonl", "txt"]
  },
  {
    id: "workshop",
    planner: "workshop",
    allowsOutside: true,
    rolloutKind: "workshop",
    purpose: "workshop",
    allowsSummaries: false,
    allowsMerge: false,
    allowsStImport: false,
    exportFormats: ["txt"]
  }
])
