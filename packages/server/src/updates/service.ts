import {
  autoUpdateMessages,
  UpdateRejected,
  type AutoUpdateReason,
  type UpdateStatus
} from "@dreamspan/shared/updates.ts"
import { Context, Effect, Layer } from "effect"
import { lstat, readFile, realpath } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { AppConfig } from "../config.ts"
import { serverEnvironment } from "../serverEnvironment.ts"
import { backUpBuild, git, runNpm, type RunNpm } from "./checkout.ts"
import { requestRestart } from "./restart.ts"

const sourceRoot = fileURLToPath(new URL("../../../../", import.meta.url))
const RELEASE_EXIT_CODE = 75

interface UpdateOptions {
  readonly root: string
  readonly automaticChecks: boolean
  readonly remote: string
  readonly branch: string
  readonly supervised: () => boolean
  readonly restart: (code: number) => void
  readonly npm?: RunNpm
  readonly restartDelayMs?: number
}

const checkout = async (folder: string) => {
  try {
    const here = await realpath(folder)
    const root = await realpath(await git(here, ["rev-parse", "--show-toplevel"]))
    // A Docker image or unpacked archive can itself live inside an unrelated repository.
    if (relative(here, root) !== "") return null
    const commit = await git(root, ["rev-parse", "--short=12", "HEAD"])
    return { root, commit }
  } catch {
    return null
  }
}

const lockfile = async (root: string) => {
  const path = join(root, "package-lock.json")
  try {
    if (!(await lstat(path)).isFile()) throw new Error("The package lockfile must be a regular file")
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export const makeUpdates = (options: UpdateOptions) => {
  const { remote, branch } = options
  const remoteRef = `refs/remotes/${remote}/${branch}`
  const branchRef = `refs/heads/${branch}`
  const npm = options.npm ?? runNpm
  let status: UpdateStatus = {
    state: "idle",
    automaticChecks: options.automaticChecks,
    branch,
    currentCommit: null,
    currentBranch: null,
    remoteCommit: null,
    behindCount: 0,
    incoming: [],
    canAutoUpdate: false,
    autoUpdateReason: "not_checked",
    lastCheckedAt: null,
    lastError: null
  }
  const patch = (fields: Partial<UpdateStatus>) => (status = { ...status, ...fields })
  const boot = checkout(options.root).then((repo) => {
    if (repo) patch({ currentCommit: repo.commit })
    else patch({ autoUpdateReason: "not_git" })
    return repo
  })

  const inspect = async (root: string, target: string) => {
    const [head, short, currentBranch] = await Promise.all([
      git(root, ["rev-parse", "HEAD"]),
      git(root, ["rev-parse", "--short=12", "HEAD"]),
      git(root, ["symbolic-ref", "--short", "HEAD"]).catch(() => null)
    ])
    patch({ currentCommit: short, currentBranch })
    let reason: AutoUpdateReason | null = null
    if (currentBranch !== branch) reason = "wrong_branch"
    else if (await git(root, ["status", "--porcelain", "--untracked-files=all"])) reason = "dirty_worktree"
    else if (head === target) reason = "up_to_date"
    else if (
      !(await git(root, ["merge-base", "--is-ancestor", head, target]).then(
        () => true,
        () => false
      ))
    )
      reason = "diverged"
    else if (!options.supervised()) reason = "unsupervised"
    patch({ canAutoUpdate: reason === null, autoUpdateReason: reason })
    return { head, reason }
  }

  const check = async () => {
    if (status.state !== "idle") return status
    patch({ state: "checking" })
    try {
      const repo = await boot
      if (repo) {
        const { root } = repo
        const remotes = (await git(root, ["remote"])).split("\n")
        if (remote.startsWith("-") || !remotes.includes(remote)) throw new Error("Unknown Git remote")
        await git(root, ["check-ref-format", branchRef])
        await git(root, ["check-ref-format", remoteRef])
        // An explicit tracking destination works even for a branch outside a clone's fetch refspec.
        await git(
          root,
          ["fetch", "--no-tags", "--quiet", "--no-recurse-submodules", remote, `+${branchRef}:${remoteRef}`],
          20_000
        )
        const target = await git(root, ["rev-parse", "--verify", remoteRef])
        const { head } = await inspect(root, target)
        const range = `${head}..${target}`
        const [count, log] = await Promise.all([
          git(root, ["rev-list", "--count", range]),
          git(root, ["log", "--format=%h%x09%s", "-n", "5", range])
        ])
        const incoming =
          log === ""
            ? []
            : log.split("\n").map((line) => {
                const tab = line.indexOf("\t")
                return tab < 0
                  ? { commit: line, subject: "" }
                  : { commit: line.slice(0, tab), subject: line.slice(tab + 1) }
              })
        patch({ remoteCommit: target, behindCount: Number(count), incoming })
      }
      patch({ lastError: null })
    } catch {
      patch({
        canAutoUpdate: false,
        autoUpdateReason: "check_failed",
        lastError: "Could not check the configured Git remote and branch."
      })
    }
    return patch({ state: "idle", lastCheckedAt: Date.now() })
  }

  const apply = async () => {
    if (status.state !== "idle") throw new UpdateRejected({ message: "An update operation is already running." })
    patch({ state: "updating" })
    let backup: Awaited<ReturnType<typeof backUpBuild>> | undefined
    let failure = "Could not prepare the checkout for an update."
    try {
      const repo = await boot
      if (!repo) throw new UpdateRejected({ message: autoUpdateMessages.not_git })
      const { root } = repo
      const target = status.remoteCommit
      const refusal = status.autoUpdateReason
      if (!target || refusal === "check_failed")
        throw new UpdateRejected({ message: autoUpdateMessages[refusal ?? "not_checked"] })
      if (target !== (await git(root, ["rev-parse", "--verify", remoteRef])))
        throw new UpdateRejected({ message: "The Git update target changed. Check for updates again." })
      backup = await backUpBuild(root)
      const before = await lockfile(root)
      const { head, reason } = await inspect(root, target)
      if (reason) throw new UpdateRejected({ message: autoUpdateMessages[reason] })
      failure = "Could not fast-forward the Git checkout."
      await git(root, ["merge", "--ff-only", "--no-overwrite-ignore", target], 0)

      let installAttempted = false
      try {
        failure = "Could not read the updated package lockfile."
        const after = await lockfile(root)
        const changed = before === null || after === null ? before !== after : !before.equals(after)
        if (changed) {
          failure = "Dependency installation failed."
          installAttempted = true
          await npm(root, "ci")
        }
        failure = "The build failed."
        await npm(root, "build")
      } catch {
        const reset = await git(root, ["reset", "--hard", head], 0).then(
          () => true,
          () => false
        )
        const buildRestored = await backup.restore().then(
          () => true,
          () => false
        )
        const dependenciesRestored =
          !installAttempted ||
          (reset &&
            (await npm(root, "ci").then(
              () => true,
              () => false
            )))
        const recovery = [
          reset ? "The checkout was rolled back." : "Git rollback failed.",
          buildRestored ? null : "The previous build could not be restored.",
          dependenciesRestored ? null : "Dependencies may be incomplete. Run npm ci from the previous checkout."
        ]
          .filter(Boolean)
          .join(" ")
        throw new UpdateRejected({ message: `${failure} ${recovery}` })
      }

      await backup.discard()
      patch({ state: "restarting", canAutoUpdate: false })
      setTimeout(() => options.restart(RELEASE_EXIT_CODE), options.restartDelayMs ?? 400).unref()
      return { started: true as const, targetCommit: target }
    } catch (error) {
      await backup?.discard()
      patch({ state: "idle" })
      throw error instanceof UpdateRejected ? error : new UpdateRejected({ message: failure })
    }
  }

  return {
    status: async () => {
      await boot
      return status
    },
    bootCommit: async () => (await boot)?.commit,
    check,
    apply
  }
}

export class Updates extends Context.Service<Updates, ReturnType<typeof makeUpdates>>()("rp/Updates") {
  static readonly layer = Layer.effect(
    Updates,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const updates = makeUpdates({
        root: sourceRoot,
        automaticChecks: config.updateCheck === "on",
        remote: config.updateRemote,
        branch: config.updateBranch,
        supervised: () => process.env[serverEnvironment.DREAMSPAN_SUPERVISED] === "1",
        restart: requestRestart
      })
      if (config.updateCheck === "on")
        yield* Effect.gen(function* () {
          yield* Effect.sleep(3_000)
          yield* Effect.forever(
            Effect.promise(updates.check).pipe(Effect.andThen(Effect.sleep(config.updateCheckIntervalMs)))
          )
        }).pipe(Effect.forkScoped)
      return updates
    })
  )
}
