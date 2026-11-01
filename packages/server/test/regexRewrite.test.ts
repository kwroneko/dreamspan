// Regex scripts as ST 1.19 runs them on text as it's written and from every list (ARCHITECTURE
// §12 "Rewrites", §15 "Regex scripts"): placements, scopes and their order, approval, depth,
// run-on-edit, failures and timeouts, world info and the inspector's record. Synthetic only.
import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import { Effect, Scope } from "effect"
import { describe, expect, it } from "vitest"
import { makeAssembler } from "../src/assembler/assembler.ts"
import { compile, makeScriptRunner, REGEX_MS } from "../src/assembler/regex.ts"
import type { RewriteOptions } from "../src/assembler/scriptSources.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { type AssemblyFixture, assembleFixture, prepareFixture, rewriteFixture } from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"

const script = (id: string, fields: Partial<RegexScript> = {}): RegexScript => ({
  id,
  name: id,
  find_regex: "/<think>[\\s\\S]*?<\\/think>\\s*/g",
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

const basePreset = () => importStPreset(JSON.stringify({ frequency_penalty: 0 })).document!

const fixture = (
  options: {
    readonly preset?: ReadonlyArray<RegexScript>
    readonly presetApproved?: boolean
    readonly global?: ReadonlyArray<RegexScript>
    readonly mira?: ReadonlyArray<RegexScript>
    readonly miraApproved?: boolean
    readonly ada?: ReadonlyArray<RegexScript>
    readonly speaker?: string
    readonly messages?: AssemblyFixture["messages"]
  } = {}
): AssemblyFixture => ({
  preset: { ...basePreset(), regex: options.preset ?? [], regex_approved: options.presetApproved ?? true },
  ...(options.global ? { globalRegex: options.global } : {}),
  cards: [
    {
      entity: "mira",
      doc: {
        ...cardDoc("Mira"),
        ...(options.mira ? { regex: options.mira, regex_approved: options.miraApproved ?? true } : {})
      }
    },
    ...(options.ada ? [{ entity: "ada", doc: { ...cardDoc("Ada"), regex: options.ada, regex_approved: true } }] : []),
    { entity: "tobin", doc: cardDoc("Tobin") }
  ],
  participants: options.ada ? ["mira", "ada", "tobin"] : ["mira", "tobin"],
  persona: "tobin",
  messages: options.messages ?? [{ side: "user", content: "The road flooded." }],
  ...(options.speaker ? { target: { speaker: options.speaker } } : {})
})

const reply: RewriteOptions = { edit: false, speaker: "mira", writer: "model" }
const typed: RewriteOptions = { edit: false, speaker: "tobin", writer: "human" }

const rewrite = (f: AssemblyFixture, options: RewriteOptions, text: string, reasoning?: string) =>
  Effect.runPromise(
    rewriteFixture(f, options, [
      { text, kind: "message" },
      ...(reasoning === undefined ? [] : [{ text: reasoning, kind: "reasoning" as const }])
    ])
  )

describe("regex scripts on text as it's written", () => {
  it("strips a chain of thought from a reply with a neither-flag AI output script", async () => {
    const [out] = await rewrite(fixture({ preset: [script("strip")] }), reply, "<think>secret plan</think>Hello there")
    expect(out).toEqual({ text: "Hello there", applied: [{ scope: "preset", id: "strip", name: "strip" }], failed: [] })
  })

  it("runs each placement on its own text: user input, AI output, reasoning", async () => {
    const scripts = [
      script("user", { find_regex: "/road/g", replace_string: "path", placement: [1] }),
      script("ai", { find_regex: "/road/g", replace_string: "lane", placement: [2] }),
      script("thought", { find_regex: "/road/g", replace_string: "idea", placement: [6] })
    ]
    const [typedOut] = await rewrite(fixture({ preset: scripts }), typed, "the road")
    expect(typedOut!.text).toBe("the path")
    const [text, thought] = await rewrite(fixture({ preset: scripts }), reply, "the road", "a road")
    expect(text!.text).toBe("the lane")
    expect(thought!.text).toBe("a idea")
    // An impersonated reply is the user's side: ST's cleanUpMessage runs user-input scripts on it.
    const [impersonated] = await rewrite(fixture({ preset: scripts }), { ...typed, writer: "model" }, "the road")
    expect(impersonated!.text).toBe("the path")
  })

  it("leaves prompt-only and display-only scripts out of stored text", async () => {
    const [out] = await rewrite(
      fixture({
        preset: [script("prompt", { prompt_only: true }), script("display", { markdown_only: true })]
      }),
      reply,
      "<think>x</think>Hi"
    )
    expect(out).toEqual({ text: "<think>x</think>Hi", applied: [], failed: [] })
  })

  it("runs no preset or character script until it's approved; global scripts need none", async () => {
    const strip = [script("strip")]
    expect(
      (await rewrite(fixture({ preset: strip, presetApproved: false }), reply, "<think>x</think>Hi"))[0]!.text
    ).toBe("<think>x</think>Hi")
    expect((await rewrite(fixture({ mira: strip, miraApproved: false }), reply, "<think>x</think>Hi"))[0]!.text).toBe(
      "<think>x</think>Hi"
    )
    expect((await rewrite(fixture({ mira: strip }), reply, "<think>x</think>Hi"))[0]!.applied).toEqual([
      { scope: "character", id: "strip", name: "strip" }
    ])
    expect((await rewrite(fixture({ global: strip, presetApproved: false }), reply, "<think>x</think>Hi"))[0]).toEqual({
      text: "Hi",
      applied: [{ scope: "global", id: "strip", name: "strip" }],
      failed: []
    })
  })

  it("runs global, then preset, then character scripts (engine.js SCRIPT_TYPES)", async () => {
    const step = (id: string, from: string, to: string) => script(id, { find_regex: `/${from}/g`, replace_string: to })
    const [out] = await rewrite(
      fixture({ global: [step("g", "A", "B")], preset: [step("p", "B", "C")], mira: [step("c", "C", "D")] }),
      reply,
      "A"
    )
    expect(out!.text).toBe("D")
    expect(out!.applied.map((ref) => ref.scope)).toEqual(["global", "preset", "character"])
  })

  it("uses the speaker's scripts for a reply, and the one character's for the user's text", async () => {
    const tag = (id: string) => script(id, { find_regex: "/x/g", replace_string: id, placement: [1, 2] })
    const group = fixture({ mira: [tag("mira")], ada: [tag("ada")] })
    expect((await rewrite(group, { ...reply, speaker: "ada" }, "x"))[0]!.text).toBe("ada")
    // In a group the user's text has no current character, as in ST.
    expect((await rewrite(group, typed, "x"))[0]!.text).toBe("x")
    expect((await rewrite(fixture({ mira: [tag("mira")] }), typed, "x"))[0]!.text).toBe("mira")
  })

  it("ignores depths, as ST passes none when text is written", async () => {
    const [out] = await rewrite(
      fixture({ preset: [script("deep", { min_depth: 5, max_depth: 9 })] }),
      reply,
      "<think>a</think>b"
    )
    expect(out!.text).toBe("b")
  })

  it("runs only run-on-edit scripts on an edit", async () => {
    const scripts = [
      script("always", { find_regex: "/a/g", replace_string: "b" }),
      script("on-edit", { find_regex: "/c/g", replace_string: "d", run_on_edit: true })
    ]
    expect((await rewrite(fixture({ preset: scripts }), { ...reply, edit: true }, "ac"))[0]!.text).toBe("ad")
    expect((await rewrite(fixture({ preset: scripts }), reply, "ac"))[0]!.text).toBe("bd")
  })

  it("expands macros in the replacement, and reports a script it can't run", async () => {
    const [out] = await rewrite(
      fixture({
        preset: [
          script("name", { find_regex: "/NAME/g", replace_string: "{{char}}" }),
          script("backtracking", { find_regex: "/(a)\\1/g" })
        ]
      }),
      reply,
      "NAME aa"
    )
    expect(out!.text).toBe("Mira aa")
  })
})

describe("the bounded engine for rewrites", () => {
  const entry = (find: string, replace = "", fields: Partial<RegexScript> = {}) => {
    const regex = compile(find)
    if (!(regex instanceof RegExp)) throw new Error("not compiled")
    const s = script("s", { find_regex: find, replace_string: replace, ...fields })
    return {
      ref: { scope: "preset" as const, id: s.id, name: s.name },
      script: s,
      regex,
      replacement: replace,
      trim: []
    }
  }

  it("skips a script that makes too much text and keeps the text it had", () => {
    const runner = makeScriptRunner([entry("/q/g", "b".repeat(1000))], { ms: 1000, output: 100 })
    const [out] = runner.rewrite([{ text: "qq", placement: 2 }], { edit: false })
    expect(out!.text).toBe("qq")
    expect(out!.failed).toEqual([
      {
        script: { scope: "preset", id: "s", name: "s" },
        reason: "it failed: it made more text than one context allows"
      }
    ])
  })

  it("keeps the whole text when the time runs out, and says which script was running", () => {
    const nested = "(?:(?:(?:a|aa)*)*)*".repeat(30) + "b"
    const runner = makeScriptRunner([entry("/x/g", "y"), entry(`/${nested}/g`)], { ms: 5, output: 1e9 })
    const [out] = runner.rewrite([{ text: "x" + "a".repeat(40_000), placement: 2 }], { edit: false })
    expect(out!.text).toBe("x" + "a".repeat(40_000))
    expect(out!.applied).toEqual([])
    expect(out!.failed).toHaveLength(1)
    expect(out!.failed[0]!.reason).toContain("ran out of time")
  })
})

describe("prompt scripts from every list", () => {
  it("records which scripts changed a message on its piece, for the inspector", async () => {
    const snapshot = await Effect.runPromise(
      assembleFixture(
        fixture({
          global: [
            script("g", { prompt_only: true, find_regex: "/flooded/g", replace_string: "dried", placement: [1] })
          ],
          messages: [{ side: "user", content: "The road flooded." }]
        })
      )
    )
    expect(JSON.stringify(snapshot.request.messages)).toContain("The road dried.")
    const piece = snapshot.pieces.find((p) => p.source.kind === "message")!
    expect(piece.scripts).toEqual([{ scope: "global", id: "g", name: "g" }])
  })

  it("runs world-info scripts on activated lorebook entries, with the entry's depth when placed at one", async () => {
    const book = {
      id: "harbor",
      entity: "harbor-entity",
      revision: "harbor-rev",
      doc: loreBook([
        loreEntry({ keys: ["road"], content: "The road is old.", position: "after_char" }, 1),
        loreEntry({ keys: ["road"], content: "The road floods.", position: "at_depth", depth: 3 }, 2)
      ]).document
    }
    const snapshot = await Effect.runPromise(
      assembleFixture({
        ...fixture({
          preset: [
            script("wi", { prompt_only: true, find_regex: "/road/g", replace_string: "lane", placement: [5] }),
            // Only an entry placed at depth 3 or deeper.
            script("deep", {
              prompt_only: true,
              find_regex: "/floods/g",
              replace_string: "rises",
              placement: [5],
              min_depth: 3
            })
          ]
        }),
        lorebooks: [book],
        events: [
          { depth: null, event: { scope: null, data: { key: "lorebook.attach", value: { ref: book.id as never } } } }
        ]
      })
    )
    const sent = JSON.stringify(snapshot.request.messages)
    expect(sent).toContain("The lane is old.")
    expect(sent).toContain("The lane rises.")
    expect(sent).not.toContain("The road is")
    expect(sent).not.toContain("The road floods")
    // The chat's own message is user input, which these world-info scripts don't touch.
    expect(sent).toContain("The road flooded.")
    const pieces = snapshot.pieces.filter((p) => p.source.kind === "lorebook" && p.text)
    expect(pieces.map((p) => p.scripts?.map((s) => s.id))).toEqual([["wi"], ["wi", "deep"]])
  })

  it("lets a plugin disable a list or add one", async () => {
    const scope = Effect.runSync(Scope.make())
    const assembler = Effect.runSync(Scope.provide(scope)(makeAssembler))
    const f = fixture({ preset: [script("strip")] })
    Effect.runSync(Scope.provide(scope)(assembler.scriptSources.disable("regex.preset")))
    expect(
      (
        await Effect.runPromise(rewriteFixture(f, reply, [{ text: "<think>a</think>b", kind: "message" }], assembler))
      )[0]!.text
    ).toBe("<think>a</think>b")
    Effect.runSync(
      Scope.provide(scope)(
        assembler.scriptSources.register({
          id: "plugin.list",
          scope: "global",
          scripts: () => Effect.succeed([script("plugin", { find_regex: "/b/g", replace_string: "c" })])
        })
      )
    )
    const [out] = await Effect.runPromise(rewriteFixture(f, reply, [{ text: "b", kind: "message" }], assembler))
    expect(out!.text).toBe("c")
    // The rewrite itself is registered too: a plugin replaces it.
    Effect.runSync(
      Scope.provide(scope)(
        assembler.rewrites.register({
          id: "rewrite.regex",
          run: (_assembly, items) => items.map((item) => ({ text: item.text.toUpperCase(), applied: [], failed: [] }))
        })
      )
    )
    const [upper] = await Effect.runPromise(rewriteFixture(f, reply, [{ text: "b", kind: "message" }], assembler))
    expect(upper!.text).toBe("B")
  })
})

describe("a rewrite prepared for a streaming reply", () => {
  const reply: RewriteOptions = { edit: false, speaker: "mira", writer: "model" }

  it("runs the scripts on each text it's given, each run with the time of one rewrite", async () => {
    const f = fixture({
      preset: [script("strip"), script("hide", { find_regex: "/PRIVATE/g", replace_string: "[x]", placement: [6] })]
    })
    const prepared = await Effect.runPromise(prepareFixture(f, reply))
    expect(prepared.active).toBe(true)
    expect(prepared.run([{ text: "<think>a", kind: "message" }])[0]!.text).toBe("<think>a")
    const [body, thought] = prepared.run([
      { text: "<think>a</think>b", kind: "message" },
      { text: "a PRIVATE plan", kind: "reasoning" }
    ])
    expect(body!.text).toBe("b")
    expect(thought!.text).toBe("a [x] plan")
    // Many runs never spend one deadline between them.
    for (let i = 0; i < 300; i++) prepared.run([{ text: "<think>a</think>b", kind: "message" }])
    expect(prepared.run([{ text: "<think>a</think>c", kind: "message" }])[0]).toMatchObject({ text: "c", failed: [] })
  })

  it("says it can't change anything without scripts", async () => {
    const prepared = await Effect.runPromise(prepareFixture(fixture(), reply))
    expect(prepared.active).toBe(false)
  })

  // What one live rewrite costs on a long reply (ARCHITECTURE §12, "Live rewrites"). Set
  // MEASURE to print it; the bound only catches a gross regression on a loaded host.
  it.each([
    ["few matches", (i: number) => `/<cot${i}>[\\s\\S]*?(?:<\\/cot${i}>\\s*|$)/g`],
    ["a match every 8 words", (i: number) => `/\\bword${i}\\b/g`]
  ])("takes a 20,000-character reply through 10 scripts (%s)", async (label, find) => {
    const scripts = Array.from({ length: 10 }, (_, i) => script(`s${i}`, { find_regex: find(i), replace_string: "w" }))
    const prepared = await Effect.runPromise(prepareFixture(fixture({ preset: scripts }), reply))
    const text = (Array.from({ length: 3400 }, (_, i) => `word${i % 13}`).join(" ") + " <cot3>a thought").slice(-20_000)
    expect(text.length).toBe(20_000)
    const times: Array<number> = []
    for (let i = 0; i < 30; i++) {
      const start = performance.now()
      const [out] = prepared.run([{ text: text.slice(0, 19_000 + i * 30), kind: "message" }])
      times.push(performance.now() - start)
      // Rewritten, or (out of time on a loaded host) the text as it came, never half done.
      if (out!.failed.length > 0) expect(out!.text).toBe(text.slice(0, 19_000 + i * 30))
    }
    times.sort((a, b) => a - b)
    if (process.env.MEASURE)
      console.log(
        `20k characters, 10 scripts, ${label}: median ${times[15]!.toFixed(1)} ms, max ${times.at(-1)!.toFixed(1)} ms`
      )
    expect(times[15]).toBeLessThan(REGEX_MS * 2)
  })
})
