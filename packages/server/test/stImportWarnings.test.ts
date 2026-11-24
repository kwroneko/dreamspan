// Import advisories describe the ended run, never the incomplete folder. All files here
// are synthetic; controlled uploads pause before the selected preset and before finishing.
import { assert, describe, it } from "@effect/vitest"
import { classifyStPath } from "@dreamspan/shared/stFolder.ts"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { slowIt } from "./support/slow.ts"
import { stFolder } from "./support/stFolder.ts"
import { sendStFile } from "./support/stUpload.ts"

describe("ST import warning timing", () => {
  slowIt.live(
    "withholds advisories in live and checkpoint reports until a late selected preset arrives",
    () =>
      Effect.gen(function* () {
        const api = yield* client()
        const files = stFolder()
        const preset = "OpenAI Settings/Default.json"
        const { importId } = yield* api.StartStImport({ unsupported: ["TextGen Settings/Unused.json"] })
        yield* sendStFile(importId, "settings.json", files.get("settings.json")!)
        assert.isEmpty((yield* api.GetStImportReport({ importId })).issues)

        // Let the normal 15-second checkpoint interval elapse, then trigger a progress
        // write with a real parse error. Errors remain visible during the import.
        yield* Effect.sleep(15_100)
        assert.strictEqual(
          (yield* sendStFile(importId, "OpenAI Settings/Broken.json", new TextEncoder().encode("{"))).outcome,
          "failed"
        )
        const user = yield* api.Whoami()
        const checkpoint = yield* (yield* Reader).GetStImportJob({ userId: user.id, id: importId })
        assert.include(checkpoint.reportJson!, "st.preset_missing")
        assert.include(checkpoint.reportJson!, "st.global_world_missing")
        const running = yield* api.GetStImport({ importId })
        assert.strictEqual(running.job.status, "running")
        assert.isAbove(running.report!.issues.length, 0)
        assert.isTrue(running.report!.issues.every((issue) => issue.level === "error"))
        assert.isEmpty(running.report!.unsupported)

        // Import the other files before the selected preset. An unmatched chat and
        // unattached global lorebook must not become premature notices either.
        for (const [path, bytes] of files) {
          const kind = classifyStPath(path)?.kind
          if (path === "settings.json" || path === preset || kind === undefined || kind === "unsupported") continue
          yield* sendStFile(importId, path, bytes)
          const partial = yield* api.GetStImportReport({ importId })
          assert.isTrue(
            partial.issues.every((issue) => issue.level === "error"),
            path
          )
          assert.isEmpty(partial.links, path)
          assert.isEmpty(partial.hiddenRuns, path)
        }
        assert.strictEqual((yield* sendStFile(importId, preset, files.get(preset)!)).outcome, "added")
        assert.isFalse((yield* api.GetStImportReport({ importId })).issues.some((i) => i.code === "st.preset_missing"))
        yield* api.FinishStImport({ importId, notSent: [] })
        const done = yield* api.GetStImport({ importId })
        assert.strictEqual(done.job.status, "complete")
        for (const report of [done.report!, yield* api.GetStImportReport({ importId })]) {
          assert.isFalse(report.issues.some((i) => i.code === "st.preset_missing"))
          assert.isFalse(report.issues.some((i) => i.code === "st.global_world_missing"))
          assert.isFalse(report.issues.some((i) => i.code === "st.global_worlds_unattached"))
          assert.isTrue(report.issues.some((i) => i.level === "error"))
          assert.lengthOf(report.links, 1)
          assert.isAbove(report.unsupported.length, 0)
        }
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
    180_000
  )

  for (const ending of ["complete", "cancelled", "interrupted"] as const)
    it.live(
      `a genuinely missing preset is reported only once the upload is ${ending}`,
      () =>
        Effect.gen(function* () {
          const api = yield* client()
          const files = stFolder()
          const { importId } = yield* api.StartStImport({ unsupported: [] })
          yield* sendStFile(importId, "settings.json", files.get("settings.json")!)
          yield* sendStFile(importId, "worlds/Hollow.json", files.get("worlds/Hollow.json")!)
          const partial = yield* api.GetStImportReport({ importId })
          assert.isEmpty(partial.issues)
          assert.strictEqual((yield* api.GetStImport({ importId })).job.status, "running")
          if (ending === "complete") yield* api.FinishStImport({ importId, notSent: [] })
          else if (ending === "cancelled") yield* api.CancelStImport({ importId })
          else {
            const next = yield* api.StartStImport({ unsupported: [] })
            yield* api.CancelStImport({ importId: next.importId })
          }
          const done = yield* api.GetStImport({ importId })
          assert.strictEqual(done.job.status, ending)
          assert.strictEqual(done.report!.counts.lorebook?.added, 1)
          assert.isTrue(done.report!.issues.some((i) => i.code === "st.preset_missing"))
          assert.isTrue(done.report!.issues.some((i) => i.code === "st.global_worlds_unattached"))
        }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
      180_000
    )
})
