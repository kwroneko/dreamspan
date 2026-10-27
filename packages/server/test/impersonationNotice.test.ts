// The one-time impersonation notice (DESIGN §2.2): asked as the user generates as a card they
// play, it's shown once per preset per account, and only for a preset with no prompt sent
// when the model writes as {{user}} (ST's impersonation prompt, imported, counts).
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@rp/shared/domain.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { presetDoc } from "./support/docs.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const preset = (api: Api, label: string, impersonation: string) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const doc = presetDoc()
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
      // ST's built-in default has its impersonation prompt.
      assert.deepStrictEqual(yield* api.ImpersonationNotice({}), { show: false, preset: null })

      const bare = yield* preset(api, "Bare", "")
      yield* api.ChangeGenerationDefaults({ change: { preset: bare } })
      assert.deepStrictEqual(yield* api.ImpersonationNotice({}), { show: true, preset: bare })
      // Once: asking again, or from another tab, says nothing.
      assert.deepStrictEqual(yield* api.ImpersonationNotice({}), { show: false, preset: bare })

      // A preset saved before conditions, with ST's impersonation prompt: it reads as a prompt
      // conditioned on writing as {{user}}, so there's nothing to say.
      const withPrompt = yield* preset(api, "With its prompt", "[Write as {{user}}.]")
      yield* api.ChangeGenerationDefaults({ change: { preset: withPrompt } })
      assert.deepStrictEqual(yield* api.ImpersonationNotice({}), { show: false, preset: withPrompt })

      // Another bare preset has its own notice.
      const other = yield* preset(api, "Other", "")
      yield* api.ChangeGenerationDefaults({ change: { preset: other } })
      assert.deepStrictEqual(yield* api.ImpersonationNotice({}), { show: true, preset: other })
      yield* api.ChangeGenerationDefaults({ change: { preset: bare } })
      assert.deepStrictEqual(yield* api.ImpersonationNotice({}), { show: false, preset: bare })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})
