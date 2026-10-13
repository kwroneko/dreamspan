// A synthetic ST folder for the backfill tests: one card and chats that each begin with a run of
// hidden messages that ST's Summarize extension summarized, followed by a long visible story.
// Every name and text is made up.
import { png } from "../formats/support.ts"
import { card, encode, header, jsonl, message } from "./stFolder.ts"

export const BACKFILL_SUMMARY = "Bob and Sam met at the bridge, and argued about the toll."

/** About 150 estimated tokens: enough that a few dozen messages outgrow a small test window. */
const body = (n: number) => `${n}: ` + "The lantern swung over the bridge and the river ran loud below. ".repeat(9)

const chat = (hidden: number, visible: number) => [
  header({}),
  ...Array.from({ length: hidden }, (_, i) =>
    message({
      name: i % 2 === 0 ? "Bob" : "Sam",
      user: i % 2 === 1,
      hidden: true,
      mes: body(i),
      minute: i,
      ...(i === hidden - 1 ? { memory: BACKFILL_SUMMARY } : {})
    })
  ),
  ...Array.from({ length: visible }, (_, i) =>
    message({
      name: (hidden + i) % 2 === 0 ? "Bob" : "Sam",
      user: (hidden + i) % 2 === 1,
      mes: body(hidden + i),
      minute: hidden + i
    })
  )
]

/** The folder's files under `prefix`: each chat name given has `hidden` hidden messages and `visible` after them. */
export const backfillFolder = (
  prefix: string,
  chats: ReadonlyArray<string>,
  options: { readonly hidden?: number; readonly visible?: number } = {}
): ReadonlyMap<string, Uint8Array> =>
  new Map<string, Uint8Array>([
    [
      `${prefix}settings.json`,
      encode({
        username: "Sam",
        user_avatar: "user.png",
        power_user: {
          personas: { "user.png": "Sam" },
          persona_descriptions: { "user.png": { description: "Sam is curious.", position: 0 } },
          default_persona: "user.png"
        },
        extension_settings: { memory: { position: 1, depth: 3, role: 0, template: "[Story so far: {{summary}}]" } }
      })
    ],
    [`${prefix}User Avatars/user.png`, png()],
    [`${prefix}characters/Bob.png`, card("Bob", "Bob waves.")],
    ...chats.map((name): [string, Uint8Array] => [
      `${prefix}chats/Bob/${name}.jsonl`,
      jsonl(chat(options.hidden ?? 20, options.visible ?? 44))
    ])
  ])
