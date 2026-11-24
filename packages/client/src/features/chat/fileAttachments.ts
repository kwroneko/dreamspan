// Attachments of any type (spec/FILES-AND-ENVIRONMENT.md §6.1): where a chat takes files that
// aren't images, a registered part says how. The files feature registers one for workshops,
// which saves each file in the working folder's Attachments folder and attaches it by path;
// without one (a story chat), the composer takes images only, as before. A plugin can replace it.
import type { AttachmentComposer } from "@dreamspan/shared/composerApi.ts"
import type { AttachedFile } from "@dreamspan/shared/files.ts"
import { useSyncExternalStore, type ComponentType } from "react"
import { makeRegistry } from "../../registry.ts"
import type { ChatSession, ChatView } from "./session.ts"

export interface FileAttacher {
  /** The folder uploads are saved in, as the user reads it ("/files/thesis/Attachments"). */
  readonly folder: string
  /** Saves a file from this device there (keeping both on a taken name) and attaches it. */
  readonly upload: (file: Blob, name: string, composer: AttachmentComposer) => Promise<AttachedFile>
  /** Attaches a file already in Files, with no copy in Files. */
  readonly attach: (path: string, composer: AttachmentComposer) => Promise<AttachedFile>
  /** Where the copy sent with a message opens, or downloads from. */
  readonly copyUrl: (mediaId: string, name: string, download?: boolean) => string
  /** Where a file of Files is shown: its folder in the Files page, with it open. */
  readonly showHref: (path: string) => string
}

export interface FileAttachments {
  readonly id: string
  /**
   * A hook: how this chat attaches files of any type; "loading" while that isn't known yet (the
   * working folder is still being read); null where it takes images only.
   */
  readonly useFileAttacher: (session: ChatSession, view: ChatView) => FileAttacher | "loading" | null
  /** Where a message's file opens without a chat (the copy as sent), for message previews. */
  readonly copyUrl: (mediaId: string, name: string, download?: boolean) => string
  readonly showHref: (path: string) => string
  /**
   * Whether a file's copy as sent opens in a viewer (§6.1, §8.2), read-only; a type no viewer
   * shows downloads.
   */
  readonly opens?: (name: string) => boolean
  /** The viewer `opens` says shows the file. */
  readonly Viewer?: ComponentType<{ readonly name: string; readonly url: string }>
}

/** @public The files feature registers its workshop attachments here. */
export const fileAttachments = makeRegistry<FileAttachments>()

export const useFileAttachments = () => {
  const snapshot = useSyncExternalStore(fileAttachments.subscribe, fileAttachments.snapshot, fileAttachments.snapshot)
  return snapshot.entries.at(-1) ?? null
}

/** A file dragged from the Files panel carries its path in this type (`FILE_DRAG`). */
export const FILE_PATH_MIME = "application/x-rp-file-path"

type AttachRequest = {
  readonly forkId: ChatView["forkId"]
  readonly listener: (path: string) => void
}
const requests = new WeakMap<ChatSession, AttachRequest>()

/** Asks the initiating view's composer to attach a file from its Files tab. */
export const requestAttach = (session: ChatSession, forkId: ChatView["forkId"], path: string) => {
  const request = requests.get(session)
  if (request?.forkId === forkId) request.listener(path)
}

/** The composer's side of `requestAttach`; returns the unsubscribe. */
export const onAttachRequest = (session: ChatSession, forkId: ChatView["forkId"], listener: (path: string) => void) => {
  const request = { forkId, listener }
  requests.set(session, request)
  return () => {
    if (requests.get(session) === request) requests.delete(session)
  }
}
