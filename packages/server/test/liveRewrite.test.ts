// Regex scripts apply while a reply streams (ARCHITECTURE §12, "Live rewrites"), as ST's
// streaming runs them on the text so far at every update: every frame a subscriber gets shows
// the scripts applied to the text so far, the reply's thinking (its leading tagged section)
// through the reasoning scripts, and the stored text is what the last frame showed. The mock
// provider streams the reply in small pieces, a few milliseconds apart. Synthetic text only.
import { assert, it } from "@effect/vitest"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { VersionId } from "@rp/shared/chat.ts"
import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import { sectionsDisplay } from "@rp/shared/replySections.ts"
import { OUT_OF_TIME } from "@rp/shared/regexScripts.ts"
import { Effect, Layer } from "effect"
import { regexToSt } from "../src/formats/preset.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import * as Builtins from "../src/providers/builtins.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { completionChunks, startMockProvider } from "./support/mockProvider.ts"

const script = (id: string, fields: Partial<RegexScript>): RegexScript => ({
  id,
  name: id,
  find_regex: "",
  replace_string: "",
  trim_strings: [],
  placement: [2],
  disabled: false,
  markdown_only: false,
  prompt_only: false,
  run_on_edit: false,
  substitute_regex: "none",
  min_depth: null,
  max_depth: null,
  ...fields
})

/** Strips a chain of thought, an unfinished one through the end of the text so far. */
const stripCot = script("strip-cot", { find_regex: "/<cot>[\\s\\S]*?(?:<\\/cot>\\s*|$)/g" })
/** Hides a word in reasoning: the provider's, and the reply's thinking. */
const hideWord = script("hide-word", { find_regex: "/PRIVATE/g", replace_string: "[hidden]", placement: [6] })

// Long enough after the thinking that the body streams: the parser holds a body starting
// with `<` until it can tell it isn't another section (a line break, 64 characters).
const BODY = "Hello there, traveller. The road is long and the mill is closed tonight, so Mira lights the lantern."
const REPLY = `<thinking>Plan: take the PRIVATE road.</thinking>\n<cot>secret chain of thought</cot>${BODY}`

/** A mock model streaming `reply` a few characters at a time, `gapMs` apart. */
const slowModel = (reply: string, size = 3, gapMs = 25) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      startMockProvider((_request, res) => {
        const pieces: Array<string> = []
        for (let i = 0; i < reply.length; i += size) pieces.push(reply.slice(i, i + size))
        const events = completionChunks(pieces, { prompt_tokens: 10, completion_tokens: 20 })
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        let i = 0
        const next = () => {
          if (i < events.length) {
            res.write(`data: ${JSON.stringify(events[i++])}\n\n`)
            setTimeout(next, gapMs)
          } else {
            res.write("data: [DONE]\n\n")
            res.end()
          }
        }
        next()
      })
    ),
    (mock) => Effect.promise(() => mock.close())
  )

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(testConfig()), Builtins.layer))) as Effect.Effect<
    A,
    E,
    never
  >

/** Every frame of one shown text, as a client applies the events (session.ts `flush`). */
const frames = (events: ReadonlyArray<ChatEvent>, versionId: VersionId, tag: "Delta" | "Reasoning" | "Section") => {
  let text = ""
  const out: Array<string> = []
  for (const event of events) {
    if (event._tag !== tag || event.versionId !== versionId) continue
    assert.isAtMost(event.offset, text.length, "never a gap")
    text = text.slice(0, event.offset) + event.text
    out.push(text)
  }
  return out
}

it.live(
  "every streamed frame shows the scripts applied to the text so far; the stored text is the last frame",
  () =>
    run(
      Effect.gen(function* () {
        const model = yield* slowModel(REPLY)
        const api = yield* client()
        const reply = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: model.url + "/v1" },
          model: {},
          preset: { extensions: { regex_scripts: regexToSt([stripCot, hideWord]) } },
          approveRegex: true
        })
        const id = reply.version.id
        const body = frames(reply.events, id, "Delta")
        const thinking = frames(reply.events, id, "Section")
        if (process.env.DEBUG_FRAMES)
          console.log(
            JSON.stringify(
              { body, thinking, events: reply.events.filter((e) => e._tag === "Delta" || e._tag === "Section").length },
              null,
              1
            )
          )
        assert.isAbove(body.length, 2, "the body streamed in several frames")
        assert.isAbove(thinking.length, 2, "the thinking streamed in several frames")
        for (const frame of body) {
          assert.notInclude(frame, "secret", frame)
          assert.notInclude(frame, "thought", frame)
          assert.notInclude(frame, "<thinking>", frame)
        }
        for (const frame of thinking) assert.notInclude(frame, "PRIVATE", frame)
        // Some frames took text back: a `<cot>` arriving in pieces shows until the script matches it.
        // The stored text is the finish's rewrite, and it is what the last frames showed.
        assert.equal(reply.version.content, BODY)
        assert.equal(body.at(-1), reply.version.content)
        assert.equal(sectionsDisplay(reply.version.replySections), "Plan: take the [hidden] road.")
        assert.equal(thinking.at(-1), "Plan: take the [hidden] road.")
        assert.deepStrictEqual(
          reply.version.rewrite?.applied.map((ref) => ref.id),
          ["strip-cot", "hide-word"]
        )
        assert.isTrue(reply.version.rewrite?.rawSections)
        // The original text covers the thinking too, and restoring brings both back.
        const raw = yield* api.RawVersionText({ versionId: id })
        assert.equal(raw.content, `<cot>secret chain of thought</cot>${BODY}`)
        assert.equal(raw.sections && sectionsDisplay(raw.sections), "Plan: take the PRIVATE road.")
        const path = yield* api.ReadPath({
          chatId: reply.chat.id,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 50
        })
        const restored = yield* api.RestoreRawText({
          slotId: reply.version.slotId,
          versionId: id,
          expectedRowVersion: path.entries.find((e) => e.slotId === reply.version.slotId)!.rowVersion
        })
        assert.equal(restored.version.content, raw.content)
        assert.equal(sectionsDisplay(restored.version.replySections), "Plan: take the PRIVATE road.")
      })
    ),
  60_000
)

it.live(
  "without scripts the reply streams as it is, append-only",
  () =>
    run(
      Effect.gen(function* () {
        const model = yield* slowModel(REPLY)
        const api = yield* client()
        const reply = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: model.url + "/v1" },
          model: {}
        })
        const id = reply.version.id
        const deltas = reply.events.filter((event) => event._tag === "Delta" && event.versionId === id)
        assert.isTrue(deltas.every((event) => event._tag === "Delta" && event.replace === undefined))
        assert.equal(frames(reply.events, id, "Delta").at(-1), `<cot>secret chain of thought</cot>${BODY}`)
        assert.equal(reply.version.content, `<cot>secret chain of thought</cot>${BODY}`)
        assert.isUndefined(reply.version.rewrite)
      })
    ),
  60_000
)

it.live(
  "the live rewrite is a registered part: disabled, the reply streams as it is and is still rewritten at its end",
  () =>
    run(
      Effect.gen(function* () {
        const { liveRewrites } = yield* ExecutionRegistry
        yield* liveRewrites.disable("live.regex")
        const model = yield* slowModel(REPLY, 12, 1)
        const api = yield* client()
        const reply = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: model.url + "/v1" },
          model: {},
          preset: { extensions: { regex_scripts: regexToSt([stripCot, hideWord]) } },
          approveRegex: true
        })
        const body = frames(reply.events, reply.version.id, "Delta")
        assert.include(body.at(-1), "secret chain")
        assert.equal(reply.version.content, BODY)
      })
    ),
  60_000
)

it.live(
  "a slow rewrite on a long reply never shows text it hasn't been through",
  () =>
    run(
      Effect.gen(function* () {
        // A plugin's live rewrite that takes its time (as the scripts can on a busy host) and
        // takes out every SECRET: what arrives while it runs waits for the next one.
        const { liveRewrites } = yield* ExecutionRegistry
        yield* liveRewrites.disable("live.regex")
        yield* liveRewrites.register({
          id: "test.slow",
          rewrite: (_services, _request, items) =>
            Effect.as(Effect.sleep("40 millis"), {
              texts: items.map((item) => ({ text: item.text.replace(/SECRET/g, ""), applied: [], failed: [] })),
              ms: 100
            })
        })
        const reply = Array.from({ length: 60 }, (_, i) => `Line ${i} of the long reply, and a SECRET word.`).join(" ")
        assert.isAbove(reply.length, 2000)
        const model = yield* slowModel(reply, 6, 2)
        const api = yield* client()
        const generated = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: model.url + "/v1" },
          model: {}
        })
        const body = frames(generated.events, generated.version.id, "Delta")
        assert.isAbove(body.length, 2, "the body streamed in several frames")
        for (const frame of body) assert.notInclude(frame, "SECRET", frame)
        assert.include(reply.replace(/SECRET/g, ""), body.at(-1)!.slice(0, 200))
      })
    ),
  60_000
)

it.live(
  "a reply that ends before its first live rewrite comes back streams its text as saved",
  () =>
    run(
      Effect.gen(function* () {
        // A live rewrite slower than the whole reply (a short one, a busy host): nothing has
        // shown when it ends, and the stream still ends on the stored text, scripts applied.
        const { liveRewrites } = yield* ExecutionRegistry
        yield* liveRewrites.disable("live.regex")
        yield* liveRewrites.register({
          id: "test.late",
          rewrite: () => Effect.as(Effect.sleep("2 seconds"), null)
        })
        const model = yield* slowModel(`<cot>secret chain of thought</cot>${BODY}`, 40, 1)
        const api = yield* client()
        const generated = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: model.url + "/v1" },
          model: {},
          preset: { extensions: { regex_scripts: regexToSt([stripCot]) } },
          approveRegex: true
        })
        const body = frames(generated.events, generated.version.id, "Delta")
        assert.equal(generated.version.content, BODY)
        assert.deepStrictEqual(body, [BODY])
      })
    ),
  60_000
)

it.live(
  "a live rewrite that fails or runs out of time holds what's shown and is tried again, never showing the text as it came",
  () =>
    run(
      Effect.gen(function* () {
        // A plugin's live rewrite whose worker fails (restarting), then runs out of time, then answers.
        const { liveRewrites } = yield* ExecutionRegistry
        yield* liveRewrites.disable("live.regex")
        let calls = 0
        yield* liveRewrites.register({
          id: "test.flaky",
          rewrite: (_services, _request, items) =>
            Effect.suspend(() =>
              ++calls === 1
                ? Effect.fail(new Error("the worker is restarting"))
                : calls === 2
                  ? // Out of time on a busy host: the text as it came, which the scripts would change.
                    Effect.succeed({
                      texts: items.map((item) => ({
                        text: item.text,
                        applied: [],
                        failed: [
                          { script: { scope: "preset" as const, id: "slow", name: "Slow" }, reason: OUT_OF_TIME }
                        ]
                      })),
                      ms: 200
                    })
                  : Effect.succeed({
                      texts: items.map((item) => ({ text: item.text.replace(/SECRET/g, ""), applied: [], failed: [] })),
                      ms: 1
                    })
            )
        })
        const model = yield* slowModel("A SECRET word, then the rest of the reply goes on for a while.", 3, 10)
        const api = yield* client()
        const generated = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: model.url + "/v1" },
          model: {}
        })
        const body = frames(generated.events, generated.version.id, "Delta")
        assert.isAbove(calls, 2)
        assert.isAbove(body.length, 0, "the body streamed once the rewrite answered")
        for (const frame of body) assert.notInclude(frame, "SECRET", frame)
      })
    ),
  60_000
)
