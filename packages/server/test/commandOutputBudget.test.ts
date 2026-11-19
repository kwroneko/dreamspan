// Commands' kept output (spec/FILES-AND-ENVIRONMENT.md §5.1) counts in the account's Files quota
// and shows in its usage, and nothing more is kept while the data folder's disk is below the
// commands' reserve (files4a review, finding 3). Synthetic data only.
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeCommandOutputs } from "../src/files/commandOutput.ts"
import { makeFilesQuota } from "../src/files/quota.ts"
import { tempDir } from "./support/tempDir.ts"

it.live("counts kept command output in the account's usage", () =>
  Effect.gen(function* () {
    const root = tempDir("outquota")
    yield* Effect.promise(async () => {
      await mkdir(join(root, "files"), { recursive: true })
      await mkdir(join(root, "out"), { recursive: true })
      await writeFile(join(root, "out", "cmd_0000000000000001.log"), Buffer.alloc(300_000, 1))
    })
    const quota = makeFilesQuota({
      reader: { GetAppSetting: () => Effect.succeed(null), FileVersionBytes: () => Effect.succeed(0) } as never,
      writer: { PruneFileVersions: () => Effect.succeed({ versions: 0, attachments: 0, media: 0 }) } as never,
      folders: () => ({ filesRoot: join(root, "files"), home: join(root, "home"), output: join(root, "out") }),
      defaultBytes: 200_000
    })
    const usage = yield* quota.measure("u")
    assert.isAtLeast(usage.outputBytes, 300_000)
    assert.isAtLeast(usage.usedBytes, 300_000)
    // Output past the quota refuses the next command, like files do.
    const refused = yield* Effect.exit(quota.check("u", 0, "run commands"))
    assert.strictEqual(refused._tag, "Failure")
  })
)

it.live("keeps nothing while the disk is below the reserve, and stops keeping when it goes below", () =>
  Effect.promise(async () => {
    const dataDir = tempDir("outreserve")
    let free = 10
    const outputs = makeCommandOutputs(dataDir, { reserveBytes: 100, freeBytes: async () => free })
    // Low from the start: nothing kept.
    const low = await outputs.open("u")
    low.write(Buffer.from("hello\n"))
    await low.end(6)
    const lowPage = await outputs.page("u", low.id, 1, 10)
    assert.deepStrictEqual(lowPage?.lines, [])
    assert.isTrue(lowPage?.cut)
    // Room at the start; the disk goes low while it writes: what follows isn't kept.
    free = 1000
    const sink = await outputs.open("u")
    const chunk = Buffer.alloc(512 * 1024, 97)
    sink.write(chunk)
    sink.write(chunk)
    free = 10
    for (let i = 0; i < 8; i++) sink.write(chunk)
    await sink.end(10 * chunk.length)
    const page = await outputs.page("u", sink.id, 1, 1)
    assert.isTrue(page?.cut)
    assert.isBelow(page!.bytes, 4 * chunk.length)
  })
)
