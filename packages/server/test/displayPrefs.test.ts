import { assert, it } from "@effect/vitest"
import { CHAT_WIDTH, DEFAULT_DISPLAY_PREFS, DisplayPrefsChange } from "@rp/shared/chatApi.ts"
import { Effect, Schema } from "effect"
import { client, testConfig, withServer } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

it.live("reads older display rows with colour defaults, merges colour patches and resets one choice", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client()
    const session = yield* api.GetSession()
    yield* fixtureSql(config.dataDir, [
      {
        sql: "INSERT INTO user_prefs(user_id,key,value_json) VALUES (?, 'display', ?)",
        params: [session.user.id, JSON.stringify({ reasoning: "collapsed" })]
      }
    ])
    assert.deepStrictEqual(yield* api.GetDisplayPrefs({}), { ...DEFAULT_DISPLAY_PREFS, reasoning: "collapsed" })
    yield* api.SetDisplayPrefs({ prefs: { mainTextColor: "#123456", italicsTextColor: "#654321" } })
    yield* api.SetDisplayPrefs({ prefs: { quoteTextColor: "#abcdef", underlineTextColor: "#fedcba" } })
    const secondClient = yield* client()
    assert.deepStrictEqual(yield* secondClient.GetDisplayPrefs({}), {
      ...DEFAULT_DISPLAY_PREFS,
      reasoning: "collapsed",
      mainTextColor: "#123456",
      italicsTextColor: "#654321",
      quoteTextColor: "#abcdef",
      underlineTextColor: "#fedcba"
    })
    yield* secondClient.SetDisplayPrefs({ prefs: { quoteTextColor: null } })
    const reset = yield* api.GetDisplayPrefs({})
    assert.isNull(reset.quoteTextColor)
    assert.strictEqual(reset.mainTextColor, "#123456")
    assert.strictEqual(reset.reasoning, "collapsed")
  }).pipe(withServer(config))
})

it("accepts only hex colour values or a reset, keeping CSS out of saved preferences", () => {
  const decode = Schema.decodeUnknownOption(DisplayPrefsChange)
  for (const value of ["red", "#123", "#12345678", "var(--text)", "url(https://example.com/)"])
    assert.strictEqual(decode({ quoteTextColor: value })._tag, "None")
  assert.strictEqual(decode({ quoteTextColor: "#Aa1234" })._tag, "Some")
  assert.strictEqual(decode({ quoteTextColor: null })._tag, "Some")
})

it.live("Enter sends patches persist per account and do not reset unrelated display choices", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    assert.strictEqual((yield* alice.GetDisplayPrefs({})).enterSends, "automatic")
    yield* alice.SetDisplayPrefs({ prefs: { enterSends: "never", guidance: true } })
    yield* alice.SetDisplayPrefs({ prefs: { reasoning: "collapsed" } })
    assert.strictEqual((yield* bob.GetDisplayPrefs({})).enterSends, "automatic")
    yield* bob.SetDisplayPrefs({ prefs: { enterSends: "always" } })
    const reconnect = yield* client({ "Remote-User": "alice" })
    const prefs = yield* reconnect.GetDisplayPrefs({})
    assert.strictEqual(prefs.enterSends, "never")
    assert.strictEqual(prefs.guidance, true)
    assert.strictEqual(prefs.reasoning, "collapsed")
    assert.strictEqual((yield* bob.GetDisplayPrefs({})).enterSends, "always")
    assert.strictEqual(Schema.decodeUnknownOption(DisplayPrefsChange)({ enterSends: "sometimes" })._tag, "None")
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)

it.live("the chat width persists per account, within its range, without resetting other choices", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    assert.strictEqual((yield* alice.GetDisplayPrefs({})).chatWidth, CHAT_WIDTH.default)
    yield* alice.SetDisplayPrefs({ prefs: { guidance: true } })
    yield* alice.SetDisplayPrefs({ prefs: { chatWidth: 1760 } })
    const reconnect = yield* client({ "Remote-User": "alice" })
    const prefs = yield* reconnect.GetDisplayPrefs({})
    assert.strictEqual(prefs.chatWidth, 1760)
    assert.strictEqual(prefs.guidance, true)
    assert.strictEqual((yield* bob.GetDisplayPrefs({})).chatWidth, CHAT_WIDTH.default)
    const decode = Schema.decodeUnknownOption(DisplayPrefsChange)
    for (const value of [CHAT_WIDTH.min - 1, CHAT_WIDTH.max + 1, 1200.5, "1200px"])
      assert.strictEqual(decode({ chatWidth: value })._tag, "None")
    assert.strictEqual(decode({ chatWidth: CHAT_WIDTH.max })._tag, "Some")
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)
