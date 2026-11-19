// Measures what a bundled database worker costs in memory, in a process of its own, so the
// rest of a test run can't count toward it (database.test.ts spawns it a few times and takes
// the median). Arguments: data directory, bundle directory, reader count. Prints the RSS
// growth from opening the writer and the readers, per worker, in MB.
import { Effect } from "effect"
import * as Database from "../../src/db/Database.ts"

const [dataDir, bundleDir, readerArg] = process.argv.slice(2)
if (dataDir === undefined || bundleDir === undefined || readerArg === undefined)
  throw new Error("usage: workerMemoryProbe.ts <dataDir> <bundleDir> <readers>")
const readers = Number(readerArg)

const program = Effect.gen(function* () {
  const before = process.memoryUsage().rss
  const perWorkerMb = yield* Effect.scoped(
    Effect.gen(function* () {
      const reader = yield* Database.Reader
      // Touch every reader so all of them have loaded and opened their connection.
      yield* Effect.forEach(Array.from({ length: readers * 4 }), () => reader.FindUserByHandle({ handle: "nobody" }), {
        concurrency: "unbounded"
      })
      yield* Effect.sleep(500)
      return (process.memoryUsage().rss - before) / 1048576 / (readers + 1)
    }).pipe(Effect.provide(Database.layer({ dataDir, readers, allowNetworkFs: false, workers: "bundle", bundleDir })))
  )
  process.stdout.write(`${perWorkerMb}\n`)
})

Effect.runPromise(program).then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${String(error)}\n`)
    process.exit(1)
  }
)
