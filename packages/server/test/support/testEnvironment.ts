// Unlike suite hooks, environment teardown also runs for wholly skipped files and
// collection failures. Only directories explicitly owned by tempDir() are removed.
import { builtinEnvironments, type Environment } from "vitest/runtime"
import { cleanupTempDirs } from "./tempDirCleanup.ts"

export default {
  ...builtinEnvironments.node,
  async setupVM(options) {
    const environment = await builtinEnvironments.node.setupVM!(options)
    return {
      getVmContext: () => environment.getVmContext(),
      async teardown() {
        try {
          cleanupTempDirs(environment.getVmContext())
        } finally {
          await environment.teardown()
        }
      }
    }
  },
  async setup(global, options) {
    const environment = await builtinEnvironments.node.setup(global, options)
    return {
      async teardown() {
        try {
          cleanupTempDirs(global)
        } finally {
          await environment.teardown(global)
        }
      }
    }
  }
} satisfies Environment
