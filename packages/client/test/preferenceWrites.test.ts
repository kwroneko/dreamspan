import { expect, it } from "vitest"
import { PreferenceWrites } from "../src/ui/preferenceWrites.ts"

const heldSave = () => {
  let acknowledge = () => {}
  let resolve: (result: { ok: boolean }) => void = () => {}
  const response = new Promise<{ ok: boolean }>((done) => (resolve = done))
  return {
    save: (saved: () => void) => {
      acknowledge = saved
      return response
    },
    finish: (ok: boolean) => {
      if (ok) acknowledge()
      resolve({ ok })
    }
  }
}

it("retires acknowledged choices only for reads started after their acknowledgement", async () => {
  const writes = new PreferenceWrites()
  const before = writes.readRevision()
  const save = heldSave()
  const pending = writes.change({ coverageRail: true }, save.save)
  expect(writes.snapshot()).toEqual({ coverageRail: true })
  await Promise.resolve()
  save.finish(true)
  await pending
  writes.confirm(before)
  expect(writes.snapshot()).toEqual({ coverageRail: true })
  // A fresh server result is authoritative, even if another browser changed it.
  writes.confirm(writes.readRevision())
  expect(writes.snapshot()).toEqual({})
})

it("serializes rapid writes and retains later choices across earlier readbacks and rollback", async () => {
  const writes = new PreferenceWrites()
  const first = heldSave()
  const second = heldSave()
  const firstDone = writes.change({ coverageRail: true }, first.save)
  const secondDone = writes.change({ coverageRail: false, reasoning: "collapsed" }, second.save)
  expect(writes.snapshot()).toEqual({ coverageRail: false, reasoning: "collapsed" })
  await Promise.resolve()
  first.finish(true)
  await firstDone
  const read = writes.readRevision()
  writes.confirm(read)
  expect(writes.snapshot()).toEqual({ coverageRail: false, reasoning: "collapsed" })
  await Promise.resolve()
  second.finish(false)
  await secondDone
  expect(writes.snapshot()).toEqual({})
  const third = writes.change({ coverageRail: false }, async (acknowledge) => {
    acknowledge()
    return { ok: true }
  })
  await third
  writes.confirm(read)
  expect(writes.snapshot()).toEqual({ coverageRail: false })
  writes.confirm(writes.readRevision())
  expect(writes.snapshot()).toEqual({})
})
