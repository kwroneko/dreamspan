// A synthetic SillyTavern folder whose author's notes carry things ST places relative to
// them: personas at the note's top and bottom, characters' own author's notes before and
// after it, lorebook entries before and after it, and branches whose author's note differs
// from their parent's. Everything here is made up; the shapes follow ST's public source.
import { png } from "../formats/support.ts"
import { card, encode, header, jsonl, message } from "./stFolder.ts"

const say = (name: string, mes: string, minute: number, user = false, persona?: string) =>
  message({ name, mes, minute, user, ...(persona ? { persona } : {}) })

/** ST's author's note keys in a chat's metadata (`authors-note.js`). */
const note = (prompt: string, position: number, depth: number, role: number, interval = 1) => ({
  note_prompt: prompt,
  note_position: position,
  note_depth: depth,
  note_role: role,
  note_interval: interval
})

const entry = (uid: number, content: string, position: number, depth = 4, role = 0) => ({
  uid,
  key: [],
  keysecondary: [],
  comment: `entry ${uid}`,
  content,
  constant: true,
  selective: false,
  order: 100,
  position,
  disable: false,
  depth,
  role,
  probability: 100,
  useProbability: false
})

const lore = {
  entries: {
    "1": entry(1, "Lore before the note.", 2),
    "2": entry(2, "Lore after the note.", 3),
    "3": entry(3, "Lore at depth one.", 4, 1, 0)
  }
}

const settings = {
  username: "Sam",
  user_avatar: "user.png",
  power_user: {
    personas: { "user.png": "Sam", "rook.png": "Rook" },
    persona_descriptions: {
      "user.png": { description: "Sam is tall and patient.", position: 2, depth: 2, role: 0 },
      "rook.png": { description: "Rook keeps a ledger.", position: 3, depth: 2, role: 0 }
    },
    default_persona: "user.png"
  },
  extension_settings: {
    note: {
      default: "",
      defaultPosition: 1,
      defaultDepth: 1,
      defaultRole: 0,
      defaultInterval: 1,
      chara: [
        { name: "Aria", prompt: "Aria hums when nervous.", useChara: true, position: 1 },
        { name: "Bram", prompt: "Bram limps.", useChara: true, position: 2 }
      ]
    },
    disabledExtensions: []
  }
}

const MAIN = "Aria - main"
const mainMessages = [
  say("Aria", "The lamp is lit.", 0),
  say("Sam", "I came in from the rain.", 1, true, "user.png"),
  say("Aria", "Sit by the fire.", 2),
  say("Sam", "Thank you.", 3, true, "user.png")
]

/**
 * The folder's files under `data/default-user/`. A second import changes the main chat's
 * author's note text (`mainNote`) and adds a message (`later`), to show what a re-import does.
 */
export const authorNoteFolder = (mainNote = "Rain all day.", later = false) =>
  new Map<string, Uint8Array>(
    (
      [
        ["settings.json", encode(settings)],
        ["User Avatars/user.png", png()],
        ["User Avatars/rook.png", png()],
        [
          "characters/Aria.png",
          card("Aria", "The lamp is lit.", {
            world: "Lore",
            depth_prompt: { prompt: "Aria wears a grey coat.", depth: 1, role: "system" }
          })
        ],
        ["characters/Bram.png", card("Bram", "Dust everywhere.")],
        ["worlds/Lore.json", encode(lore)],
        [
          `chats/Aria/${MAIN}.jsonl`,
          jsonl([
            header(note(mainNote, 1, 1, 0)),
            ...mainMessages,
            ...(later ? [say("Aria", "Good night, then.", 7)] : [])
          ])
        ],
        // A branch whose author's note was edited after branching: the owner's checkpoint habit.
        [
          `chats/Aria/${MAIN} - Branch #1.jsonl`,
          jsonl([
            header({ ...note("Snow now.", 1, 1, 0), main_chat: MAIN }),
            ...mainMessages.slice(0, 3),
            say("Sam", "It started snowing.", 4, true, "user.png"),
            say("Aria", "Then stay the night.", 5)
          ])
        ],
        // A branch with its parent's author's note.
        [
          `chats/Aria/${MAIN} - Branch #2.jsonl`,
          jsonl([
            header({ ...note("Rain all day.", 1, 1, 0), main_chat: MAIN }),
            ...mainMessages.slice(0, 3),
            say("Sam", "I should go.", 6, true, "user.png")
          ])
        ],
        // No author's note of its own: ST's default one (empty, at the default depth).
        ["chats/Aria/Aria - plain.jsonl", jsonl([header({}), ...mainMessages.slice(0, 2)])],
        // Frequency 0: ST sends none of it, nor what rides on it.
        ["chats/Aria/Aria - quiet.jsonl", jsonl([header(note("Hush.", 1, 1, 0, 0)), ...mainMessages.slice(0, 2)])],
        // After the main prompt, as the user, with the other persona.
        [
          "chats/Bram/Bram - one.jsonl",
          jsonl([
            header({ ...note("Dust storm.", 0, 4, 1), persona: "rook.png" }),
            say("Bram", "Dust everywhere.", 0),
            say("Rook", "I brought the ledger.", 1, true, "rook.png")
          ])
        ],
        [
          "groups/g.json",
          encode({
            id: "g",
            name: "Both",
            members: ["Aria.png", "Bram.png"],
            disabled_members: [],
            chats: ["Both - 1"]
          })
        ],
        [
          "group chats/Both - 1.jsonl",
          jsonl([
            header(note("Crowded room.", 1, 2, 0)),
            message({ name: "Aria", mes: "Welcome.", minute: 0, avatar: "Aria.png" }),
            message({ name: "Sam", mes: "Thanks.", minute: 1, user: true, persona: "user.png" }),
            message({ name: "Bram", mes: "Hm.", minute: 2, avatar: "Bram.png" })
          ])
        ]
      ] as const
    ).map(([path, bytes]) => [`data/default-user/${path}`, bytes])
  )
