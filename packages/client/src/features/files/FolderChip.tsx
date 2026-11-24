// The working-folder chip (spec/FILES-AND-ENVIRONMENT.md §2.2; owner: "we have space next to model
// and preset"): in a workshop's next-reply strip after the chips every chat has, the folder the assistant's
// commands start in on this branch, by its last name ("All files" at the top). Its popover, the
// strip's usual full-width rows: the full path, the assistant card's remembered folder when it
// differs, the folders picked last, the folders of Files one level at a time, New folder here and
// Use the top of Files. Choosing one writes `workshop.folder` on this branch (`WorkshopFolder`),
// which the server also remembers for the card (§2.3). A folder gone outside the app, and not found
// again by its inode, shows the warning tone: the next turn starts at the top. An admin, where the
// server lists HOST_FOLDERS, also gets Folder on the server… (§3.7): a folder outside Files, shown
// with a server badge. Where the workshop runs commands without a sandbox, the chip says so.
import { useDurableText, useOpenPlace } from "../editor/durable.tsx"
import { useRouter } from "@tanstack/react-router"
import { FILES_TOP, isTop, joinPath, nameOf, nameProblem } from "@dreamspan/shared/files.ts"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { FolderBrowser } from "../library/FolderBrowser.tsx"
import { capabilitiesAtom } from "../workshop/capabilities.ts"
import { Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { writePlaceValue } from "../../usePlaceParam.ts"
import type { ComposerControlContext } from "../chat/composerControls.tsx"
import { ChipText, chipClass, LoadingChip } from "../chat/nextReplyStrip.tsx"
import type { ChatSession } from "../chat/session.ts"
import { FolderTree } from "./FolderTree.tsx"
import { onFolderChanged } from "./live.ts"
import { useFilesSource } from "./source.ts"

interface Choices {
  readonly current: string | null
  readonly recent: ReadonlyArray<string>
  readonly card: string | null
  readonly hostFolders: boolean
}

const folderLabel = (path: string) => (isTop(path) ? "All files" : nameOf(path))

/** The branch's stored folder and the workshop's assistant card, from the cast at the leaf shown. */
const useStored = (session: ChatSession) => {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const stored = cast?.workshopFolder ?? null
  const card = cast?.cards.find((c) => !c.persona && cast.participants.includes(c.entityId)) ?? null
  return { cast, stored, cardId: card?.entityId ?? null, cardName: card?.name ?? null }
}

/**
 * Where the folder is now, the recent ones and the card's: read again when the stored one changes.
 * `enabled` false (a chat that isn't a workshop) reads nothing.
 */
export const useFolderChoices = (session: ChatSession, enabled = true) => {
  const { cast, stored, cardId, cardName } = useStored(session)
  const read = useAction()
  const run = read.run
  const [choices, setChoices] = useState<{ key: string; value: Choices } | null>(null)
  const [version, setVersion] = useState(0)
  const key = `${stored?.path ?? ""}\0${stored?.inode ?? ""}\0${cardId ?? ""}\0${version}`
  useEffect(() => {
    if (cast === null || !enabled) return
    let live = true
    void run((client) => client("WorkshopFolderChoices", { chatId: session.chatId, stored, cardId })).then((result) => {
      if (live && result.ok) setChoices({ key, value: result.value })
    })
    return () => {
      live = false
    }
    // `run` is a new function each render; the key names what the answer is for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cast === null, enabled])
  // A folder renamed or deleted elsewhere: look again.
  useEffect(() => {
    if (!stored) return
    const parent = stored.path.slice(0, stored.path.lastIndexOf("/")) || FILES_TOP
    return onFolderChanged(parent, () => setVersion((v) => v + 1))
  }, [stored])
  const refresh = useCallback(() => setVersion((v) => v + 1), [])
  const choose = useCallback(
    async (path: string, host = false) => {
      const outcome = await session.changeCast({ _tag: "WorkshopFolder", path, ...(host ? { host: true } : {}) })
      if (!outcome.ok) throw new Error(outcome.error.message)
    },
    [session]
  )
  return {
    ready: cast !== null && choices !== null && choices.key === key,
    choices: choices?.value ?? null,
    stored,
    cardName,
    refresh,
    choose
  }
}

export function FolderChip({ session }: ComposerControlContext) {
  const folder = useFolderChoices(session)
  const source = useFilesSource()
  const router = useRouter()
  // The popover and its New folder form are URL state; the name typed is kept.
  const place = `folder-chip:${session.chatId}`
  const newFolderPlace = `folder-chip-new:${session.chatId}`
  const [open, setOpen] = useOpenPlace(place)
  const [error, setError] = useState<string | null>(null)
  const [naming, setNaming] = useOpenPlace(newFolderPlace)
  const typedName = useDurableText(newFolderPlace, "Name", "New folder")
  const [pending, setPending] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [hostPick, setHostPick] = useState<string | null>(null)
  const capabilities = useAtomValue(capabilitiesAtom(session.chatId))
  const unsandboxed =
    AsyncResult.isSuccess(capabilities) &&
    capabilities.value.some((c) => c.id === "commands.unsandboxed" && c.mode === "allow")
  if (!folder.ready || !folder.choices) return <LoadingChip label="Working folder" />
  const { current, recent, card, hostFolders } = folder.choices
  const gone = current === null
  const shown = current ?? FILES_TOP
  // A folder on the server, outside Files (§3.7).
  const host = folder.stored?.host === true
  const close = () => {
    writePlaceValue(router, "open", (current) => {
      if (!Array.isArray(current)) return current
      const remaining = current.filter((id) => id !== place && id !== newFolderPlace)
      return remaining.length ? remaining : undefined
    })
  }
  const pick = async (path: string, onServer = false) => {
    setPending(true)
    setError(null)
    try {
      await folder.choose(path, onServer)
      close()
      setBrowsing(false)
    } catch (cause) {
      setError(`The folder wasn't changed: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setPending(false)
    }
  }
  const makeFolder = async (name: string) => {
    const problem = nameProblem(name)
    if (problem) return setError(problem)
    if (!source) return
    setPending(true)
    try {
      const made = await source.createFolder(joinPath(shown, name))
      setPending(false)
      void typedName.commit(async () => true)
      await pick(made.path)
    } catch (cause) {
      setPending(false)
      setError(`The folder wasn't made: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  const others = recent.filter((path) => path !== shown && path !== card).slice(0, 5)
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (!next) return close()
          setOpen(true)
          folder.refresh()
        }}
        trigger={
          <ChipText>
            <span
              className="inline-flex min-w-0 items-center gap-1"
              data-folder-chip={shown}
              {...(host ? { "data-folder-host": "" } : {})}
            >
              <Icon name={host && !gone ? "server" : "folder"} size={14} />
              <span className="min-w-0 truncate">
                {gone ? "Folder not found" : host ? (shown.split("/").at(-1) ?? shown) : folderLabel(shown)}
              </span>
              {unsandboxed && (
                <Badge tone="warning" size="sm">
                  No sandbox
                </Badge>
              )}
            </span>
          </ChipText>
        }
        triggerLabel={gone ? "Working folder: not found" : `Working folder: ${shown}`}
        hint={[
          gone
            ? host
              ? `${folder.stored?.path ?? "The folder"} isn't available on the server now. Commands start at the top of your files until you choose another.`
              : `${folder.stored?.path ?? "The folder"} isn't in your files any more. Commands start at the top of your files until you choose another.`
            : host
              ? "A folder on the server, outside your files. Commands start there and can change it."
              : "Where the assistant's commands start. It can still reach all your files.",
          unsandboxed ? "Commands in this workshop run without a sandbox." : ""
        ]
          .filter(Boolean)
          .join(" ")}
        triggerClassName={chipClass(gone || unsandboxed ? "warning" : "neutral")}
        title="Working folder"
      >
        <div className="-mx-2 flex min-h-0 flex-col gap-2 overflow-y-auto px-2" data-folder-popover="">
          <p className="px-2 text-sm [overflow-wrap:anywhere]" data-folder-current="">
            {gone ? (
              <span className="text-warning">Not found: {folder.stored?.path}</span>
            ) : (
              <>
                Commands start in <span className="font-medium">{shown}</span>
              </>
            )}
          </p>
          {card && (
            <FolderRow
              path={card}
              label={`Use ${folder.cardName ?? "the assistant"}'s folder: ${card}`}
              hint={`The folder you last chose for ${folder.cardName ?? "this assistant"}.`}
              disabled={pending}
              onPick={(path) => void pick(path)}
            />
          )}
          {others.length > 0 && (
            <section aria-label="Recent" className="flex flex-col">
              <h3 className="px-2 text-xs font-medium text-muted">Recent</h3>
              {others.map((path) => (
                <FolderRow
                  key={path}
                  path={path}
                  label={path}
                  hint="A folder you chose recently."
                  disabled={pending}
                  onPick={(at) => void pick(at)}
                />
              ))}
            </section>
          )}
          {source && (
            <section aria-label="Your files" className="flex flex-col gap-1">
              <h3 className="px-2 text-xs font-medium text-muted">Your files</h3>
              <FolderTree
                source={source}
                folder={host ? FILES_TOP : shown}
                onFolder={(path) => void pick(path)}
                version={0}
              />
            </section>
          )}
          {hostFolders && (
            <Tooltip label="Chooses a folder on the server, outside your files, from those the server allows.">
              <button
                type="button"
                disabled={pending}
                data-folder-host-row=""
                onClick={() => {
                  setHostPick(host && !gone ? shown : null)
                  setBrowsing(true)
                  setOpen(false)
                }}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
              >
                <Icon name="server" size={14} className="shrink-0 text-muted" />
                <span className="min-w-0 [overflow-wrap:anywhere]">Folder on the server…</span>
              </button>
            </Tooltip>
          )}
          {naming ? (
            <form
              className="flex min-w-0 flex-wrap items-center gap-2 px-2"
              onSubmit={(event) => {
                event.preventDefault()
                void makeFolder(typedName.text.trim())
              }}
            >
              <Input
                name="name"
                aria-label="Name of the new folder"
                value={typedName.text}
                readOnly={!typedName.ready}
                onChange={(event) => typedName.setText(event.currentTarget.value)}
                autoFocus
                className="min-w-0 flex-1 basis-32"
              />
              <Button
                type="submit"
                variant="primary"
                hint={`Makes the folder in ${shown} and works there.`}
                pending={pending}
              >
                Make folder
              </Button>
              <Button
                hint="Leaves the folder as it is."
                onClick={() => {
                  void typedName.discard()
                  setNaming(false)
                }}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2 px-2">
              <Button
                hint={`Makes a new folder in ${shown} and works there.`}
                disabled={pending || !source || host}
                onClick={() => setNaming(true)}
              >
                <Icon name="plus" />
                New folder here
              </Button>
              {!isTop(shown) || gone || host ? (
                <Button
                  hint="Commands start at the top of your files."
                  disabled={pending}
                  onClick={() => void pick(FILES_TOP)}
                >
                  Use the top of Files
                </Button>
              ) : null}
            </div>
          )}
          {error && (
            <p role="alert" className="px-2 text-sm text-danger [overflow-wrap:anywhere]">
              {error}
            </p>
          )}
          <p className="shrink-0 border-t border-border px-2 pt-2 text-xs text-muted">
            This holds for this branch only.
          </p>
        </div>
      </Popover>
      <Dialog
        open={browsing}
        onOpenChange={setBrowsing}
        title="Folder on the server"
        description="A folder outside your files that the server allows. Commands start there and can change it. Changes there don't count against your storage."
      >
        <div className="flex min-w-0 flex-col gap-3" data-host-folder-dialog="">
          <FolderBrowser kind="host" start={hostPick} disabled={pending} onOpen={setHostPick} />
          <p className="text-sm [overflow-wrap:anywhere]">
            {hostPick ? (
              <>
                Chosen: <span className="font-medium">{hostPick}</span>
              </>
            ) : (
              <span className="text-muted">Open a folder to choose it.</span>
            )}
          </p>
          {error && browsing && (
            <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">
              {error}
            </p>
          )}
          <DialogActions>
            <Button hint="Closes this without changing the folder." onClick={() => setBrowsing(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              hint="Commands start in this folder on this branch."
              disabled={hostPick === null}
              pending={pending}
              onClick={() => hostPick && void pick(hostPick, true)}
            >
              Use this folder
            </Button>
          </DialogActions>
        </div>
      </Dialog>
    </>
  )
}

function FolderRow({
  path,
  label,
  hint,
  disabled,
  onPick
}: {
  path: string
  label: string
  hint: string
  disabled: boolean
  onPick: (path: string) => void
}) {
  return (
    <Tooltip label={hint}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPick(path)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
      >
        <Icon name="folder" size={14} className="shrink-0 text-muted" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
      </button>
    </Tooltip>
  )
}
