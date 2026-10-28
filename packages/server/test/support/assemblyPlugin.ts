// Synthetic trusted plugin, installed into each reader's assembler for one request.
import { isMainThread } from "node:worker_threads"
import type { InstallAssemblyModule } from "../../src/assembler/modules.ts"

export const install: InstallAssemblyModule = (assembler) => {
  if (isMainThread) throw new Error("assembly plugin ran on the main thread")
  return assembler.projections.register({
    id: "plugin/all_user",
    label: "Plugin roles",
    description: "Synthetic role projection",
    role: () => "user"
  })
}

export const disableWriter: InstallAssemblyModule = (assembler) => assembler.projections.disable("by_writer")

export const overrideWriter: InstallAssemblyModule = (assembler) =>
  assembler.projections.register({
    id: "by_writer",
    label: "Plugin writer",
    role: () => "user"
  })
