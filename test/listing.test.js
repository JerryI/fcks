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

  test("derives actionable names from safe remote paths", async () => {
    const root = await makeTempDirectory()
    const entry = remoteEntry("safe.txt", "file")
    entry.basename = "../outside.txt"

    const entries = await listFolder({ path: root }, { localFolder: root }, {
      dav: new ListingDav([entry]),
      output: { log() {} },
    })

    expect(entries.map((item) => item.name)).toEqual(["safe.txt"])
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

  test("uses the interactive listing renderer when requested", async () => {
    const root = await makeTempDirectory()
    await writeFile(join(root, "local.txt"), "local")
    const renders = []

    const entries = await listFolder({ path: root }, { localFolder: root }, {
      dav: new ListingDav([remoteEntry("remote-folder", "directory")]),
      useTui: true,
      renderListing: async (listing) => renders.push(listing),
    })

    expect(renders).toHaveLength(1)
    expect(renders[0].path).toBe(root)
    expect(renders[0].entries).toEqual([
      expect.objectContaining({ name: "local.txt", source: "local", displayName: "local.txt" }),
      expect.objectContaining({ name: "remote-folder", source: "remote", displayName: "remote-folder/" }),
    ])
    expect(entries.map((entry) => entry.name)).toEqual(["local.txt", "remote-folder"])
  })

  test("browses remote-only folders and pulls an exact selected file", async () => {
    const root = await makeTempDirectory()
    const dav = new ListingDav([
      remoteEntry("remote-folder", "directory"),
      remoteEntry("remote-folder/nested", "directory"),
      remoteEntry("remote-folder/nested/report.pdf", "file"),
    ])
    const renders = []
    const syncTargets = []
    const actions = [
      { type: "open", name: "remote-folder" },
      { type: "open", name: "nested" },
      { type: "sync", command: "pull", name: "report.pdf" },
      null,
    ]

    await listFolder({ path: root }, { localFolder: root }, {
      dav,
      useTui: true,
      renderListing: async (listing) => {
        renders.push(listing)
        return actions.shift()
      },
      synchronize: async (target) => {
        syncTargets.push(target)
        return { actions: [] }
      },
    })

    expect(renders.map((render) => render.path)).toEqual([
      root,
      join(root, "remote-folder"),
      join(root, "remote-folder", "nested"),
      join(root, "remote-folder", "nested"),
    ])
    expect(renders[1].canGoUp).toBe(true)
    expect(syncTargets).toEqual([{
      path: join(root, "remote-folder", "nested", "report.pdf"),
      command: "pull",
      force: false,
    }])
  })

  test("dispatches either direction even when its source side is missing", async () => {
    const root = await makeTempDirectory()
    const actions = [
      { type: "sync", command: "push", name: "remote.txt" },
      null,
    ]
    const syncTargets = []

    await listFolder({ path: root }, { localFolder: root }, {
      dav: new ListingDav([remoteEntry("remote.txt", "file")]),
      useTui: true,
      renderListing: async () => actions.shift(),
      synchronize: async (target) => syncTargets.push(target),
    })

    expect(syncTargets).toEqual([{
      path: join(root, "remote.txt"),
      command: "push",
      force: false,
    }])
  })

  test("dispatches merge for the exact selected item", async () => {
    const root = await makeTempDirectory()
    await writeFile(join(root, "notes.txt"), "notes")
    const actions = [
      { type: "sync", command: "merge", name: "notes.txt" },
      null,
    ]
    const syncTargets = []

    await listFolder({ path: root }, { localFolder: root }, {
      dav: new ListingDav([]),
      useTui: true,
      renderListing: async () => actions.shift(),
      synchronize: async (target) => syncTargets.push(target),
    })

    expect(syncTargets).toEqual([{
      path: join(root, "notes.txt"),
      command: "merge",
      force: false,
    }])
  })

  test("keeps text output when the interactive renderer is disabled", async () => {
    const root = await makeTempDirectory()
    await writeFile(join(root, "local.txt"), "local")
    const lines = []

    await listFolder({ path: root }, { localFolder: root }, {
      dav: new ListingDav([]),
      useTui: false,
      output: { log: (line) => lines.push(line) },
    })

    expect(lines[0]).toBe(`Listing ${root}`)
    expect(lines.join("\n")).toContain("local.txt")
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

  test("rejects an exact local file target", async () => {
    const root = await makeTempDirectory()
    const file = join(root, "notes.txt")
    await writeFile(file, "notes")

    await expect(listFolder({ path: file }, { localFolder: root }, {
      dav: new ListingDav([]),
      output: { log() {} },
    })).rejects.toThrow("List target is not a folder")
  })

  test("rejects an exact remote-only file target", async () => {
    const root = await makeTempDirectory()
    const file = join(root, "remote.txt")

    await expect(listFolder({ path: file }, { localFolder: root }, {
      dav: new ListingDav([remoteEntry("remote.txt", "file")]),
      output: { log() {} },
    })).rejects.toThrow("List target is not a folder")
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
  async stat(path) {
    const requested = this.resolvePath(path)
    if (requested === this.rootFolder || this.entries.some((entry) => entry.filename.startsWith(`${requested}/`))) {
      return remoteEntry(requested.slice(`${this.rootFolder}/`.length), "directory")
    }
    const entry = this.entries.find((candidate) => candidate.filename === requested)
    if (entry) return entry
    const error = new Error("not found")
    error.status = 404
    throw error
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
