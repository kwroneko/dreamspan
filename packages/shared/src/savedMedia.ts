// Saved card media (spec/SAVED-MEDIA.md): media a library entry names, saved on this server
// from sites the user approved, and shown from here instead of the other site. Card text is
// never changed: the account keeps a map from each address to its saved file.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { NotFound, ServerError } from "./errors.ts"
import { RefId } from "./library.ts"

const MEDIA_KINDS = ["image", "audio", "video", "font"] as const
export const MediaKind = Schema.Literals(MEDIA_KINDS)
export type MediaKind = typeof MediaKind.Type

/** A host name as compared: lowercased, without a trailing dot or IPv6 brackets. */
export const normalizeHost = (host: string) =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")

/** A host the user may type: letters, digits, dots and dashes, or an IPv6 literal. */
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^[0-9a-f:.]+$/
export const isHostName = (host: string) => host.length > 0 && host.length <= 253 && HOST.test(host)

export const MediaHost = Schema.Struct({
  host: Schema.String.check(Schema.makeFilter((host) => isHostName(host) || "Not a host name")),
  /** Also every host under it: `imgur.com` then matches `i.imgur.com`. */
  subdomains: Schema.Boolean
})
export type MediaHost = typeof MediaHost.Type
export const MediaHosts = Schema.Struct({ hosts: Schema.Array(MediaHost) })
export type MediaHosts = typeof MediaHosts.Type

/**
 * The card archive's mirrored downloads name their images on its own host
 * (`https://cardex.zip/i/<hash>.<ext>`, checked against its public API 2026-11-12), so it
 * starts on the list. It's removable like any other.
 */
export const DEFAULT_MEDIA_HOSTS: MediaHosts = { hosts: [{ host: "cardex.zip", subdomains: false }] }

/** Whether a host is on the list: the same name, or under one listed with its subdomains. */
export const hostApproved = (list: MediaHosts, host: string) => {
  const name = normalizeHost(host)
  return list.hosts.some((entry) => entry.host === name || (entry.subdomains && name.endsWith(`.${entry.host}`)))
}

/** A macro or a regex capture: the address is only known when it's shown. */
const DYNAMIC = /\{\{|\}\}|\$(?:\d|&|<|\{)/

/**
 * The address media is saved and looked up under: the URL parser's form of a remote
 * http(s) address without credentials, or null. Client and server use this one function.
 */
export const mediaKey = (raw: string): string | null => {
  const value = raw.replace(/[\t\n\r]/g, "").trim()
  if (!/^(?:https?:)?\/\//i.test(value) || DYNAMIC.test(value) || value.length > 8192) return null
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null
    url.hash = ""
    return url.href.length > 8192 ? null : url.href
  } catch {
    return null
  }
}

/** Where a saved file is served: the app's own origin, for the account that saved it. */
export const savedMediaPath = (mediaId: string) => `/media/saved/${encodeURIComponent(mediaId)}`

export const SavedMediaLookup = Schema.Struct({
  url: Schema.String,
  /** The saved file, when there is one. */
  mediaId: Schema.NullOr(Schema.String),
  /** Still downloading: ask again shortly. */
  waiting: Schema.Boolean
})
export type SavedMediaLookup = typeof SavedMediaLookup.Type

export const SavedMediaStatus = Schema.Struct({
  saved: Schema.Int,
  /** Approved and downloading. */
  waiting: Schema.Int,
  /** On sites not approved yet. */
  approval: Schema.Int,
  /** The user chose not to download them. */
  declined: Schema.Int,
  failed: Schema.Array(Schema.Struct({ url: Schema.String, reason: Schema.String }))
})
export type SavedMediaStatus = typeof SavedMediaStatus.Type

export const MediaApprovalHost = Schema.Struct({
  host: Schema.String,
  files: Schema.Int,
  kinds: Schema.Array(Schema.Struct({ kind: MediaKind, files: Schema.Int }))
})
export type MediaApprovalHost = typeof MediaApprovalHost.Type

export const MediaChoice = Schema.Literals(["approve", "approve-subdomains", "once", "decline"])
export type MediaChoice = typeof MediaChoice.Type

/** Which entries an approval is about: these refs' current revisions, or everything waiting. */
const MediaApprovalScope = Schema.Struct({
  refIds: Schema.NullOr(Schema.Array(RefId).check(Schema.isMaxLength(2000)))
})

export class SavedMediaApi extends RpcGroup.make(
  Rpc.make("LookupSavedMedia", {
    payload: { urls: Schema.Array(Schema.String.check(Schema.isMaxLength(8192))).check(Schema.isMaxLength(500)) },
    success: Schema.Array(SavedMediaLookup),
    error: ServerError
  }),
  Rpc.make("GetSavedMediaStatus", {
    payload: { refId: RefId },
    success: SavedMediaStatus,
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("RetrySavedMedia", {
    payload: { refId: RefId },
    success: SavedMediaStatus,
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("ListMediaApproval", {
    payload: MediaApprovalScope,
    success: Schema.Array(MediaApprovalHost),
    error: ServerError
  }),
  Rpc.make("DecideMediaApproval", {
    payload: {
      ...MediaApprovalScope.fields,
      decisions: Schema.Array(Schema.Struct({ host: Schema.String, choice: MediaChoice })).check(
        Schema.isMaxLength(500)
      )
    },
    success: MediaHosts,
    error: ServerError
  }),
  Rpc.make("GetMediaHosts", { success: MediaHosts, error: ServerError }),
  Rpc.make("ChangeMediaHosts", {
    payload: {
      add: Schema.optionalKey(MediaHost),
      remove: Schema.optionalKey(Schema.String)
    },
    success: MediaHosts,
    error: ServerError
  })
) {}
