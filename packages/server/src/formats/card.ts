// Character cards V1, V2 and V3 as parsed JSON, to and from our card document. Detection
// follows ST's import (src/endpoints/characters.js): any `spec` means V2 or V3, otherwise a
// `name` means V1. The specs: github.com/malfoyslastname/character-card-spec-v2 and
// github.com/kwaroran/character-card-spec-v3.
import { CARD_SCHEMA_VERSION, CardAsset, type CardDoc, type CardModule } from "@rp/shared/docs/card.ts"
import { Schema } from "effect"
import { Fields, isFinite, isString, isStringArray } from "./fields.ts"
import { lorebookFromCharacterBook, OUR_EXTENSION } from "./lorebook.ts"
import { fail, type Issues, isObject, type Path } from "./safety.ts"

export type CardVersion = "v1" | "v2" | "v3"

const DATA_KEYS = new Set([
  "name",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator_notes",
  "system_prompt",
  "post_history_instructions",
  "alternate_greetings",
  "character_book",
  "tags",
  "creator",
  "character_version",
  "extensions",
  "assets",
  "nickname",
  "creator_notes_multilingual",
  "source",
  "group_only_greetings",
  "creation_date",
  "modification_date"
])
/**
 * Top-level keys ST writes next to `data`: copies of V1 fields, and its own local state
 * (the chat file, the import date, the favorite flag). They aren't kept; an export writes
 * the V1 copies afresh.
 */
const ROOT_KEYS = new Set([
  "spec",
  "spec_version",
  "data",
  "name",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creatorcomment",
  "creator_notes",
  "tags",
  "talkativeness",
  "fav",
  "avatar",
  "chat",
  "create_date",
  "creator",
  "json_data"
])

const isAsset = Schema.is(CardAsset)
const isLanguageMap = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every(isString)

/** Modules a previous export put in `extensions.rp_harness.modules`, back as modules. */
const liftModules = (extensions: Record<string, unknown>, dataPath: Path, issues: Issues) => {
  const ours = extensions[OUR_EXTENSION]
  if (!isObject(ours) || ours.modules === undefined) return { extensions, modules: [] }
  const path = [...dataPath, "extensions", OUR_EXTENSION]
  const modules: Array<CardModule> = []
  new Fields(ours, path, issues).list("modules").forEach((item, index) => {
    if (isObject(item) && isString(item.id) && isString(item.title) && isString(item.content)) {
      modules.push({ id: item.id, title: item.title, content: item.content, exportable: true })
    } else {
      issues.warn("card.invalid_module", `Module ${index} isn't valid; it was dropped.`, [...path, "modules", index])
    }
  })
  const { modules: _, ...ourRest } = ours
  const { [OUR_EXTENSION]: __, ...rest } = extensions
  return { extensions: Object.keys(ourRest).length > 0 ? { ...rest, [OUR_EXTENSION]: ourRest } : rest, modules }
}

const fromData = (data: Record<string, unknown>, path: Path, issues: Issues): CardDoc => {
  const fields = new Fields(data, path, issues)
  const { extensions, modules } = liftModules(fields.object("extensions"), path, issues)
  const book = fields.value<Record<string, unknown> | undefined>("character_book", undefined, isObject, "an object")
  const assets = fields.list("assets")
  if (!assets.every(isAsset)) {
    issues.warn("field.invalid", "Assets that aren't valid were dropped.", [...path, "assets"])
  }
  return {
    schema_version: CARD_SCHEMA_VERSION,
    name: fields.string("name"),
    description: fields.string("description"),
    personality: fields.string("personality"),
    scenario: fields.string("scenario"),
    first_mes: fields.string("first_mes"),
    mes_example: fields.string("mes_example"),
    alternate_greetings: fields.strings("alternate_greetings"),
    group_only_greetings: fields.strings("group_only_greetings"),
    system_prompt: fields.string("system_prompt"),
    post_history_instructions: fields.string("post_history_instructions"),
    creator_notes: fields.string("creator_notes"),
    ...fields.optional("creator_notes_multilingual", isLanguageMap, "texts by language"),
    ...fields.optional("nickname", isString, "text"),
    ...fields.optional("source", isStringArray, "a list of text"),
    tags: fields.strings("tags", "commas"),
    creator: fields.string("creator"),
    character_version: fields.string("character_version"),
    ...fields.optional("creation_date", isFinite, "a number"),
    ...fields.optional("modification_date", isFinite, "a number"),
    avatar_media_id: null,
    ...(fields.has("assets") ? { assets: assets.filter(isAsset) } : {}),
    ...(book ? { character_book: lorebookFromCharacterBook(book, [...path, "character_book"], issues) } : {}),
    modules,
    extensions,
    ...fields.unknown(DATA_KEYS)
  }
}

/** ST's V1 import: the fields it knows, with its placeholder creator note removed. */
const fromV1 = (root: Record<string, unknown>, issues: Issues): CardDoc => {
  const fields = new Fields(root, [], issues)
  const notes = fields.has("creatorcomment") ? fields.string("creatorcomment") : fields.string("creator_notes")
  const card = fromData(
    {
      name: root.name,
      description: root.description,
      personality: root.personality,
      scenario: root.scenario,
      first_mes: root.first_mes,
      mes_example: root.mes_example,
      creator_notes: notes.replace("Creator's notes go here.", ""),
      creator: root.creator,
      tags: root.tags,
      extensions: fields.has("talkativeness") ? { talkativeness: root.talkativeness } : {}
    },
    [],
    issues
  )
  const { unknown_fields } = fields.unknown(ROOT_KEYS)
  return unknown_fields ? { ...card, unknown_root_fields: unknown_fields } : card
}

/** A parsed card file as our card document. */
export const cardFromJson = (root: unknown, issues: Issues): { card: CardDoc; version: CardVersion } => {
  if (!isObject(root)) return fail("card.not_a_card", "The file isn't a character card.")
  if (root.spec !== undefined && isObject(root.data)) {
    const version: CardVersion = root.spec === "chara_card_v2" ? "v2" : "v3"
    if (root.spec !== "chara_card_v2" && root.spec !== "chara_card_v3") {
      issues.warn("card.unknown_spec", "The card names a spec this app doesn't know; it was read as V3.", ["spec"])
    } else if (version === "v3" && Number.parseFloat(String(root.spec_version)) > 3) {
      issues.info(
        "card.newer_spec",
        "The card was made for a newer V3 spec version; newer fields are kept as they are."
      )
    }
    const card = fromData(root.data, ["data"], issues)
    const { unknown_fields } = new Fields(root, [], issues).unknown(ROOT_KEYS)
    return { card: unknown_fields ? { ...card, unknown_root_fields: unknown_fields } : card, version }
  }
  if (root.spec !== undefined) {
    issues.warn("card.missing_data", "The card names a spec but has no data; its top-level fields were read as V1.", [
      "data"
    ])
  }
  if (typeof root.name === "string") return { card: fromV1(root, issues), version: "v1" }
  return fail("card.not_a_card", "The file isn't a character card.")
}
