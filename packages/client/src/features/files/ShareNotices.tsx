// What sharing asks of you (spec/FILES-AND-ENVIRONMENT.md §1.4), above the list at the top of
// Files and in Shared: folders other accounts offer you, to accept (they then appear under
// Shared) or decline; and, at the top, your shares whose folder isn't at their path any more
// (moved by a command, replaced, or deleted), to share again or stop.
import type { ShareInvitation, UnavailableShare } from "@dreamspan/shared/files.ts"
import { useState } from "react"
import { Button } from "../../ui/Button.tsx"
import type { FilesSource } from "./source.ts"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const can = (mode: "view" | "edit") => (mode === "edit" ? "to edit" : "to view")

export function ShareNotices({
  source,
  invitations,
  unavailable,
  onChanged
}: {
  source: FilesSource
  invitations: ReadonlyArray<ShareInvitation>
  unavailable: ReadonlyArray<UnavailableShare>
  /** Read the folder again: what was answered is gone from it. */
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  if (invitations.length === 0 && unavailable.length === 0) return null

  const act = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id)
    setFailure(null)
    try {
      await work()
    } catch (error) {
      setFailure(message(error))
    } finally {
      setBusy(null)
      onChanged()
    }
  }

  return (
    <section aria-label="Sharing" className="flex min-w-0 flex-col gap-2" data-share-notices="">
      {invitations.length > 0 && source.answerInvitation && (
        <ul aria-label="Folders offered to you" className="flex min-w-0 flex-col gap-2">
          {invitations.map((invitation) => (
            <li
              key={invitation.id}
              className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2"
              data-share-invitation={invitation.folder}
            >
              <span className="min-w-0 grow text-sm [overflow-wrap:anywhere]">
                {invitation.ownerName}
                {invitation.ownerName !== invitation.ownerHandle && (
                  <span className="text-muted"> ({invitation.ownerHandle})</span>
                )}{" "}
                shares “{invitation.folder}” with you {can(invitation.mode)}.
              </span>
              <Button
                variant="primary"
                hint={`Adds “${invitation.folder}” to your files, under Shared/${invitation.ownerHandle}.`}
                pending={busy === invitation.id}
                disabled={busy !== null}
                onClick={() => void act(invitation.id, () => source.answerInvitation!(invitation.id, true))}
              >
                Accept
              </Button>
              <Button
                variant="ghost"
                hint={`Turns it down: “${invitation.folder}” doesn't appear in your files.`}
                disabled={busy !== null}
                onClick={() => void act(invitation.id, () => source.answerInvitation!(invitation.id, false))}
              >
                Decline
              </Button>
            </li>
          ))}
        </ul>
      )}
      {unavailable.length > 0 && (
        <ul aria-label="Shares that stopped" className="flex min-w-0 flex-col gap-2">
          {unavailable.map((share) => (
            <li
              key={share.id}
              className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2"
              data-share-unavailable={share.path}
            >
              <span className="min-w-0 grow text-sm [overflow-wrap:anywhere]">
                {share.reason === "bin"
                  ? `“${share.path}” was deleted, so ${share.displayName} no longer has it.`
                  : `The folder you shared with ${share.displayName} isn't at “${share.path}” any more, so they no longer have it.`}
              </span>
              {share.folderThere && source.shareAgain && (
                <Button
                  hint={`Shares the folder now at “${share.path}” with ${share.displayName}, ${can(share.mode)}. They see what's in it from now on.`}
                  pending={busy === share.id}
                  disabled={busy !== null}
                  onClick={() => void act(share.id, () => source.shareAgain!(share.id))}
                >
                  Share again
                </Button>
              )}
              {source.unshare && (
                <Button
                  variant="ghost"
                  hint={`Stops sharing “${share.path}” with ${share.displayName}.`}
                  disabled={busy !== null}
                  onClick={() => void act(share.id, () => source.unshare!(share.id))}
                >
                  Stop sharing
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {failure && (
        <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">
          {failure}
        </p>
      )}
    </section>
  )
}
