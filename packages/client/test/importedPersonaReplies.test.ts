// Who replies in a chat imported from ST where the user played two personas (DESIGN §2.2): the
// cast the import leaves (importedPersonas.test.ts on the server): the characters and the last
// persona, which the user plays, with the other persona's card kept only to name its messages.
// No reply policy, round, Next face or Speak-now list ever picks that other persona, however
// recently or often it spoke, in one-to-one and group chats alike.
import { assert, it } from "@effect/vitest"
import { CastCard, type EntityId, type PathEntry } from "@rp/shared/chat.ts"
import { Cast } from "@rp/shared/chatSetupApi.ts"
import { Effect } from "effect"
import { replyFaces } from "../src/features/chat/cast.ts"
import { nextInTurn, planReply, replyPolicies } from "../src/features/chat/replyPolicy.ts"

const card = (id: EntityId, name: string, persona = false) =>
  new CastCard({
    entityId: id,
    name,
    label: name,
    persona,
    inBin: false,
    talkativeness: 1,
    lorebook: false,
    avatarMediaId: null
  })

const castOf = (characters: Array<EntityId>, persona: EntityId, cards: Array<CastCard>, replyOrder?: string) =>
  new Cast({
    slotId: null,
    participants: [...characters, persona],
    absent: [],
    playedByMe: [persona],
    model: null,
    preset: null,
    lorebooks: [],
    cardLorebooksOff: [],
    listedLorebooks: [],
    loreBelowHistory: true,
    macroBindings: {},
    macroNames: { user: "Captain Rhee", char: "" },
    rolesProjection: null,
    roleProjections: [],
    cards,
    ...(replyOrder === undefined ? {} : { replyOrder })
  })

const turn = (n: number, speaker: EntityId, writer: "human" | "model", content: string) =>
  ({ version: { id: `v${n}`, speakerEntityId: speaker, writer, content } }) as unknown as PathEntry

const rhee = "synthetic-rhee" as EntityId
const kim = "synthetic-kim" as EntityId
const karen = "synthetic-karen" as EntityId
const tobias = "synthetic-tobias" as EntityId
const aria = "synthetic-aria" as EntityId
const rook = "synthetic-rook" as EntityId
const cards = [
  card(rhee, "Captain Rhee", true),
  card(kim, "Kim", true),
  card(karen, "Karen Holt"),
  card(tobias, "Tobias Wren"),
  card(aria, "Aria Vance"),
  card(rook, "Rook")
]

/** Kim for 300 messages, then Captain Rhee: Kim's turns name everyone, and Kim by name. */
const history = (characters: ReadonlyArray<EntityId>) =>
  Array.from({ length: 600 }, (_, i) =>
    i % 2 === 1
      ? turn(i, i < 300 ? kim : rhee, "human", i < 300 ? "Kim waves at Kim, Karen and Rook." : "Rhee nods.")
      : turn(i, characters[(i / 2) % characters.length]!, "model", "Kim? Where did Kim go?")
  )

it.effect("an imported chat's other persona is never picked to reply", () =>
  Effect.gen(function* () {
    for (const characters of [[karen], [tobias, aria, rook]]) {
      const entries = history(characters)
      for (const order of ["natural", "list", "pooled", "manual", "round-robin"]) {
        assert.isDefined(replyPolicies.get(order), order)
        const cast = castOf(characters, rhee, cards, order)
        // From the tip, with Kim named in what's typed, and with Kim's turn at the tip.
        const tips = [entries, [...entries, turn(600, kim, "human", "Kim speaks again.")]]
        for (const path of tips)
          for (const input of [null, "", "Kim, Karen, Rook: what now?"]) {
            for (const speaker of [rhee, kim, null]) {
              const next = nextInTurn(cast, path, speaker, input)
              const plan = planReply(cast, path, speaker, null, input)
              const picked = [next?.id, ...(next?.then ?? []), plan.replier, ...plan.round].filter(
                (id) => id !== undefined && id !== null
              )
              assert.notInclude(picked, kim, `${order} ${String(input)}`)
              assert.notInclude(picked, rhee, `${order} ${String(input)}`)
              for (const id of picked) assert.include(characters, id)
            }
          }
        assert.sameMembers(replyFaces(cast, rhee), characters)
        assert.sameMembers(replyFaces(cast, kim), characters)
      }
    }
  })
)

it.effect("a turn the user wrote as a persona no longer in the chat is the user's turn", () =>
  Effect.gen(function* () {
    // Pooled: someone who hasn't spoken since the user's last turn, at random. Kim's turn at the
    // tip is that turn, so both characters are fresh; were it not, both would have spoken since
    // and only Tobias, not the last to speak, could be picked.
    const cast = castOf([tobias, aria], rhee, cards, "pooled")
    const picks = new Set<EntityId | undefined>()
    for (let n = 0; n < 40; n++) {
      const path = [
        turn(0, tobias, "model", "Hello."),
        turn(1, aria, "model", "Hey."),
        turn(n + 2, kim, "human", "Hi.")
      ]
      picks.add(nextInTurn(cast, path, rhee, null)?.id)
    }
    assert.sameMembers([...picks], [tobias, aria])
  })
)
