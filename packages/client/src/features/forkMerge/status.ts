// What a fork can take from its parent (or a card from its newer files), read once per ref.
import type { MergeStatus } from "@rp/shared/forkMerge.ts"
import type { RefId } from "@rp/shared/library.ts"
import { AppClient } from "../../rpc.ts"

type Status = typeof MergeStatus.Type

/** One query per ref (the client's query family): the notice, History and the review share it. */
export const statusQuery = (refId: RefId) =>
  AppClient.query("ForkMergeStatus", { refId }, { reactivityKeys: ["library"] })

/** Where the new revisions come from: the parent it was forked from, or files imported into it. */
export const sourceOf = (status: Status): "parent" | "file" => (status.parentRefId === null ? "file" : "parent")

/**
 * A parent recorded by hand ("Mark as a fork of…") copied no revision, so nothing says where
 * the two started from and there's nothing to compare against.
 */
export const linkedByHand = (status: Status) => status.parentRefId !== null && status.baseRevisionId === null

export const revisionsLine = (count: number) => `${count} new ${count === 1 ? "revision" : "revisions"}`

/** The library's word for a kind, in running text. */
export const kindWord = (kind: string) => (kind === "card" ? "card" : kind === "lorebook" ? "lorebook" : kind)
