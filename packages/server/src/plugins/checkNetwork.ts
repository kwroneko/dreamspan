// Kernel filter for children that evaluate unapproved code. Node permissions do not cover sockets.
// setpriv installs this before exec; the filter is inherited by every thread and cannot be removed.
export const checkNetworkFilter = (): Buffer => {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new Error("Network-isolated plugin checks require Linux x64 or arm64")
  const x64 = process.arch === "x64"
  const denied = x64
    ? [41, 42, 43, 49, 50, 53, 288, 425] // socket, connect, accept, bind, listen, socketpair, accept4, io_uring_setup
    : [198, 203, 202, 200, 201, 199, 242, 425]
  const instructions: Array<readonly [number, number, number, number]> = [
    [0x20, 0, 0, 4], // LD arch
    [0x15, 1, 0, x64 ? 0xc000003e : 0xc00000b7],
    [0x06, 0, 0, 0x80000000], // KILL_PROCESS on a different ABI
    [0x20, 0, 0, 0], // LD syscall number
    [0x35, 0, 1, 0x40000000], // refuse x32/invalid high syscall numbers too
    [0x06, 0, 0, 0x80000000],
    ...denied.flatMap((nr): Array<readonly [number, number, number, number]> => [
      [0x15, 0, 1, nr],
      [0x06, 0, 0, 0x00050001] // ERRNO EPERM
    ]),
    [0x06, 0, 0, 0x7fff0000] // ALLOW (Node permissions still restrict files/processes/addons)
  ]
  const filter = Buffer.alloc(instructions.length * 8)
  instructions.forEach(([code, jt, jf, k], index) => {
    filter.writeUInt16LE(code, index * 8)
    filter[index * 8 + 2] = jt
    filter[index * 8 + 3] = jf
    filter.writeUInt32LE(k, index * 8 + 4)
  })
  return filter
}
