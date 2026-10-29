import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { serverPort } from "./support/config.ts"
import { png, textChunk } from "./formats/support.ts"

for (const style of ["direct", "tool"] as const) {
  for (const withPreset of [true, false]) {
    lcmTest(`summary images: ${style}, preset ${withPreset}, selected range and last-N`, (server) =>
      Effect.gen(function* () {
        let turns = 0
        const h = yield* lcmHarness(server, {
          messages: 3,
          settings: { style, withPreset },
          summarizer: () =>
            style === "direct"
              ? { text: "The drawing shows a synthetic harbor." }
              : {
                  tool: {
                    name: "summary_tool",
                    arguments:
                      turns++ === 0
                        ? { command: "create", file_text: "The drawing shows a synthetic harbor." }
                        : { command: "finalize" }
                  }
                }
        })
        const model = (yield* h.api.ListModels({ connectionId: h.connection.id, includeHidden: true })).find(
          (m) => m.id === h.primary.model
        )!
        yield* h.api.EditModel({
          modelId: model.id,
          expectedRowVersion: model.rowVersion,
          overrides: { ...model.overrides, vision: true, maxImages: 1 }
        })
        const port = yield* serverPort
        const upload = (tag: string) =>
          Effect.promise(async () => {
            const response = await fetch(`http://127.0.0.1:${port}/chat/image`, {
              method: "POST",
              headers: { "content-type": "application/octet-stream" },
              body: png(textChunk("fixture", tag))
            })
            assert.strictEqual(response.status, 200)
            return (await response.json()) as { mediaId: string }
          })
        const older = yield* upload("older"),
          newest = yield* upload("newest"),
          outside = yield* upload("outside")
        for (const [i, image] of [older, newest, outside].entries()) {
          const row = h.rows[i]!
          yield* h.api.EditVersion({
            slotId: row.slotId,
            sourceVersionId: row.version.id,
            expectedRowVersion: 1,
            content: i === 1 ? "" : `Drawing ${i}`,
            images: [image]
          })
        }
        // Image-only versions must have a real identity, including their amend counter.
        yield* h.enqueue(0, 1)
        const job = yield* h.runNext
        assert.isNotNull(job)
        const requests = h.mock.requests().filter((r) => r.path === "/v1/chat/completions")
        assert.lengthOf(requests, style === "tool" ? 2 : 1)
        for (const request of requests) {
          const body = JSON.stringify(request.body)
          assert.strictEqual(body.split('"type":"image_url"').length - 1, 1)
          assert.include(body, Buffer.from(png(textChunk("fixture", "newest"))).toString("base64"))
          assert.notInclude(body, Buffer.from(png(textChunk("fixture", "older"))).toString("base64"))
          assert.notInclude(body, Buffer.from(png(textChunk("fixture", "outside"))).toString("base64"))
        }
        const [rows] = yield* fixtureSql(
          h.dataDir,
          [
            {
              sql: "SELECT j.status, p.context_snapshot_json AS snapshot FROM summarization_jobs j JOIN rollout_payloads p ON p.rollout_id=j.rollout_id WHERE j.id=?",
              params: [job!.id]
            }
          ],
          { readOnly: true }
        )
        assert.strictEqual(rows![0]!.status, "complete")
        const stored = String(rows![0]!.snapshot)
        assert.include(stored, newest.mediaId)
        assert.notInclude(stored, Buffer.from(png(textChunk("fixture", "newest"))).toString("base64"))
      }).pipe(Effect.scoped)
    )
  }
}
