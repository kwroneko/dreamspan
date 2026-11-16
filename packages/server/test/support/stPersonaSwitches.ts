// A synthetic ST folder in the owner's shape where the user switches persona every few hundred
// messages: a long one-to-one chat and a long group chat, each with many branch files (some of
// branches), swipe-heavy replies, and a short second chat of each. Every name and text is made
// up. Each file's last user-side persona is returned, which the import must select there.
import { card, encode, header, jsonl, message } from "./stFolder.ts"
import { png } from "../formats/support.ts"

export const RHEE = { name: "Captain Rhee", avatar: "rhee.png", description: "RHEE-PERSONA-DESCRIPTION." }
export const KIM = { name: "Kim", avatar: "kim.png", description: "KIM-PERSONA-DESCRIPTION." }
export const KAREN = "Karen Holt"
export const INN = { id: "1712345678901", name: "The Lantern Inn", members: ["Tobias Wren", "Aria Vance", "Rook"] }

export interface PersonaFolderOptions {
  /** Messages in each main chat. */
  readonly messages: number
  /** The persona changes every this many messages. */
  readonly switchEvery: number
  readonly singleBranches: number
  readonly groupBranches: number
  readonly seed?: number
}

type Line = ReturnType<typeof message>

export const personaSwitchFolder = (options: PersonaFolderOptions) => {
  let seed = options.seed ?? 4242
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x100000000
  }
  const files = new Map<string, Uint8Array>()
  /** Each chat file's path → the persona of its last user-side message. */
  const lastPersona = new Map<string, string>()
  /** Each chat file's path → the personas that wrote any of its messages. */
  const spoke = new Map<string, ReadonlySet<string>>()
  files.set(
    "settings.json",
    encode({
      power_user: {
        personas: { [RHEE.avatar]: RHEE.name, [KIM.avatar]: KIM.name },
        persona_descriptions: {
          [RHEE.avatar]: { description: RHEE.description, position: 0 },
          [KIM.avatar]: { description: KIM.description, position: 0 }
        },
        default_persona: RHEE.avatar
      }
    })
  )
  files.set(`User Avatars/${RHEE.avatar}`, png())
  files.set(`User Avatars/${KIM.avatar}`, png())
  for (const name of [KAREN, ...INN.members]) files.set(`characters/${name}.png`, card(name, `${name} says hello.`))

  const personaAt = (i: number) => (Math.floor(i / options.switchEvery) % 2 === 0 ? KIM : RHEE)
  /** Message `i` of a chat, `label` keeping branches' own messages apart from their parents'. */
  const line = (i: number, label: string, speakers: ReadonlyArray<string>, group: boolean): Line => {
    if (i % 2 === 1) {
      const persona = personaAt(i)
      return message({
        name: persona.name,
        user: true,
        mes: `${persona.name} (${label}, ${i}) answers.`,
        minute: i,
        persona: persona.avatar
      })
    }
    const name = speakers[(i / 2) % speakers.length]!
    const text = `${name} (${label}, ${i}) speaks.`
    // About 6% of replies have 20 to 50 swipes.
    const swipes =
      random() < 0.06 ? Array.from({ length: 20 + Math.floor(random() * 31) }, (_, s) => `${text} Take ${s}.`) : null
    const selected = swipes === null ? 0 : Math.floor(random() * swipes.length)
    return message({
      name,
      mes: swipes?.[selected] ?? text,
      minute: i,
      ...(group ? { avatar: `${name}.png` } : {}),
      ...(swipes === null ? {} : { swipes, swipeId: selected })
    })
  }
  const note = (path: string, lines: ReadonlyArray<Line>) => {
    const users = lines.filter((l) => l.is_user)
    lastPersona.set(path, users.at(-1)!.name)
    spoke.set(path, new Set(users.map((l) => l.name)))
  }

  /** A main chat and its branches, parents first; returns the file names in order. */
  const family = (
    pathOf: (name: string) => string,
    main: string,
    speakers: ReadonlyArray<string>,
    group: boolean,
    branches: number
  ) => {
    const chats: Array<{ name: string; lines: Array<Line> }> = []
    const mainLines = Array.from({ length: options.messages }, (_, i) => line(i, "main", speakers, group))
    chats.push({ name: main, lines: mainLines })
    for (let k = 1; k <= branches; k++) {
      // A third from the main chat, the rest from an earlier branch: branches of branches.
      const parent = k % 3 === 1 ? chats[0]! : chats[Math.floor(random() * chats.length)]!
      // Anywhere from a third of the way in, so the branches end on either persona.
      const point = Math.max(2, Math.floor(parent.lines.length * (0.3 + random() * 0.69)))
      const own = Array.from({ length: 12 }, (_, i) => line(point + i, `branch ${k}`, speakers, group))
      const ms = String(k).padStart(3, "0")
      const name = `Branch #${point - 1} - 2025-12-27@12h${String(Math.floor(k / 60) % 60).padStart(2, "0")}m${String(k % 60).padStart(2, "0")}s${ms}ms`
      chats.push({ name, lines: [...parent.lines.slice(0, point), ...own] })
      const path = pathOf(name)
      files.set(path, jsonl([header({ main_chat: parent.name }), ...chats.at(-1)!.lines]))
      note(path, chats.at(-1)!.lines)
    }
    files.set(pathOf(main), jsonl([header({}), ...mainLines]))
    note(pathOf(main), mainLines)
    return chats.map((c) => c.name)
  }

  const single = (name: string) => `chats/${KAREN}/${name}.jsonl`
  family(single, `${KAREN} - 2025-11-01@20h00m00s`, [KAREN], false, options.singleBranches)
  // A second, short chat with the card, so it has a group of chats to start a new one in.
  const short = Array.from({ length: 30 }, (_, i) => line(i, "short", [KAREN], false))
  files.set(single(`${KAREN} - 2025-11-20@20h00m00s`), jsonl([header({}), ...short]))
  note(single(`${KAREN} - 2025-11-20@20h00m00s`), short)

  const groupPath = (name: string) => `group chats/${name}.jsonl`
  const groupChats = family(groupPath, "2025-11-02@21h00m00s", INN.members, true, options.groupBranches)
  const groupShort = Array.from({ length: 30 }, (_, i) => line(i + options.switchEvery, "short", INN.members, true))
  files.set(groupPath("2025-11-22@21h00m00s"), jsonl([header({}), ...groupShort]))
  note(groupPath("2025-11-22@21h00m00s"), groupShort)
  files.set(
    `groups/${INN.id}.json`,
    encode({
      id: INN.id,
      name: INN.name,
      members: INN.members.map((m) => `${m}.png`),
      disabled_members: [],
      chats: [...groupChats, "2025-11-22@21h00m00s"],
      chat_id: groupChats[0]
    })
  )
  return { files, lastPersona, spoke }
}
