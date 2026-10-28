import { Effect } from "effect"
import { isMainThread } from "node:worker_threads"
import type { InstallAssemblyModule } from "../../src/assembler/modules.ts"

export const leaf: InstallAssemblyModule = (a) => {
  if (isMainThread) throw new Error("Planning must run in a worker")
  const original = a.leafPlanners.get("leaf")!
  return a.leafPlanners.register({
    ...original,
    plan: (input) => original.plan(input).map((c) => ({ ...c, target: 37 }))
  })
}
export const maintenance: InstallAssemblyModule = (a) =>
  a.maintenancePlanners.register({
    id: "maintenance",
    plan: () => ({ resummarize: [], condensations: [], flagged: [] })
  })
export const instructions: InstallAssemblyModule = (a) =>
  Effect.gen(function* () {
    yield* a.summaryInstructions.register({ id: "leaf", render: () => "Synthetic leaf instruction: {{words}} words." })
    yield* a.summaryInstructions.register({
      id: "condensation",
      render: () => "Synthetic condensation instruction: {{words}} words."
    })
  })
export const style: InstallAssemblyModule = (a) =>
  a.summaryStyles.register({ id: "settings", select: () => "synthetic" })
export const disableLeaf: InstallAssemblyModule = (a) => a.leafPlanners.disable("leaf")
export const disableInstruction: InstallAssemblyModule = (a) => a.summaryInstructions.disable("leaf")
export const disableStyle: InstallAssemblyModule = (a) => a.summaryStyles.disable("settings")
