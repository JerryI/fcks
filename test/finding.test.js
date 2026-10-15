import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"

import { findEntries } from "../src/finding.js"
import { highlightPath, wrapPath } from "../src/finding-tui.js"

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("combined file finding", () => {
  test("wraps long result paths at folder boundaries and hard-wraps long names", () => {
    expect(wrapPath("a/very/long/path/file.txt", 10)).toEqual([
      "a/very/",
      "long/path/",
      "file.txt",
    ])
    expect(wrapPath("averylongfilename.txt", 8)).toEqual([
      "averylon",
      "gfilenam",
      "e.txt",
    ])
  })

  test("highlights only the final filename when it has an extension", () => {
    expect(highlightPath("docs/long/report.pdf", 10)).toEqual([
      [{ text: "docs/long/", bold: false }],
      [{ text: "report.pdf", bold: true }],
    ])
    expect(highlightPath("docs/README", 20)).toEqual([
      [{ text: "docs/README", bold: false }],
    ])
  })

  test("matches a basename recursively on both sides", async () => {
    const root = await makeTempDirectory()
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src", "app.js"), "local")
    await writeFile(join(root, ".hidden.js"), "hidden")
    const dav = new FindingDav([
      remoteEntry("src/app.js", "file"),
      remoteEntry("lib/remote.js", "file"),
      remoteEntry("lib/readme.md", "file"),
    ])

    const entries = await findEntries({ path: root }, ["*.js"], { localFolder: root }, {
      dav,
      output: { log() {} },
    })

    expect(entries.map(({ path, source }) => [path, source])).toEqual([
      [".hidden.js", "local"],
      ["lib/remote.js", "remote"],
      ["src/app.js", "both"],
    ])
  })

  test("matches relative path globs and combines multiple patterns with OR", async () => {
    const root = await makeTempDirectory()
    await mkdir(join(root, "docs", "drafts"), { recursive: true })
    await writeFile(join(root, "docs", "drafts", "final-a.pdf"), "local")
    await writeFile(join(root, "LICENSE"), "local")
    const dav = new FindingDav([
      remoteEntry("docs/2026/final-b.pdf", "file"),
      remoteEntry("docs/2026/notes.txt", "file"),
    ])

    const entries = await findEntries(
      { path: root },
      ["docs/**/final-?.pdf", "LICENSE"],
      { localFolder: root },
      { dav, output: { log() {} } },
    )

    expect(entries.map((entry) => entry.path)).toEqual([
      "docs/2026/final-b.pdf",
      "docs/drafts/final-a.pdf",
      "LICENSE",
    ])
  })

  test("reports an empty result without failing", async () => {
    const root = await makeTempDirectory()
    const lines = []

    const entries = await findEntries({ path: root }, ["*.missing"], { localFolder: root }, {
      dav: new FindingDav([]),
      output: { log: (line) => lines.push(line) },
    })

    expect(entries).toEqual([])
    expect(lines.at(-1)).toBe("No matching local or remote entries.")
  })

  test("runs exact-item actions from interactive results and reports progress", async () => {
    const root = await makeTempDirectory()
    await mkdir(join(root, "docs"))
    await writeFile(join(root, "notes.txt"), "notes")
    const actions = [
      { type: "sync", command: "push", path: "remote.txt" },
      { type: "open", path: "notes.txt" },
      { type: "shell", path: "docs" },
      null,
    ]
    const progressEvents = []
    const syncTargets = []
    const opened = []
    const shells = []

    await findEntries({ path: root }, ["*"], { localFolder: root }, {
      dav: new FindingDav([remoteEntry("remote.txt", "file")]),
      useTui: true,
      renderFinding: async ({ buildEntries }) => {
        await buildEntries({
          update: (...event) => progressEvents.push(["update", ...event]),
          finish: (...event) => progressEvents.push(["finish", ...event]),
        })
        return actions.shift()
      },
      synchronize: async (target) => syncTargets.push(target),
      openLocal: async (...args) => opened.push(args),
      openShell: async (...args) => shells.push(args),
    })

    expect(syncTargets).toEqual([{
      path: join(root, "remote.txt"),
      command: "push",
      force: false,
    }])
    expect(opened).toEqual([[join(root, "notes.txt"), false]])
    expect(shells).toEqual([[join(root, "docs")]])
    expect(progressEvents).toContainEqual(["update", "Matching patterns", 0, 3])
    expect(progressEvents).toContainEqual(["finish", "Matching patterns", 3, 3])
  })
})

class FindingDav {
  constructor(entries) {
    this.rootFolder = "/remote"
    this.entries = entries
  }
  resolvePath(path = "/") {
    return path === "/" ? this.rootFolder : posix.join(this.rootFolder, path)
  }
  async list() {
    return this.entries
  }
  async stat(path) {
    const requested = this.resolvePath(path)
    if (requested === this.rootFolder) return remoteEntry("", "directory")
    const entry = this.entries.find((candidate) => candidate.filename === requested)
    if (entry) return entry
    const error = new Error("not found")
    error.status = 404
    throw error
  }
}

function remoteEntry(path, type) {
  return {
    filename: path ? `/remote/${path}` : "/remote",
    basename: posix.basename(path),
    type,
  }
}

async function makeTempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "fcks-finding-"))
  temporaryDirectories.push(directory)
  return directory
}
