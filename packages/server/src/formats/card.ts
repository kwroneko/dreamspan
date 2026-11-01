// Character cards V1, V2 and V3 as parsed JSON, to and from our card document. Detection
// follows ST's import (src/endpoints/characters.js): any `spec` means V2 or V3, otherwise a
// `name` means V1. The specs: github.com/malfoyslastname/character-card-spec-v2 and
// github.com/kwaroran/character-card-spec-v3.
import { parseStCreatedAt } from "./stCreatedAt.ts"
import { CARD_SCHEMA_VERSION, CardAsset, type CardDoc } from "@rp/shared/docs/card.ts"
import type { ReportBuilder } from "@rp/shared/importReport.ts"
import { Predicate, Schema } from "effect"
import { Fields, isFiniteNumber } from "./fields.ts"
import { lorebookFromCharacterBook } from "./lorebook.ts"
import { readRegex } from "./preset.ts"
import { fail, type Limits, type Path } from "./safety.ts"

type CardVersion = "v1" | "v2" | "v3"

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
const isStringArray = (value: unknown): value is Array<string> =>
  Array.isArray(value) && value.every(Predicate.isString)
/** Only text and numbers are read as a version: anything else could run code on conversion. */
const specVersion = (value: unknown) =>
  Predicate.isString(value) || Predicate.isNumber(value) ? Number.parseFloat(String(value)) : Number.NaN
const isLanguageMap = (value: unknown): value is Record<string, string> =>
  Predicate.isObject(value) && Object.values(value).every(Predicate.isString)

const fromData = (data: Record<string, unknown>, path: Path, limits: Limits, issues: ReportBuilder): CardDoc => {
  const fields = new Fields(data, path, issues)
  // Notes an export put in `extensions.rp_harness` stay there: the importer makes them card notes.
  // ST's scoped regex scripts become the card's `regex`, as data; the file's approval, if any,
  // is never read (DESIGN §11).
  const { regex_scripts, ...extensions } = fields.object("extensions")
  const regex = readRegex(regex_scripts, issues, [...path, "extensions", "regex_scripts"], "card")
  const book = fields.value<Record<string, unknown> | undefined>(
    "character_book",
    undefined,
    Predicate.isObject,
    "an object"
  )
  const assets = fields.list("assets")
  if (!assets.every(isAsset)) {
    issues.add("warning", "field.invalid", "Assets that aren't valid were dropped.", [...path, "assets"])
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
    ...fields.optional("nickname", Predicate.isString, "text"),
    ...fields.optional("source", isStringArray, "a list of text"),
    tags: fields.strings("tags", "commas"),
    creator: fields.string("creator"),
    character_version: fields.string("character_version"),
    ...fields.optional("creation_date", isFiniteNumber, "a number"),
    ...fields.optional("modification_date", isFiniteNumber, "a number"),
    avatar_media_id: null,
    ...(fields.has("assets") ? { assets: assets.filter(isAsset) } : {}),
    ...(book ? { character_book: lorebookFromCharacterBook(book, [...path, "character_book"], limits, issues) } : {}),
    ...(regex.length > 0 ? { regex } : {}),
    extensions,
    ...fields.unknown(DATA_KEYS)
  }
}

/** ST's V1 import: the fields it knows, with its placeholder creator note removed. */
const fromV1 = (root: Record<string, unknown>, limits: Limits, issues: ReportBuilder): CardDoc => {
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
    limits,
    issues
  )
  const { unknown_fields } = fields.unknown(ROOT_KEYS)
  return unknown_fields ? { ...card, unknown_root_fields: unknown_fields } : card
}

/** A parsed card file as our card document. */
export const cardFromJson = (
  root: unknown,
  limits: Limits,
  issues: ReportBuilder
): { card: CardDoc; version: CardVersion; stCreatedAt: number | null; stChat: string | null } => {
  if (!Predicate.isObject(root)) return fail("card.not_a_card", "The file isn't a character card.")
  const stCreatedAt = parseStCreatedAt(root.create_date)
  // The chat ST opens the card on (its file name without `.jsonl`): the one last opened.
  const stChat = typeof root.chat === "string" && root.chat.trim() !== "" ? root.chat.slice(0, 1024) : null
  if (root.spec !== undefined && Predicate.isObject(root.data)) {
    const version: CardVersion = root.spec === "chara_card_v2" ? "v2" : "v3"
    if (root.spec !== "chara_card_v2" && root.spec !== "chara_card_v3") {
      issues.add("warning", "card.unknown_spec", "The card names a spec this app doesn't know; it was read as V3.", [
        "spec"
      ])
    } else if (version === "v3" && specVersion(root.spec_version) > 3) {
      issues.add(
        "info",
        "card.newer_spec",
        "The card was made for a newer V3 spec version; newer fields are kept as they are."
      )
    }
    const card = fromData(root.data, ["data"], limits, issues)
    const { unknown_fields } = new Fields(root, [], issues).unknown(ROOT_KEYS)
    return {
      card: unknown_fields ? { ...card, unknown_root_fields: unknown_fields } : card,
      version,
      stCreatedAt,
      stChat
    }
  }
  if (root.spec !== undefined) {
    issues.add(
      "warning",
      "card.missing_data",
      "The card names a spec but has no data; its top-level fields were read as V1.",
      ["data"]
    )
  }
  if (typeof root.name === "string") return { card: fromV1(root, limits, issues), version: "v1", stCreatedAt, stChat }
  return fail("card.not_a_card", "The file isn't a character card.")
}
