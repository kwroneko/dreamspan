// A synthetic ST folder in the owner's shape where every chat file has state of its own: its
// variables, its lorebook (`world_info`), its author's note and the persona of its last user
// message. A one-to-one chat and a group chat each have a long main file and many branch
// files, about 30% of them branches of branches, with own parts long enough that a branch of a
// branch leaves either in its parent's own part or in the part its parent shares with its own
// parent. Each file's state is returned: what its fork must have at its tip, whatever its
// ancestors had where it leaves them. Every name and text is made up.
import { card, encode, header, jsonl, message } from "./stFolder.ts"
import { png, worldInfo } from "../formats/support.ts"
import { INN, KAREN, KIM, RHEE } from "./stPersonaSwitches.ts"

export const WORLDS = ["Lore Amber", "Lore Basalt", "Lore Cobalt"] as const
export const NOTES = ["Keep the lamps low.", "It rains all week.", "The ferry is late."] as const
const MOODS = ["calm", "tense", "merry", "weary"] as const

export interface FileState {
  /** The persona of the file's last user message. */
  readonly persona: string
  readonly personasSpoke: ReadonlySet<string>
  readonly world: string | null
  readonly note: string | null
  readonly vars: Readonly<Record<string, string>>
  /** The file's parent file, and the index of the branch's first message of its own. */
  readonly parent: string | null
  readonly forkAt: number
  /** Whether the branch leaves its parent before the parent's own first message. */
  readonly sharedPart: boolean
}

export interface BranchStateOptions {
  /** Messages in each main chat. */
  readonly messages: number
  /** The main file's persona changes every this many messages. */
  readonly switchEvery: number
  readonly singleBranches: number
  readonly groupBranches: number
  /** The share of branches made from another branch. */
  readonly nested?: number
  readonly seed?: number
}

type Line = ReturnType<typeof message>

export const branchStateFolder = (options: BranchStateOptions) => {
  let seed = options.seed ?? 9001
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x100000000
  }
  const pick = <A>(items: ReadonlyArray<A>) => items[Math.floor(random() * items.length)]!
  const nested = options.nested ?? 0.3
  const files = new Map<string, Uint8Array>()
  const states = new Map<string, FileState>()
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
  for (const world of WORLDS)
    files.set(
      `worlds/${world}.json`,
      encode({ entries: { "3": { ...worldInfo().entries["3"], comment: world, content: `${world}'s entry.` } } })
    )

  /** Message `i`, `label` keeping a file's own messages apart from its parent's. */
  const line = (i: number, label: string, persona: typeof KIM, speakers: ReadonlyArray<string>, group: boolean) => {
    if (i % 2 === 1)
      return message({
        name: persona.name,
        user: true,
        mes: `${persona.name} (${label}, ${i}) answers.`,
        minute: i,
        persona: persona.avatar
      })
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
  /** A file's own state, as its header says it. */
  const metadata = (label: string) => {
    const world = random() < 0.25 ? null : pick(WORLDS)
    const note = random() < 0.25 ? null : pick(NOTES)
    const vars = { mood: pick(MOODS), file: label }
    return {
      world,
      note,
      vars,
      header: {
        variables: vars,
        ...(world === null ? {} : { world_info: world }),
        ...(note === null
          ? {}
          : { note_prompt: note, note_position: 1, note_depth: 2, note_role: 0, note_interval: 1 })
      }
    }
  }

  const family = (
    pathOf: (name: string) => string,
    main: string,
    speakers: ReadonlyArray<string>,
    group: boolean,
    branches: number
  ) => {
    const chats: Array<{ name: string; lines: Array<Line>; ownFrom: number }> = []
    const personaAt = (i: number) => (Math.floor(i / options.switchEvery) % 2 === 0 ? KIM : RHEE)
    const mainLines = Array.from({ length: options.messages }, (_, i) => line(i, "main", personaAt(i), speakers, group))
    chats.push({ name: main, lines: mainLines, ownFrom: 0 })
    const record = (name: string, lines: ReadonlyArray<Line>, meta: ReturnType<typeof metadata>, extra: object) => {
      const users = lines.filter((l) => l.is_user)
      states.set(pathOf(name), {
        persona: users.at(-1)!.name,
        personasSpoke: new Set(users.map((l) => l.name)),
        world: meta.world,
        note: meta.note,
        vars: meta.vars,
        parent: null,
        forkAt: 0,
        sharedPart: false,
        ...extra
      })
    }
    const mainMeta = metadata("main")
    files.set(pathOf(main), jsonl([header(mainMeta.header), ...mainLines]))
    record(main, mainLines, mainMeta, {})
    for (let k = 1; k <= branches; k++) {
      const branchOf = chats.length > 1 && random() < nested
      const parent = branchOf ? chats[1 + Math.floor(random() * (chats.length - 1))]! : chats[0]!
      // A branch of a branch leaves anywhere in its parent, so in its own part or before it.
      const low = branchOf ? 2 : Math.floor(parent.lines.length * 0.2)
      const point = low + Math.floor(random() * (parent.lines.length - low - 1))
      // Own parts of 12 to 300 messages, in one persona or switching part way.
      const length = 12 + Math.floor(random() * 289)
      const first = random() < 0.5 ? KIM : RHEE
      const switchAt = random() < 0.5 ? Math.floor(length / 2) : length
      const label = `branch ${k}`
      const own = Array.from({ length }, (_, i) =>
        line(point + i, label, i < switchAt ? first : first === KIM ? RHEE : KIM, speakers, group)
      )
      const ms = String(k).padStart(3, "0")
      const name = `Branch #${point - 1} - 2025-12-27@12h${String(Math.floor(k / 60) % 60).padStart(2, "0")}m${String(k % 60).padStart(2, "0")}s${ms}ms`
      const lines = [...parent.lines.slice(0, point), ...own]
      chats.push({ name, lines, ownFrom: point })
      const meta = metadata(label)
      files.set(pathOf(name), jsonl([header({ ...meta.header, main_chat: parent.name }), ...lines]))
      record(name, lines, meta, { parent: pathOf(parent.name), forkAt: point, sharedPart: point < parent.ownFrom })
    }
    return chats.map((c) => c.name)
  }

  const single = (name: string) => `chats/${KAREN}/${name}.jsonl`
  family(single, `${KAREN} - 2025-11-01@20h00m00s`, [KAREN], false, options.singleBranches)
  const groupPath = (name: string) => `group chats/${name}.jsonl`
  const groupChats = family(groupPath, "2025-11-02@21h00m00s", INN.members, true, options.groupBranches)
  files.set(
    `groups/${INN.id}.json`,
    encode({
      id: INN.id,
      name: INN.name,
      members: INN.members.map((m) => `${m}.png`),
      disabled_members: [],
      chats: groupChats,
      chat_id: groupChats[0]
    })
  )
  return { files, states }
}
