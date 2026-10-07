import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"

import { listFolder } from "../src/listing.js"

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("combined folder listing", () => {
  test("marks shared, local-only, remote-only, hidden, and conflicting entries", async () => {
    const root = await makeTempDirectory()
    await writeFile(join(root, "shared.txt"), "local")
    await writeFile(join(root, "local.txt"), "local")
    await writeFile(join(root, ".hidden"), "hidden")
    await writeFile(join(root, "shape"), "file")
    const dav = new ListingDav([
      remoteEntry("shared.txt", "file"),
      remoteEntry("remote.txt", "file"),
      remoteEntry("remote-folder", "directory"),
      remoteEntry("shape", "directory"),
    ])
    const lines = []

    const entries = await listFolder({ path: root }, { localFolder: root }, {
      dav,
      output: { log: (line) => lines.push(line) },
    })

    expect(entries.find((entry) => entry.name === "shared.txt")?.source).toBe("both")
    expect(entries.find((entry) => entry.name === "local.txt")?.source).toBe("local")
    expect(entries.find((entry) => entry.name === "remote.txt")?.source).toBe("remote")
    expect(entries.find((entry) => entry.name === ".hidden")?.source).toBe("local")
    expect(entries.find((entry) => entry.name === "shape")?.type).toBe("file/directory")
    expect(lines.join("\n")).toContain("remote-folder/")
  })

  test("maps a nested local folder to the same relative remote folder", async () => {
    const root = await makeTempDirectory()
    const nested = join(root, "nested")
    await mkdir(nested)
    const dav = new ListingDav([remoteEntry("nested/remote.txt", "file")])

    const entries = await listFolder({ path: nested }, { localFolder: root }, {
      dav,
      output: { log() {} },
    })

    expect(dav.listedPath).toBe("nested")
    expect(entries.map((entry) => entry.name)).toEqual(["remote.txt"])
  })

  test("colors each source while preserving the table width", async () => {
    const root = await makeTempDirectory()
    await writeFile(join(root, "both.txt"), "local")
    await writeFile(join(root, "local.txt"), "local")
    const dav = new ListingDav([
      remoteEntry("both.txt", "file"),
      remoteEntry("remote.txt", "file"),
    ])
    const lines = []

    await listFolder({ path: root }, { localFolder: root }, {
      color: true,
      dav,
      output: { log: (line) => lines.push(line) },
    })

    expect(lines).toContain(`\x1b[1;32mboth    \x1b[0m file               both.txt  `)
    expect(lines).toContain(`\x1b[1;36mlocal   \x1b[0m file               local.txt `)
    expect(lines).toContain(`\x1b[1;35mremote  \x1b[0m file               remote.txt`)
  })
})

class ListingDav {
  constructor(entries) {
    this.rootFolder = "/remote"
    this.entries = entries
  }
  resolvePath(path = "/") {
    return path === "/" ? this.rootFolder : posix.join(this.rootFolder, path)
  }
  async list(path) {
    this.listedPath = path
    const requested = this.resolvePath(path)
    return this.entries.filter((entry) => posix.dirname(entry.filename) === requested)
  }
}

function remoteEntry(path, type) {
  return {
    filename: `/remote/${path}`,
    basename: posix.basename(path),
    type,
    size: 0,
    lastmod: "",
    etag: null,
  }
}

async function makeTempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "fcks-listing-"))
  temporaryDirectories.push(directory)
  return directory
}
