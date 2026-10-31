// Worker entry points for tests: the bundles this run built (globalSetup.ts), never `dist/`.
// A bundled worker starts in about a fifth of the CPU time a source one takes, which loads
// Effect's module graph through the type stripper. Tests of the source entry points
// (database.test.ts, formatWorkers.test.ts, and those that compare both) ask for source.
// TEST_DB_WORKERS=source runs every other test on the source entry points too.
import { Layer } from "effect"
import { inject } from "vitest"
import { WorkerBundleDir } from "../../src/db/Database.ts"
// Declares the provided `bundleDir`, for projects that include this file and not the setup.
import type {} from "./globalSetup.ts"

/** The workers tests run when they don't ask for either: TEST_DB_WORKERS, or the bundles. */
export const testWorkerMode = process.env.TEST_DB_WORKERS === "source" ? "source" : "bundle"

/** Options for `Database.layer` and `Formats.layer`. */
export const testWorkers =
  testWorkerMode === "source"
    ? ({ workers: "source" } as const)
    : ({ workers: "bundle", bundleDir: inject("bundleDir") } as const)

/** Where bundled workers come from when the options name no directory, as in the test server. */
export const testBundles = Layer.succeed(WorkerBundleDir)(inject("bundleDir"))
