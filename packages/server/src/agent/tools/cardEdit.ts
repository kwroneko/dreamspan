import { savedToolResult } from "../toolData.ts"
// edit_card (spec/AGENTIC.md §4.6, DESIGN §4.2 [D]): an agent's change to a character's card
// field never edits the card. The passage leaves the field through a chat note replacing the
// field in its place, so the top of the context changes once; the passage as it now is goes in a
// note at the tail, which later edits revise cheaply. Both are this call's effects, attached to
// the reply, so a swipe takes the change back.
import { Type } from "@earendil-works/pi-ai"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { NOTE_SCHEMA_VERSION, REPLACEABLE_CARD_FIELDS, type ReplaceableCardField } from "@dreamspan/shared/docs/note.ts"
import { permissionKey } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import { replaceEffects, replacing } from "../noteTargets.ts"
import type { RolloutTool } from "../tools.ts"
import { safely } from "./history.ts"
import { castMember, noteRefusal, notesAt, replaceOnce } from "./notes.ts"

/** How the model and the notes name each field. */
const FIELD_NAMES: Record<ReplaceableCardField, string> = {
  description: "description",
  personality: "personality",
  scenario: "scenario",
  mes_example: "example dialogue",
  system_prompt: "system prompt",
  post_history_instructions: "post-history instructions"
}

const DEFAULT_WRAP = "[{{char}}'s current {{field}}: {{text}}]"

export const editCard: RolloutTool<{
  readonly character: string
  readonly field: ReplaceableCardField
  readonly find: string
  readonly replace: string
  readonly wrap?: string
}> = {
  source: import.meta.url,
  id: "edit_card",
  label: "Changed a character",
  explanation: "Change the character details you let it change",
  effect: "chat_state",
  description:
    "Changes a passage of a character's card in this chat from the next message on, when the story changes it for good (a new outfit, a lost arm). Give the passage exactly as it stands, once in the field, and what it becomes; to change it again later, give the passage as you last wrote it. The card itself stays as it is. Only fields you may change.",
  parameters: Type.Object({
    character: Type.String({ description: "The character's name." }),
    field: Type.Union(
      REPLACEABLE_CARD_FIELDS.map((f) => Type.Literal(f)),
      { description: "The card field." }
    ),
    find: Type.String({ description: "The passage to change, exactly as it stands." }),
    replace: Type.String({ description: "What it becomes; empty removes it." }),
    wrap: Type.Optional(
      Type.String({ description: `How the changed passage reads, with {{text}} in it. Default: ${DEFAULT_WRAP}` })
    )
  }),
  summarize: ({ character, field }) => `${character}: ${FIELD_NAMES[field] ?? field}`,
  execute: (context, args) =>
    safely(
      "edit_card",
      Effect.gen(function* () {
        const { notes, state, events } = yield* notesAt(context)
        const member = yield* castMember(context, state, args.character)
        if (!member.ok) return member.error
        const place = member.card.entityId as EntityId
        const field = args.field
        const label = FIELD_NAMES[field]
        if (!label) return { text: `Cards have no field “${String(field)}”.`, isError: true }
        const [card] = yield* context.reader.AgentCards({
          userId: context.userId,
          chatId: context.chatId,
          entityIds: [place],
          bindings: Object.fromEntries(
            Object.entries(state.cardBindings).map(([entity, b]) => [
              entity,
              { ref: b.ref ?? null, revision: b.revision ?? null }
            ])
          )
        })
        if (!card) return { text: `${member.name}'s card can't be read.`, isError: true }
        const allowed =
          state.agentPermissions[permissionKey({ card: place, field })!] ?? card.editableFields.includes(field)
        if (!allowed) return { text: `You may not change ${member.name}'s ${label}.`, isError: true }
        const target = { kind: "card_field", field, card: place } as const
        const owner = replacing(notes, target, events)
        if (owner && !owner.editable)
          return { text: `A note you may not change replaces ${member.name}'s ${label}.`, isError: true }
        if (owner?.linked) return { text: noteRefusal(owner)!, isError: true }
        const current = owner?.active ? owner.content : (card.fields[field] ?? "")
        const tailTitle = `${member.name}'s current ${label}`
        const tail = notes.find((n) => n.card === null && n.title === tailTitle) ?? null
        const wrapped = (args.wrap ?? DEFAULT_WRAP)
          .replaceAll("{{char}}", member.name)
          .replaceAll("{{field}}", label)
          .replaceAll("{{text}}", args.replace)
        const fromField = replaceOnce(current, args.find, "")
        // The passage is still in the field: it leaves it, into the tail note.
        if (!("error" in fromField)) {
          const refused = tail && args.replace.trim() ? noteRefusal(tail) : null
          if (refused) return { text: refused, isError: true }
          const inPlace = replaceEffects(
            owner,
            target,
            fromField.text.replace(/\n{3,}/g, "\n\n").trim(),
            `${member.name}'s ${label}`
          )
          const tailNote = !args.replace.trim()
            ? []
            : tail === null
              ? [
                  {
                    create: {
                      schema_version: NOTE_SCHEMA_VERSION,
                      title: tailTitle,
                      content: wrapped,
                      placement: { mode: "tail", role: "system" },
                      exportable: false,
                      agent_editable: true
                    }
                  }
                ]
              : [
                  {
                    revise: {
                      note: tail.entity,
                      parent: tail.revision,
                      doc: { ...tail.doc, content: tail.content ? `${tail.content}\n${wrapped}` : wrapped }
                    }
                  }
                ]
          const { result } = yield* context.writer.ApplyRolloutEffect({
            userId: context.userId,
            rolloutId: context.rolloutId,
            toolCallId: context.toolCallId,
            events: [
              ...[...inPlace.activate, ...(tail && !tail.active && tailNote.length ? [tail.entity] : [])].map(
                (note) => ({
                  key: "note.activate" as const,
                  value: { note }
                })
              )
            ],
            notes: [...inPlace.notes, ...tailNote],
            result: savedToolResult(context, `Changed ${member.name}'s ${label} from the next message on.`)
          })
          return { text: result }
        }
        // Changed before: the passage now stands in the tail note.
        if (tail !== null) {
          const refused = noteRefusal(tail)
          if (refused) return { text: refused, isError: true }
          const inTail = replaceOnce(tail.content, args.find, args.replace)
          if (!("error" in inTail)) {
            const { result } = yield* context.writer.ApplyRolloutEffect({
              userId: context.userId,
              rolloutId: context.rolloutId,
              toolCallId: context.toolCallId,
              events: tail.active ? [] : [{ key: "note.activate", value: { note: tail.entity } }],
              notes: [
                { revise: { note: tail.entity, parent: tail.revision, doc: { ...tail.doc, content: inTail.text } } }
              ],
              result: savedToolResult(context, `Changed ${member.name}'s ${label} from the next message on.`)
            })
            return { text: result }
          }
        }
        return { text: `${fromField.error} (${member.name}'s ${label})`, isError: true }
      })
    )
}
