// Editable note policy. Ownership, audience, effects and receipts stay in the host.
import {
  Effect,
  Type,
  type NoteReadToolV1,
  type NoteSwitchToolV1,
  type NoteViewV1
} from "../../../../plugin-api/src/server.ts"
const safely = <E>(_tool: string, run: Effect.Effect<{ readonly text: string; readonly isError?: boolean }, E>) => run
const named = (notes: ReadonlyArray<NoteViewV1>, title: string) => {
  const wanted = title.trim().toLowerCase()
  const found = notes.filter((n) => n.title.trim().toLowerCase() === wanted)
  if (found.length === 1) return found[0]!
  return {
    text: found.length ? `Several notes are called “${title}”.` : `No note is called “${title}”.`,
    isError: true
  }
}

export const listNotes: NoteReadToolV1<Record<string, never>> = {
  source: import.meta.url,
  id: "list_notes",
  label: "Looked at the notes",
  explanation: "List this chat's notes",
  effect: "read",
  description:
    "Lists the chat's notes and its characters' notes: title, whose it is, whether it's on, and whether you may change it. On notes are already in your context.",
  parameters: Type.Object({}),
  execute: (context) =>
    safely(
      "list_notes",
      Effect.gen(function* () {
        const notes = yield* context.notes
        if (notes.length === 0) return { text: "The chat has no notes." }
        return {
          text: notes
            .map(
              (n) =>
                `“${n.title}” (${n.owner}'s; ${n.active ? "on" : "off"}${n.editable && !n.linked ? "; you may change it" : ""})${
                  n.active ? "" : `: ${n.content.replace(/\s+/g, " ").slice(0, 200)}`
                }`
            )
            .join("\n")
        }
      })
    )
}

export const switchNote: NoteSwitchToolV1<{ readonly note: string; readonly on: boolean }> = {
  source: import.meta.url,
  id: "switch_note",
  label: "Switched a note",
  explanation: "Switch the notes you let it change",
  effect: "chat_state",
  description:
    "Turns one of the notes on or off from the next message on, by its title (list_notes gives them). Only notes you may change.",
  parameters: Type.Object({
    note: Type.String({ description: "The note's title." }),
    on: Type.Boolean({ description: "True to turn it on." })
  }),
  summarize: ({ note, on }) => `“${note}”: ${on ? "on" : "off"}`,
  execute: (context, { note, on }) =>
    safely(
      "switch_note",
      Effect.gen(function* () {
        const target = named(yield* context.notes, note)
        if ("isError" in target) return target
        if (!target.editable) return { text: `You may not change “${target.title}”.`, isError: true }
        const result = yield* context.switch(
          target.entity,
          on,
          `“${target.title}” is ${on ? "on" : "off"} from the next message on.`
        )
        return { text: result }
      })
    )
}
