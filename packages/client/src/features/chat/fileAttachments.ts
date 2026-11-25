// Attachments of any type (spec/FILES-AND-ENVIRONMENT.md §6.1): where a chat takes files that
// aren't images, a registered part says how. The files feature registers one for workshops,
// which stages uploads and attaches existing files by path. Story composers take images only.
import type { AttachmentComposer } from "@dreamspan/shared/composerApi.ts"
import type { AttachedFile, StagedFile } from "@dreamspan/shared/files.ts"
import { useSyncExternalStore, type ComponentType } from "react"
import { makeRegistry } from "../../registry.ts"
import type { ChatSession, ChatView } from "./session.ts"

export interface FileAttacher {
  /** Stages a file from this device in the given composer. */
  readonly upload: (file: Blob, name: string, composer: AttachmentComposer) => Promise<StagedFile>
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
   * A hook: how this chat attaches files of any type; "loading" while that isn't known yet;
   * null where it takes images only.
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
