// Real ZIP64 boundaries, checked with Python's independent ZIP reader. Bounded chunks,
// no 4 GiB allocation, and the file is removed by the ordinary test directory cleanup.
import { randomFillSync } from "node:crypto"
import { createWriteStream } from "node:fs"
import { execFileSync } from "node:child_process"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { join } from "node:path"
import { expect, it } from "vitest"
import { zipStream } from "../src/formats/zipStream.ts"
import { tempDir } from "./support/tempDir.ts"

it("writes a file and following offset above 4 GiB and more than 65,535 entries", async () => {
  const root = tempDir("zip64-export")
  const file = join(root, "large.zip")
  const chunk = randomFillSync(Buffer.alloc(1024 * 1024))
  async function* big() {
    for (let i = 0; i < 4100; i++) yield chunk
  }
  async function* empty() {
    yield new Uint8Array()
  }
  async function* files() {
    yield { name: "big.bin", chunks: big() }
    for (let i = 1; i < 65537; i++) yield { name: `empty-${i}.txt`, chunks: empty() }
  }
  const start = performance.now()
  let peak = process.memoryUsage().rss
  const sample = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }, 50)
  try {
    await pipeline(Readable.from(zipStream(files())), createWriteStream(file))
    const verified = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          `
import json, zipfile, sys
with zipfile.ZipFile(sys.argv[1]) as z:
    files = z.infolist()
    assert len(files) == 65537, len(files)
    assert files[0].file_size == 4100 * 1024 * 1024
    assert files[1].header_offset > 0xffffffff
    assert z.read(files[-1]) == b''
    # Read the entire large member: zipfile verifies its independently computed CRC.
    total = 0
    with z.open(files[0]) as f:
        while True:
            data = f.read(8 * 1024 * 1024)
            if not data: break
            total += len(data)
    assert total == files[0].file_size
    print(json.dumps({'entries': len(files), 'size': total, 'tailOffset': files[1].header_offset}))
`,
          file
        ],
        { encoding: "utf8", timeout: 300_000 }
      )
    ) as { entries: number }
    expect(verified.entries).toBe(65537)
    console.log(
      "ZIP64_EXPORT_TIMING",
      JSON.stringify({
        ...verified,
        seconds: (performance.now() - start) / 1000,
        peakRssMb: Math.round(peak / 1024 / 1024)
      })
    )
  } finally {
    clearInterval(sample)
  }
}, 900_000)
