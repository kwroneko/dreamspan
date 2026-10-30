// The one-time impersonation notice (DESIGN §2.2): asked as the user generates as a card they
// play, it's shown once per preset per account, and only for a preset with no prompt of its
// order sent only when the model writes as {{user}}. ST's impersonation prompt is the
// end-of-request text "when your card speaks", outside the order, so it doesn't count.
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@rp/shared/domain.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { presetDoc } from "./support/docs.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const preset = (api: Api, label: string, impersonation: string, asUser = false) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const base = presetDoc()
    const marked = base.prompts[0]!
    const doc = asUser
      ? {
          ...base,
          prompts: [...base.prompts, { ...marked, identifier: "as-user", condition: "as_user" as const }],
          order: [...base.order, { identifier: "as-user", enabled: true }]
        }
      : base
    const created = yield* (yield* Writer).CreateEntity({
      userId: me.id as UserId,
      kind: "preset",
      label,
      subtitle: "",
      doc: { ...doc, utility_prompts: { ...doc.utility_prompts, impersonation_prompt: impersonation } } as never,
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    return created.ref.id as RefId
  })

describe("the impersonation notice", () => {
  it.live("is said once per preset, and only where no prompt is sent when writing as {{user}}", () =>
    Effect.gen(function* () {
      const api = yield* client()
      // No preset chosen: nothing to say.
      assert.deepStrictEqual(yield* api.ImpersonationNotice({}), { show: false, preset: null })

      const bare = yield* preset(api, "Bare", "")
      yield* api.ChangeGenerationDefaults({ change: { preset: bare } })
      assert.deepStrictEqual(yield* api.ImpersonationNotice({}), { show: true, preset: bare })
      // Once: asking again, or from another tab, says nothing.
      assert.deepStrictEqual(yield* api.ImpersonationNotice({}), { show: false, preset: bare })

      // ST's impersonation prompt alone is the end-of-request text, which doesn't count.
      const withPrompt = yield* preset(api, "With its prompt", "[Write as {{user}}.]")
      yield* api.ChangeGenerationDefaults({ change: { preset: withPrompt } })
      assert.deepStrictEqual(yield* api.ImpersonationNotice({}), { show: true, preset: withPrompt })
      // A prompt of the order marked for writing as {{user}}: nothing to say.
      const marked = yield* preset(api, "Marked", "", true)
      yield* api.ChangeGenerationDefaults({ change: { preset: marked } })
      assert.deepStrictEqual(yield* api.ImpersonationNotice({}), { show: false, preset: marked })

      // Another bare preset has its own notice.
      const other = yield* preset(api, "Other", "")
      yield* api.ChangeGenerationDefaults({ change: { preset: other } })
      assert.deepStrictEqual(yield* api.ImpersonationNotice({}), { show: true, preset: other })
      yield* api.ChangeGenerationDefaults({ change: { preset: bare } })
      assert.deepStrictEqual(yield* api.ImpersonationNotice({}), { show: false, preset: bare })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})
