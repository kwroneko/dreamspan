import { Schema } from "effect"

/** A card's version on the source: its id (cardex: the file's SHA-256), and its successor. */
const RemoteVersion = Schema.Struct({
  id: Schema.String,
  updatedAt: Schema.optionalKey(Schema.Number),
  supersededBy: Schema.optionalKey(Schema.String)
})

/** A card as the source lists it. `thumb` and `image` are keys this server issued, never URLs. */
export const RemoteSummary = Schema.Struct({
  remoteId: Schema.String,
  /** A standalone lorebook rather than a character (§3.9); absent for a card. */
  kind: Schema.optionalKey(Schema.Literal("lorebook")),
  name: Schema.String,
  creator: Schema.optionalKey(Schema.String),
  /** The creator as the source's creator filter takes it (cardex: `site/handle`), when it isn't the name. */
  creatorQuery: Schema.optionalKey(Schema.String),
  tagline: Schema.optionalKey(Schema.String),
  tags: Schema.Array(Schema.String),
  /** Its content rating, as the source words it; only when it isn't the source's default (safe) one. */
  rating: Schema.optionalKey(Schema.String),
  tokens: Schema.optionalKey(Schema.Number),
  /** Archive estimates, labelled by tokenizer; separate from locally computed counts. */
  tokenCounts: Schema.optionalKey(
    Schema.Struct({
      model: Schema.String,
      fields: Schema.Record(Schema.String, Schema.Number),
      greetings: Schema.Array(Schema.Number)
    })
  ),
  earlierOrigins: Schema.optionalKey(Schema.Array(Schema.Struct({ label: Schema.String, url: Schema.String }))),
  thumb: Schema.optionalKey(Schema.String),
  image: Schema.optionalKey(Schema.String),
  version: RemoteVersion,
  url: Schema.optionalKey(Schema.String),
  stats: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  /** The user's own card for it (§3.7), when they have one. Never sent to the source. */
  held: Schema.optionalKey(
    Schema.Struct({
      entityId: Schema.String,
      refId: Schema.String,
      archived: Schema.Boolean,
      /** The source has a version other than the one added (§3.8). */
      update: Schema.Boolean
    })
  )
})
export type RemoteSummary = typeof RemoteSummary.Type
