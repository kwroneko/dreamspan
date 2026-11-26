import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { makeUpdates } from "../src/updates/service.ts"
import { tempDir } from "./support/tempDir.ts"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgSign=false", "-c", "core.hooksPath=", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()

const fixture = (overrides: Partial<Parameters<typeof makeUpdates>[0]> = {}) => {
  const dir = tempDir("updates")
  const remote = join(dir, "origin.git")
  const author = join(dir, "author")
  const root = join(dir, "checkout")
  git(dir, "init", "--bare", "--initial-branch=master", remote)
  git(dir, "clone", remote, author)
  git(author, "config", "user.name", "Synthetic Author")
  git(author, "config", "user.email", "author@example.test")
  writeFileSync(join(author, ".gitignore"), "dist/\n")
  writeFileSync(join(author, "package-lock.json"), "{}\n")
  git(author, "add", ".")
  git(author, "commit", "-m", "Initial")
  git(author, "push", "origin", "master")
  git(dir, "clone", remote, root)
  const previousHead = git(root, "rev-parse", "HEAD")
  const commit = (subject: string) => git(author, "commit", "--allow-empty", "-m", subject)
  const push = (changeLock = false) => {
    if (changeLock) {
      writeFileSync(join(author, "package-lock.json"), '{"lockfileVersion":3}\n')
      git(author, "add", "package-lock.json")
    }
    commit("First incoming commit")
    commit("Second incoming commit")
    git(author, "push", "origin", "master")
    return git(author, "rev-parse", "HEAD")
  }
  const npm = vi.fn<(cwd: string, command: "ci" | "build") => Promise<void>>(async () => {})
  const restart = vi.fn()
  const updates = makeUpdates({
    root,
    automaticChecks: false,
    remote: "origin",
    branch: "master",
    supervised: () => true,
    restartDelayMs: 1,
    restart,
    npm,
    ...overrides
  })
  return { updates, root, author, previousHead, push, npm, restart }
}

it("reports an up-to-date checkout and finds two incoming commits after a push", async () => {
  const { updates, previousHead, push } = fixture()
  expect(await updates.status()).toMatchObject({ automaticChecks: false, lastCheckedAt: null })
  expect(await updates.check()).toMatchObject({
    currentCommit: previousHead.slice(0, 12),
    currentBranch: "master",
    remoteCommit: previousHead,
    behindCount: 0,
    autoUpdateReason: "up_to_date",
    lastCheckedAt: expect.any(Number),
    lastError: null
  })
  const target = push()
  const status = await updates.check()
  expect(status).toMatchObject({ remoteCommit: target, behindCount: 2, canAutoUpdate: true, autoUpdateReason: null })
  expect(status.incoming.map(({ subject }) => subject)).toEqual(["Second incoming commit", "First incoming commit"])
})

it("does not treat an archive inside another repository as an installable checkout", async () => {
  const { root } = fixture()
  const archive = join(root, "archive")
  mkdirSync(archive)
  const updates = makeUpdates({
    root: archive,
    automaticChecks: false,
    remote: "origin",
    branch: "master",
    supervised: () => true,
    restart: () => {}
  })
  expect(await updates.bootCommit()).toBeUndefined()
  expect(await updates.check()).toMatchObject({ autoUpdateReason: "not_git", canAutoUpdate: false })
  await expect(updates.apply()).rejects.toThrow("running outside a Git checkout")
})

it("recognizes a linked worktree and a configured branch outside the fetch refspec", async () => {
  const { author, root } = fixture()
  const worktree = join(root, "..", "linked")
  git(root, "worktree", "add", "-b", "release/nightly", worktree)
  git(author, "switch", "-c", "release/nightly")
  git(author, "commit", "--allow-empty", "-m", "Nightly")
  git(author, "push", "origin", "release/nightly")
  git(root, "config", "remote.origin.fetch", "+refs/heads/master:refs/remotes/origin/master")
  git(root, "remote", "rename", "origin", "upstream")
  const updates = makeUpdates({
    root: worktree,
    automaticChecks: false,
    remote: "upstream",
    branch: "release/nightly",
    supervised: () => true,
    restart: () => {}
  })
  expect(await updates.check()).toMatchObject({ behindCount: 1, currentBranch: "release/nightly", canAutoUpdate: true })
})

it("refuses local edits on check and re-checks cleanliness just before applying", async () => {
  const { updates, root, previousHead, push, npm } = fixture()
  push()
  expect((await updates.check()).canAutoUpdate).toBe(true)
  writeFileSync(join(root, "local.txt"), "Keep this edit")
  await expect(updates.apply()).rejects.toThrow("The checkout has local changes.")
  expect(await updates.check()).toMatchObject({
    behindCount: 2,
    canAutoUpdate: false,
    autoUpdateReason: "dirty_worktree"
  })
  expect(git(root, "rev-parse", "HEAD")).toBe(previousHead)
  expect(readFileSync(join(root, "local.txt"), "utf8")).toBe("Keep this edit")
  expect(npm).not.toHaveBeenCalled()
})

it("refuses one-click updates from a different branch", async () => {
  const { updates, root, push } = fixture()
  git(root, "switch", "-c", "local")
  push()
  expect(await updates.check()).toMatchObject({
    behindCount: 2,
    canAutoUpdate: false,
    autoUpdateReason: "wrong_branch"
  })
})

it("reports divergence instead of resetting a locally committed change", async () => {
  const { updates, root, push } = fixture()
  git(
    root,
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=author@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "Local"
  )
  push()
  expect(await updates.check()).toMatchObject({ behindCount: 2, canAutoUpdate: false, autoUpdateReason: "diverged" })
})

it("continues to find updates when no restart supervisor is available", async () => {
  const { updates, push, npm } = fixture({ supervised: () => false })
  push()
  expect(await updates.check()).toMatchObject({
    behindCount: 2,
    canAutoUpdate: false,
    autoUpdateReason: "unsupervised"
  })
  await expect(updates.apply()).rejects.toThrow("without the restart supervisor")
  expect(npm).not.toHaveBeenCalled()
})

it("returns a content-free error when the local remote is unreachable and retries", async () => {
  const { updates, root, push } = fixture()
  const remote = git(root, "remote", "get-url", "origin")
  git(root, "remote", "set-url", "origin", join(root, "synthetic-secret-path.git"))
  const failed = await updates.check()
  expect(failed).toMatchObject({
    autoUpdateReason: "check_failed",
    lastError: "Could not check the configured Git remote and branch."
  })
  expect(JSON.stringify(failed)).not.toContain("synthetic-secret-path")
  git(root, "remote", "set-url", "origin", remote)
  push()
  expect(await updates.check()).toMatchObject({ lastError: null, behindCount: 2, canAutoUpdate: true })
})

it("locks concurrent updates, fast-forwards, builds, and requests supervisor exit 75", async () => {
  const { updates, root, previousHead, push, npm, restart } = fixture()
  const target = push()
  await updates.check()
  const applying = updates.apply()
  await expect(updates.apply()).rejects.toThrow("already running")
  expect(await updates.check()).toMatchObject({ state: "updating" })
  expect(await applying).toEqual({ started: true, targetCommit: target })
  expect(git(root, "rev-parse", "HEAD")).toBe(target)
  expect(await updates.bootCommit()).toBe(previousHead.slice(0, 12))
  expect(npm.mock.calls).toEqual([[root, "build"]])
  expect((await updates.status()).state).toBe("restarting")
  await vi.waitFor(() => expect(restart).toHaveBeenCalledExactlyOnceWith(75))
})

it("rolls back the checkout and generated assets when a build fails", async () => {
  const { updates, root, previousHead, push, npm, restart } = fixture()
  const dist = join(root, "packages/client/dist")
  mkdirSync(dist, { recursive: true })
  const index = join(dist, "index.html")
  writeFileSync(index, "Previous build")
  npm.mockImplementation(async () => {
    writeFileSync(index, "Incomplete build")
    throw new Error("sensitive npm output")
  })
  push()
  await updates.check()
  await expect(updates.apply()).rejects.toThrow("The build failed. The checkout was rolled back.")
  expect(git(root, "rev-parse", "HEAD")).toBe(previousHead)
  expect(git(root, "status", "--porcelain")).toBe("")
  expect(readFileSync(index, "utf8")).toBe("Previous build")
  expect((await updates.status()).state).toBe("idle")
  expect(restart).not.toHaveBeenCalled()
})

it("reinstalls previous dependencies after a failed npm ci", async () => {
  const { updates, root, previousHead, push, npm, restart } = fixture()
  npm.mockRejectedValueOnce(new Error("partially installed"))
  push(true)
  await updates.check()
  await expect(updates.apply()).rejects.toThrow("Dependency installation failed. The checkout was rolled back.")
  expect(npm.mock.calls).toEqual([
    [root, "ci"],
    [root, "ci"]
  ])
  expect(git(root, "rev-parse", "HEAD")).toBe(previousHead)
  expect(git(root, "status", "--porcelain")).toBe("")
  expect(readFileSync(join(root, "package-lock.json"), "utf8")).toBe("{}\n")
  expect(restart).not.toHaveBeenCalled()
})
