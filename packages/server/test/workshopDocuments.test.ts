import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { ApprovalPrompt } from "@dreamspan/shared/agent.ts"
import type { SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import type { Doc, RefId } from "@dreamspan/shared/library.ts"
import { textField } from "@dreamspan/shared/editing.ts"
import { type LorebookDoc } from "@dreamspan/shared/docs/lorebook.ts"
import type { PresetDoc } from "@dreamspan/shared/docs/preset.ts"
import type { RegexScript } from "@dreamspan/shared/docs/regexScript.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { makePermit, offeredByGrants } from "../src/agent/approvals.ts"
import { client, login, outcome, posted, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>
const fixture = (dataDir: string, api: Api) =>
  Effect.gen(function* () {
    const user = yield* api.Whoami()
    const chat = yield* api.CreateWorkshop({})
    const rolloutId = `docs-${chat.id}`
    yield* fixtureSql(dataDir, [
      {
        sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES (?,?,'workshop','running','assistant','interactive',1,1)",
        params: [rolloutId, chat.id]
      }
    ])
    const reader = yield* Reader
    const writer = yield* Writer
    const registry = yield* ExecutionRegistry
    const context: ToolContext = {
      userId: user.id,
      chatId: chat.id,
      forkId: null,
      viewers: null,
      slotId: chat.activeLeafSlotId as SlotId,
      versionId: "unused" as VersionId,
      rolloutId,
      toolCallId: "unused",
      leafSlotId: null,
      reader,
      writer,
      cache: new Map()
    }
    const run = (name: string, args: unknown, id = name) =>
      toolForKind(registry, "workshop", name)!.execute({ ...context, toolCallId: id }, args as never)
    const save = (refId: RefId, doc: Doc) =>
      Effect.gen(function* () {
        const saved = yield* api.OpenEditor({ refId })
        return yield* writer.EditRef({
          userId: user.id,
          refId,
          expectedRowVersion: saved.ref.rowVersion,
          doc,
          commitDraft: null,
          message: "Synthetic user save"
        })
      })
    return { user, chat, rolloutId, reader, writer, registry, context, run, save }
  })
const script: RegexScript = {
  id: "one",
  name: "Panel",
  find_regex: "old",
  replace_string: "<b>Old panel</b>",
  trim_strings: [],
  placement: [2],
  disabled: false,
  markdown_only: true,
  prompt_only: false,
  run_on_edit: false,
  substitute_regex: "none",
  min_depth: null,
  max_depth: null
}

describe("workshop preset and lorebook documents", () => {
  it.live(
    "live story bindings follow document edits and exact Undo, while archive only changes the library shelf",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((_request, response) => sse(response, completionChunks(["Ready."], {})))
          ),
          (server) => Effect.promise(() => server.close())
        )
        const api = yield* client()
        const story = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {}
        })
        const f = yield* fixture(config.dataDir, api)
        const preset = yield* api.CreatePreset({ label: "Live story preset" })
        const book = yield* api.CreateLorebook({ label: "Live story book" })
        yield* f.run(
          "edit_preset",
          { preset: preset.id, changes: [{ prompt: "main", text: "Initial story instruction." }] },
          "live-preset-initial"
        )
        yield* f.run(
          "edit_lorebook",
          { lorebook: book.id, changes: [{ add: { uid: 1, constant: true, content: "Initial story fact." } }] },
          "live-book-initial"
        )
        yield* api.ChangeCast({
          chatId: story.chat.id,
          forkId: story.chat.currentForkId,
          slotId: story.version.slotId,
          change: { _tag: "Preset", ref: preset.id }
        })
        yield* api.ChangeCast({
          chatId: story.chat.id,
          forkId: story.chat.currentForkId,
          slotId: story.version.slotId,
          change: { _tag: "Lorebook", ref: book.id, active: true }
        })
        // The changed bindings follow this reply; they must not alter its historical request.
        const next = yield* posted(
          api.SendMessage({
            chatId: story.chat.id,
            parentSlotId: story.version.slotId,
            branch: false,
            content: "Inspect the next synthetic turn."
          })
        )
        const context = () =>
          f.reader
            .AssembleContext({
              userId: f.user.id,
              chatId: story.chat.id,
              slotId: next.entry.slotId,
              versionId: next.entry.version.id,
              frozen: null,
              now: 1,
              timeZone: "UTC"
            })
            .pipe(Effect.map((result) => JSON.stringify(JSON.parse(result.snapshot).request)))
        const initial = yield* context()
        assert.include(initial, "Initial story instruction.")
        assert.include(initial, "Initial story fact.")
        yield* f.run(
          "edit_preset",
          { preset: preset.id, changes: [{ prompt: "main", text: "Changed story instruction." }] },
          "live-preset-edit"
        )
        yield* f.run(
          "edit_lorebook",
          { lorebook: book.id, changes: [{ entry: 1, text: "Changed story fact." }] },
          "live-book-edit"
        )
        const changed = yield* context()
        assert.include(changed, "Changed story instruction.")
        assert.include(changed, "Changed story fact.")
        for (const [kind, ref] of [
          ["preset", preset],
          ["lorebook", book]
        ] as const) {
          const result = yield* f.run(
            "set_ref_archived",
            { kind, item: ref.id, archived: true },
            `live-archive-${kind}`
          )
          assert.isUndefined(result.isError, result.text)
        }
        assert.strictEqual(yield* context(), changed)
        const events: ChatEvent[] = []
        yield* api.SubscribeChat({ chatId: story.chat.id }).pipe(
          Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
          Effect.forkScoped
        )
        yield* eventually(() => events.length > 0)
        const generated = yield* posted(
          api.Generate({ chatId: story.chat.id, parentSlotId: next.entry.slotId, branch: false })
        )
        yield* eventually(() => finished(events, generated.entry.version.id)?.status === "complete")
        assert.include(JSON.stringify(mock.requests().at(-1)!.body), "Changed story instruction.")
        assert.include(JSON.stringify(mock.requests().at(-1)!.body), "Changed story fact.")
        const usedAt = (yield* api.OpenEditor({ refId: preset.id })).ref.lastUsedAt
        assert.isNumber(usedAt)
        const effects = yield* api.ListRolloutEffects({ chatId: f.chat.id })
        for (const kind of ["lorebook", "preset"] as const) {
          yield* api.UndoRolloutEffect(effects.find((e) => e.toolCallId === `live-archive-${kind}`)!)
          yield* api.UndoRolloutEffect(
            effects.find((e) => e.toolCallId === `live-${kind === "lorebook" ? "book" : "preset"}-edit`)!
          )
        }
        assert.strictEqual(yield* context(), initial)
        assert.strictEqual((yield* api.OpenEditor({ refId: preset.id })).ref.lastUsedAt, usedAt)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )
  it.live("refuses a pinned edit after its document is archived while approval waits", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      yield* api.SetWorkshopGrant({ chatId: f.chat.id, capability: "library.write", mode: "ask" })
      for (const kind of ["preset", "lorebook"] as const) {
        const ref =
          kind === "preset"
            ? yield* api.CreatePreset({ label: "Pinned archive preset" })
            : yield* api.CreateLorebook({ label: "Pinned archive book" })
        const old = (yield* api.OpenEditor({ refId: ref.id })).doc
        const tool = toolForKind(f.registry, "workshop", `edit_${kind}`)!
        const args = {
          [kind]: ref.id,
          changes:
            kind === "preset"
              ? [{ prompt: "main", text: "Must not be saved" }]
              : [{ add: { uid: 1, content: "Must not be saved" } }]
        }
        const ctx = { ...f.context, toolCallId: `archive-race-${kind}` }
        let prompt: ApprovalPrompt | null = null
        const pending = yield* makePermit({
          registries: f.registry,
          reader: f.reader,
          writer: f.writer,
          userId: f.user.id,
          chatId: f.chat.id,
          rolloutId: f.rolloutId
        })({
          tool,
          context: ctx,
          args,
          dangling: false,
          onWaiting: (p) => {
            if (p) prompt = p
          }
        }).pipe(Effect.forkScoped)
        yield* eventually(() => prompt !== null)
        yield* api.SetRefArchived({ refId: ref.id, archived: true })
        const asked = prompt as unknown as ApprovalPrompt
        yield* api.AnswerToolApproval({
          rolloutId: asked.rolloutId,
          toolCallId: asked.toolCallId,
          digest: asked.digest,
          answer: "allow"
        })
        const allowed = yield* Fiber.join(pending)
        assert.isTrue(allowed.run)
        const result = yield* tool.execute({ ...ctx, ...allowed }, args as never)
        assert.isTrue(result.isError, result.text)
        assert.include(result.text, "changed")
        assert.deepStrictEqual((yield* api.OpenEditor({ refId: ref.id })).doc, old)
      }
      assert.isEmpty(yield* api.ListRolloutEffects({ chatId: f.chat.id }))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("revision restores refuse permission-only HTML changes without resurrecting old approvals", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const ref = yield* api.CreatePreset({ label: "Old approvals" })
      const initial = yield* api.OpenEditor({ refId: ref.id })
      yield* f.save(ref.id, { ...initial.doc, html_scripts_approved: true, html_network_approved: true })
      const approved = yield* api.OpenEditor({ refId: ref.id })
      yield* f.save(ref.id, { ...initial.doc, html_scripts_approved: false, html_network_approved: false })
      const result = yield* f.run(
        "restore_revision",
        {
          kind: "preset",
          item: ref.id,
          revision: approved.ref.headRevisionId
        },
        "restore-old-approvals"
      )
      assert.isTrue(result.isError, result.text)
      assert.include(result.text, "permissions")
      const after = yield* api.OpenEditor({ refId: ref.id })
      assert.isFalse(after.doc.html_scripts_approved === true)
      assert.isFalse(after.doc.html_network_approved === true)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  for (const kind of ["preset", "lorebook"] as const)
    it.live(`${kind}: each change kind is atomic, recorded once and undone exactly without touching drafts`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const f = yield* fixture(config.dataDir, api)
        const made = yield* f.run(`create_${kind}`, { label: `Document ${kind}` }, "create")
        assert.isUndefined(made.isError, made.text)
        const refId = (JSON.parse(made.text) as { id: RefId }).id
        const initial = yield* api.OpenEditor({ refId })
        const draft = yield* api.SaveEditorDraft({
          refId,
          field: textField(kind === "preset" ? ["prompts", "identifier=main", "content"] : ["description"]),
          content: "My unfinished draft.",
          draftId: null,
          expectedRowVersion: null,
          expectedSession: null,
          baseRevisionId: initial.ref.headRevisionId
        })
        const edits =
          kind === "preset"
            ? [
                [{ add: { identifier: "custom", name: "Custom", content: "aaa" }, before: "main" }],
                [{ prompt: "custom", text: "New light." }],
                [{ prompt: "custom", find: "New", replace: "Bright" }],
                [
                  {
                    prompt: "custom",
                    set: {
                      role: "user",
                      injection_position: "absolute",
                      injection_depth: 3,
                      injection_order: 5,
                      injection_trigger: ["normal"],
                      condition: "with_direction",
                      forbid_overrides: true
                    }
                  }
                ],
                [{ prompt: "custom", enabled: false }],
                [{ prompt: "custom", enabled: true }],
                [{ prompt: "custom", before: null }],
                [
                  {
                    settings: {
                      utility_prompts: {
                        ...(initial.doc as unknown as PresetDoc).utility_prompts,
                        send_if_empty: "Carry on."
                      },
                      pin_examples: true,
                      prefill: { assistant: "At dusk", impersonation: "", continue: false, continue_postfix: "" }
                    }
                  }
                ],
                [{ remove: "custom" }]
              ]
            : [
                [
                  { add: { uid: 10, comment: "Harbor", content: "aaa" } },
                  { add: { uid: 11, content: "Second entry." } }
                ],
                [{ entry: 10, text: "New light." }],
                [{ entry: 10, find: "New", replace: "Bright" }],
                [
                  {
                    entry: 10,
                    set: {
                      keys: ["harbor"],
                      secondary_keys: ["lamp"],
                      position: "at_depth",
                      depth: 7,
                      role: "user",
                      probability: 55,
                      order: 15,
                      sticky: 2,
                      cooldown: 3,
                      delay: 1,
                      group: "coast",
                      group_weight: 20,
                      selective: true,
                      selective_logic: "and_all",
                      placement_override: { mode: "depth", depth: 8 },
                      character_filter: { is_exclude: false, names: [], tags: [] }
                    }
                  }
                ],
                [{ entry: 10, enabled: false }],
                [{ entry: 10, enabled: true }],
                [{ entry: 10, before: null }],
                [
                  {
                    settings: {
                      description: "Harbor facts",
                      scan_depth: 5,
                      token_budget: 600,
                      recursive_scanning: true
                    }
                  }
                ],
                [{ remove: 10 }]
              ]
        const documents: Doc[] = [initial.doc]
        for (const [i, changes] of edits.entries()) {
          const result = yield* f.run(`edit_${kind}`, { [kind]: refId, changes }, `edit-${i}`)
          assert.isUndefined(result.isError, result.text)
          const current = yield* api.OpenEditor({ refId })
          assert.notDeepEqual(current.doc, documents.at(-1))
          if (i === 0) {
            const target = kind === "preset" ? { prompt: "custom" } : { entry: 10 }
            const overlap = yield* f.run(
              `edit_${kind}`,
              { [kind]: refId, changes: [{ ...target, find: "aa", replace: "X" }] },
              "overlap"
            )
            assert.isTrue(overlap.isError)
            assert.include(overlap.text, "Find must occur exactly once")
            assert.deepStrictEqual((yield* api.OpenEditor({ refId })).doc, current.doc)
          }
          documents.push(current.doc)
          assert.strictEqual(current.drafts.find((d) => d.id === draft.id)?.content, draft.content)
          assert.deepStrictEqual(
            yield* f.run(`edit_${kind}`, { invalid: true }, `edit-${i}`),
            result,
            "Receipt wins even after argument changes"
          )
          const effects = yield* api.ListRolloutEffects({ chatId: f.chat.id })
          assert.lengthOf(
            effects.filter((e) => e.toolCallId === `edit-${i}`),
            1
          )
        }
        const effects = yield* api.ListRolloutEffects({ chatId: f.chat.id })
        for (let i = edits.length - 1; i >= 0; i--) {
          yield* api.UndoRolloutEffect(effects.find((e) => e.toolCallId === `edit-${i}`)!)
          const current = yield* api.OpenEditor({ refId })
          assert.deepStrictEqual(current.doc, documents[i])
          assert.strictEqual(current.drafts.find((d) => d.id === draft.id)?.content, draft.content)
        }
        const [rows] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: "SELECT origin, origin_ref FROM entity_revisions WHERE entity_id = ? AND origin = 'agent'",
              params: [initial.ref.entityId]
            }
          ],
          { readOnly: true }
        )
        assert.lengthOf(rows!, edits.length + 1)
        assert.isTrue(rows!.every((r) => String(r.origin_ref).startsWith(f.rolloutId)))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })

  it.live(
    "leaves changed regex, HTML and script-bearing entry fields off, even through raw writes and restoration; user Undo restores the prior document exactly",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const f = yield* fixture(config.dataDir, api)
        const preset = yield* api.CreatePreset({ label: "Approved original" })
        const saved = yield* api.OpenEditor({ refId: preset.id })
        yield* f.save(preset.id, {
          ...saved.doc,
          regex: [script],
          regex_approved: true,
          html_scripts_approved: true,
          html_network_approved: true
        })
        const approved = yield* api.OpenEditor({ refId: preset.id })
        const changedPrefill = yield* f.run(
          "edit_preset",
          {
            preset: preset.id,
            changes: [
              {
                settings: {
                  prefill: {
                    assistant: "<script>newPanel()</script>",
                    impersonation: "",
                    continue: false,
                    continue_postfix: ""
                  }
                }
              }
            ]
          },
          "prefill-code"
        )
        assert.isUndefined(changedPrefill.isError, changedPrefill.text)
        const newPanel = yield* api.OpenEditor({ refId: preset.id })
        assert.isFalse(newPanel.doc.html_scripts_approved === true)
        assert.isFalse(newPanel.doc.html_network_approved === true)
        yield* api.UndoRolloutEffect(
          (yield* api.ListRolloutEffects({ chatId: f.chat.id })).find((e) => e.toolCallId === "prefill-code")!
        )
        assert.deepStrictEqual((yield* api.OpenEditor({ refId: preset.id })).doc, approved.doc)
        const changed = yield* f.run(
          "edit_preset",
          {
            preset: preset.id,
            changes: [{ settings: { regex: [{ ...script, replace_string: "<script>test()</script>" }] } }]
          },
          "regex"
        )
        assert.isUndefined(changed.isError, changed.text)
        const after = yield* api.OpenEditor({ refId: preset.id })
        assert.strictEqual(after.doc.regex_approved, false)
        assert.strictEqual(after.doc.html_scripts_approved, false)
        assert.strictEqual((after.doc.regex as RegexScript[])[0]!.disabled, true)
        const effect = (yield* api.ListRolloutEffects({ chatId: f.chat.id }))[0]!
        yield* api.UndoRolloutEffect(effect)
        assert.deepStrictEqual((yield* api.OpenEditor({ refId: preset.id })).doc, approved.doc)
        const raw = yield* f.writer.AgentReviseEntity({
          userId: f.user.id,
          rolloutId: f.rolloutId,
          toolCallId: "raw",
          refId: preset.id,
          expectedRowVersion: (yield* api.OpenEditor({ refId: preset.id })).ref.rowVersion,
          doc: { ...approved.doc, regex: [{ ...script, find_regex: "new" }], html_scripts_approved: true }
        })
        assert.isString(raw.text)
        assert.strictEqual((yield* api.OpenEditor({ refId: preset.id })).doc.html_scripts_approved, false)
        const restored = yield* f.run(
          "restore_revision",
          { kind: "preset", item: preset.id, revision: approved.ref.headRevisionId },
          "restore-code"
        )
        assert.isUndefined(restored.isError, restored.text)
        assert.strictEqual(
          ((yield* api.OpenEditor({ refId: preset.id })).doc.regex as RegexScript[])[0]!.disabled,
          true
        )
        const html = yield* f.run(
          "edit_preset",
          {
            preset: preset.id,
            changes: [{ add: { identifier: "html", content: "<script>test()</script>" }, enabled: true }]
          },
          "html"
        )
        assert.isUndefined(html.isError, html.text)
        assert.isFalse(
          ((yield* api.OpenEditor({ refId: preset.id })).doc as unknown as PresetDoc).order.find(
            (p) => p.identifier === "html"
          )!.enabled
        )
        const { text: rawCreationText } = yield* f.writer.AgentCreateEntity({
          userId: f.user.id,
          rolloutId: f.rolloutId,
          toolCallId: "raw-create",
          kind: "preset",
          label: "Raw executable preset",
          doc: { ...approved.doc, regex: [{ ...script, replace_string: "<script>newCode()</script>" }] },
          tags: []
        })
        const rawCreation = JSON.parse(rawCreationText) as { id: RefId }
        const rawCreated = yield* api.OpenEditor({ refId: rawCreation.id })
        assert.isFalse(rawCreated.doc.regex_approved)
        assert.isTrue((rawCreated.doc.regex as RegexScript[])[0]!.disabled)
        const book = yield* api.CreateLorebook({ label: "Regex book" })
        for (const [i, fields] of [
          { use_regex: true, keys: ["/lamp/i"] },
          { use_regex: false, keys: ["/lamp/i"] },
          { use_regex: false, secondary_keys: ["/lamp/i"] },
          { use_regex: false, keys: ["{{getvar::pattern}}"] },
          { content: "<b>HTML entry</b>" },
          { automation_id: "script-action" },
          { extensions: { "test:script": "run()" } }
        ].entries()) {
          const result = yield* f.run(
            "edit_lorebook",
            { lorebook: book.id, changes: [{ add: { uid: i, enabled: true, ...fields } }] },
            `entry-code-${i}`
          )
          assert.isUndefined(result.isError, result.text)
          assert.isFalse(
            ((yield* api.OpenEditor({ refId: book.id })).doc as unknown as LorebookDoc).entries.at(-1)!.enabled
          )
          const enabled = yield* f.run(
            "edit_lorebook",
            { lorebook: book.id, changes: [{ entry: i, enabled: true }] },
            `entry-enable-${i}`
          )
          assert.isUndefined(enabled.isError, enabled.text)
          assert.isFalse(
            ((yield* api.OpenEditor({ refId: book.id })).doc as unknown as LorebookDoc).entries.at(-1)!.enabled
          )
        }
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live(
    "archive and restore use owner-resolved exposures, pin approvals, preserve drafts, undo exactly and refuse after later edits",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const f = yield* fixture(config.dataDir, api)
        for (const kind of ["preset", "lorebook"] as const) {
          const ref =
            kind === "preset"
              ? yield* api.CreatePreset({ label: "Archive preset" })
              : yield* api.CreateLorebook({ label: "Archive book" })
          const saved = yield* api.OpenEditor({ refId: ref.id })
          const field = textField(kind === "preset" ? ["prompts", "identifier=main", "content"] : ["description"])
          const draft = yield* api.SaveEditorDraft({
            refId: ref.id,
            field,
            content: "Unfinished.",
            draftId: null,
            expectedRowVersion: null,
            expectedSession: null,
            baseRevisionId: ref.headRevisionId
          })
          for (const archived of [true, false]) {
            const result = yield* f.run("set_ref_archived", { kind, item: ref.id, archived }, `${kind}-${archived}`)
            assert.isUndefined(result.isError, result.text)
            assert.strictEqual((yield* api.OpenEditor({ refId: ref.id })).ref.archivedAt !== null, archived)
          }
          yield* f.run(
            `edit_${kind}`,
            {
              [kind]: ref.id,
              changes:
                kind === "preset"
                  ? [{ prompt: "main", text: "Agent save." }]
                  : [{ settings: { description: "Agent save." } }]
            },
            `${kind}-edit`
          )
          const beforeRestore = (yield* api.OpenEditor({ refId: ref.id })).doc
          const result = yield* f.run(
            "restore_revision",
            { kind, item: ref.id, revision: saved.ref.headRevisionId },
            `${kind}-restore`
          )
          assert.isUndefined(result.isError, result.text)
          const restored = yield* api.OpenEditor({ refId: ref.id })
          assert.deepStrictEqual(restored.doc, saved.doc)
          assert.strictEqual(restored.drafts.find((d) => d.id === draft.id)?.content, "Unfinished.")
          const effect = (yield* api.ListRolloutEffects({ chatId: f.chat.id })).find(
            (e) => e.toolCallId === `${kind}-restore`
          )!
          yield* api.UndoRolloutEffect(effect)
          assert.deepStrictEqual((yield* api.OpenEditor({ refId: ref.id })).doc, beforeRestore)
          assert.strictEqual(
            (yield* api.OpenEditor({ refId: ref.id })).drafts.find((d) => d.id === draft.id)?.content,
            "Unfinished."
          )
          // Archive and unarchive each carry their exact previous timestamp and document.
          for (const archived of [true, false]) {
            yield* api.SetRefArchived({ refId: ref.id, archived: !archived })
            const prior = yield* api.OpenEditor({ refId: ref.id })
            const callId = `${kind}-undo-archive-${archived}`
            const changed = yield* f.run("set_ref_archived", { kind, item: ref.id, archived }, callId)
            assert.isUndefined(changed.isError, changed.text)
            const receipt = (yield* api.ListRolloutEffects({ chatId: f.chat.id })).find((e) => e.toolCallId === callId)!
            yield* api.UndoRolloutEffect(receipt)
            const undone = yield* api.OpenEditor({ refId: ref.id })
            assert.strictEqual(undone.ref.archivedAt, prior.ref.archivedAt)
            assert.deepStrictEqual(undone.doc, prior.doc)
            assert.strictEqual(undone.drafts.find((d) => d.id === draft.id)?.content, "Unfinished.")
          }
          const edited = (yield* api.ListRolloutEffects({ chatId: f.chat.id })).find(
            (e) => e.toolCallId === `${kind}-edit`
          )!
          yield* f.save(ref.id, { ...beforeRestore, extensions: { "test:user": true } })
          assert.strictEqual(yield* outcome(api.UndoRolloutEffect(edited)), "EffectUndoRefused")
        }
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("checks schemas, sizes, names, kinds and atomic errors without changing stories", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const story = yield* api.CreateChat({ title: "Untouched story" })
      const snapshot = () =>
        fixtureSql(
          config.dataDir,
          [
            { sql: "SELECT * FROM chats WHERE id = ?", params: [story.id] },
            { sql: "SELECT * FROM slots WHERE chat_id = ?", params: [story.id] },
            { sql: "SELECT * FROM state_events WHERE chat_id = ?", params: [story.id] }
          ],
          { readOnly: true }
        )
      const beforeStory = yield* snapshot()
      for (const kind of ["preset", "lorebook"] as const) {
        const refs = []
        for (let i = 0; i < 2; i++)
          refs.push(
            kind === "preset"
              ? yield* api.CreatePreset({ label: "Duplicate" })
              : yield* api.CreateLorebook({ label: "Duplicate" })
          )
        const changes =
          kind === "preset" ? [{ prompt: "main", text: "Changed" }] : [{ settings: { description: "Changed" } }]
        const ambiguous = yield* f.run(`edit_${kind}`, { [kind]: "Duplicate", changes }, `${kind}-ambiguous`)
        assert.isTrue(ambiguous.isError)
        for (const ref of refs) assert.include(ambiguous.text, ref.id)
        for (const [i, changes] of [
          [{ settings: { regex_approved: true } }],
          [{ settings: { unknown: true } }],
          [{ settings: { description: "x".repeat(65_537) } }],
          kind === "preset"
            ? [{ prompt: "main", text: "Partial" }, { remove: "missing" }]
            : [{ add: { uid: 1 } }, { remove: 999 }],
          kind === "preset" ? [{ remove: "main" }] : [{ add: { uid: 1 } }, { add: { uid: 1 } }],
          kind === "preset"
            ? [{ prompt: "main", set: { injection_depth: -1 } }]
            : [{ entry: 0, set: { probability: "wrong" } }]
        ].entries()) {
          const old = (yield* api.OpenEditor({ refId: refs[0]!.id })).doc
          const failed = yield* f.run(`edit_${kind}`, { [kind]: refs[0]!.id, changes }, `${kind}-bad-${i}`)
          assert.isTrue(failed.isError, failed.text)
          assert.deepStrictEqual((yield* api.OpenEditor({ refId: refs[0]!.id })).doc, old)
        }
        const good = yield* f.run(`edit_${kind}`, { [kind]: refs[0]!.id, changes }, `${kind}-good`)
        assert.isUndefined(good.isError, good.text)
      }
      assert.deepStrictEqual(yield* snapshot(), beforeStory)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live(
    "Off refuses every W7 tool; Ask first binds one exact call and saved document, and decline changes nothing",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const f = yield* fixture(config.dataDir, api)
        const preset = yield* api.CreatePreset({ label: "Pinned preset" })
        const book = yield* api.CreateLorebook({ label: "Pinned book" })
        const cases = [
          ["edit_preset", { preset: preset.id, changes: [{ prompt: "main", text: "Approved text" }] }],
          ["edit_lorebook", { lorebook: book.id, changes: [{ add: { uid: 1, content: "Approved fact" } }] }],
          ["create_preset", { label: "Approved preset" }],
          ["create_lorebook", { label: "Approved book" }],
          ["set_ref_archived", { kind: "preset", item: preset.id, archived: true }],
          ["restore_revision", { kind: "preset", item: preset.id, revision: preset.headRevisionId }]
        ] as const
        const permit = makePermit({
          registries: f.registry,
          reader: f.reader,
          writer: f.writer,
          userId: f.user.id,
          chatId: f.chat.id,
          rolloutId: f.rolloutId
        })
        yield* api.SetWorkshopGrant({ chatId: f.chat.id, capability: "library.write", mode: "off" })
        for (const [id, args] of cases) {
          const tool = toolForKind(f.registry, "workshop", id)!
          assert.strictEqual(tool.capability, "library.write")
          assert.isFalse(
            (yield* permit({
              tool,
              context: { ...f.context, toolCallId: `off-${id}` },
              args,
              dangling: false,
              onWaiting: () => assert.fail("Off must not wait")
            })).run
          )
          assert.isTrue((yield* f.run(id, args, `off-${id}`)).isError)
        }
        const tools = cases.map(([id]) => toolForKind(f.registry, "workshop", id)!)
        assert.isEmpty(
          (yield* offeredByGrants(
            { registries: f.registry, reader: f.reader, userId: f.user.id, chatId: f.chat.id },
            tools
          )).tools
        )
        yield* api.SetWorkshopGrant({ chatId: f.chat.id, capability: "library.write", mode: "ask" })
        assert.deepStrictEqual(
          (yield* offeredByGrants(
            { registries: f.registry, reader: f.reader, userId: f.user.id, chatId: f.chat.id },
            tools
          )).tools,
          tools
        )
        for (const [id, args] of cases) {
          const tool = toolForKind(f.registry, "workshop", id)!
          const ctx = { ...f.context, toolCallId: `ask-${id}` }
          let prompt: ApprovalPrompt | null = null
          const fiber = yield* permit({
            tool,
            context: ctx,
            args,
            dangling: false,
            onWaiting: (p) => {
              if (p) prompt = p
            }
          }).pipe(Effect.forkScoped)
          yield* eventually(() => prompt !== null)
          const asked = prompt as unknown as ApprovalPrompt
          if (id.startsWith("edit_")) {
            assert.isNotEmpty(asked.changes)
            assert.include(JSON.stringify(asked.changes), id === "edit_preset" ? "Approved text" : "Approved fact")
            assert.include(JSON.stringify(asked.rows), "stays disabled or unapproved")
          }
          assert.strictEqual(
            yield* outcome(
              api.AnswerToolApproval({
                rolloutId: asked.rolloutId,
                toolCallId: asked.toolCallId,
                digest: "another call",
                answer: "allow"
              })
            ),
            "ApprovalRefused"
          )
          yield* api.AnswerToolApproval({
            rolloutId: asked.rolloutId,
            toolCallId: asked.toolCallId,
            digest: asked.digest,
            answer: id.startsWith("edit_") ? "allow" : "deny"
          })
          const allowed = yield* Fiber.join(fiber)
          if (allowed.run) {
            const ref = id === "edit_preset" ? preset : book
            const current = yield* api.OpenEditor({ refId: ref.id })
            yield* f.save(ref.id, { ...current.doc, extensions: { "test:changed": true } })
            const refused = yield* tool.execute({ ...ctx, ...allowed }, args as never)
            assert.isTrue(refused.isError)
            assert.include(refused.text, "changed")
          } else assert.include(allowed.text, "declined")
        }
        assert.isEmpty(yield* api.ListRolloutEffects({ chatId: f.chat.id }))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("isolates every preset/lorebook target from other owners", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const local = yield* client()
      const owner = yield* local.Whoami()
      yield* local.SetPassword({ userId: owner.id, currentPassword: null, newPassword: "alice-password" })
      const alice = yield* client({ cookie: (yield* login(owner.handle, "alice-password")).cookie })
      yield* alice.CreateUser({ handle: "bob", displayName: "Bob", role: "user", password: "bob-password" })
      const bob = yield* client({ cookie: (yield* login("bob", "bob-password")).cookie })
      const a = yield* fixture(config.dataDir, alice)
      const b = yield* fixture(config.dataDir, bob)
      const foreignBook = yield* alice.CreateLorebook({ label: "Private attachment" })
      const ownPreset = yield* bob.CreatePreset({ label: "Own attachment preset" })
      const attachment = yield* b.run(
        "edit_preset",
        {
          preset: ownPreset.id,
          changes: [{ settings: { lorebooks: [{ id: foreignBook.id, enabled: true }] } }]
        },
        "foreign-attachment"
      )
      assert.isTrue(attachment.isError, attachment.text)
      const attachmentHead = yield* bob.OpenEditor({ refId: ownPreset.id })
      assert.strictEqual(
        yield* outcome(
          b.writer.AgentReviseEntity({
            userId: b.user.id,
            rolloutId: b.rolloutId,
            toolCallId: "raw-foreign-attachment",
            refId: ownPreset.id,
            expectedRowVersion: attachmentHead.ref.rowVersion,
            doc: { ...attachmentHead.doc, lorebooks: [{ id: foreignBook.id, enabled: true }] }
          })
        ),
        "NotFound",
        "The writer checks ownership independently of the tool adapter"
      )
      for (const kind of ["preset", "lorebook"] as const) {
        const ref =
          kind === "preset"
            ? yield* alice.CreatePreset({ label: "Private preset" })
            : yield* alice.CreateLorebook({ label: "Private book" })
        for (const [tool, args] of [
          [
            `edit_${kind}`,
            {
              [kind]: ref.id,
              changes: kind === "preset" ? [{ prompt: "main", text: "Stolen" }] : [{ add: { uid: 1 } }]
            }
          ],
          ["set_ref_archived", { kind, item: ref.id, archived: true }],
          ["restore_revision", { kind, item: ref.id, revision: ref.headRevisionId }]
        ] as const)
          assert.isTrue((yield* b.run(tool, args)).isError)
        const result = yield* a.run(`edit_${kind}`, {
          [kind]: ref.id,
          changes: kind === "preset" ? [{ prompt: "main", text: "Owned" }] : [{ add: { uid: 1 } }]
        })
        assert.isUndefined(result.isError, result.text)
        const effect = (yield* alice.ListRolloutEffects({ chatId: a.chat.id }))[0]!
        assert.strictEqual(yield* outcome(bob.UndoRolloutEffect(effect)), "NotFound")
        assert.strictEqual(yield* outcome(bob.ListRolloutEffects({ chatId: a.chat.id })), "NotFound")
      }
      assert.isEmpty(yield* bob.ListRolloutEffects({ chatId: b.chat.id }))
      // Even a malformed stored recipe cannot copy a different owner's revision into
      // an owned target. Both exact-document and generic operation undos check this.
      const secret = yield* alice.CreatePreset({ label: "Private undo source" })
      const own = yield* bob.CreatePreset({ label: "Own undo target" })
      const original = (yield* bob.OpenEditor({ refId: own.id })).doc
      const refusedRecipe = yield* outcome(
        b.writer.RecordRolloutEffects({
          userId: b.user.id,
          rolloutId: b.rolloutId,
          toolCallId: "foreign-document-recipe",
          result: "Synthetic malformed recipe",
          effects: [
            {
              kind: "library.revise",
              targetKind: "entity",
              targetId: own.entityId,
              title: "Synthetic malformed recipe",
              undo: {
                refId: own.id,
                before: secret.headRevisionId,
                beforeRowVersion: own.rowVersion,
                head: own.headRevisionId,
                rowVersion: own.rowVersion,
                exactDocument: true,
                archivedAt: null
              }
            }
          ]
        })
      )
      assert.strictEqual(
        refusedRecipe,
        "StorageError:constraint",
        "The baseline also rejects a foreign flat revision recipe"
      )
      assert.deepStrictEqual((yield* bob.OpenEditor({ refId: own.id })).doc, original)
      yield* b.run(
        "rename_ref",
        { kind: "preset", item: own.id, label: "Renamed own target", subtitle: "" },
        "owned-rename"
      )
      const renamed = (yield* bob.ListRolloutEffects({ chatId: b.chat.id })).find(
        (e) => e.toolCallId === "owned-rename"
      )!
      const forged = structuredClone(renamed.undo!)
      const prior = forged.prior as { ref: { head_revision_id: string } }
      prior.ref.head_revision_id = secret.headRevisionId
      yield* b.writer.RecordRolloutEffects({
        userId: b.user.id,
        rolloutId: b.rolloutId,
        toolCallId: "foreign-operation-recipe",
        result: "Synthetic malformed operation recipe",
        effects: [
          {
            kind: "library.revise",
            targetKind: "entity",
            targetId: own.entityId,
            title: "Synthetic malformed operation recipe",
            undo: forged
          }
        ]
      })
      const malformedOperation = (yield* bob.ListRolloutEffects({ chatId: b.chat.id })).find(
        (e) => e.toolCallId === "foreign-operation-recipe"
      )!
      assert.strictEqual(yield* outcome(bob.UndoRolloutEffect(malformedOperation)), "EffectUndoRefused")
      assert.deepStrictEqual((yield* bob.OpenEditor({ refId: own.id })).doc, original)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
