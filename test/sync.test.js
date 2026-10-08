import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildSyncPlan, executeSyncPlan, printSyncPlan } from "../src/sync.js"
import { assertWithinLocalRoot } from "../src/target.js"

const temporaryDirectories = []
const progress = { update() {}, finish() {} }

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("sync planner", () => {
  test("push includes hidden and nested files and removes remote-only files", async () => {
    const root = await makeTempDirectory()
    await mkdir(join(root, "nested"))
    await writeFile(join(root, ".hidden"), "secret")
    await writeFile(join(root, "nested", "same.txt"), "same")
    const remote = new FakeDav([
      { ...remoteFile("nested/same.txt", "same"), etag: '"47e08437af8803beb69e4fc19e44dd21"' },
      remoteFile("old.txt", "old"),
    ])

    const plan = await buildSyncPlan({ command: "push", scope: rootScope(root), dav: remote, progress })
    expect(plan.actions.map(({ type, path }) => [type, path])).toEqual([
      ["remove-remote", "old.txt"],
      ["upload-add", ".hidden"],
    ])
  })

  test("push honors local ignore rules without hiding the ignore file itself", async () => {
    const root = await makeTempDirectory()
    await mkdir(join(root, "cache"))
    await writeFile(join(root, ".fcksignore"), "*.tmp\ncache/\n!important.tmp\n")
    await writeFile(join(root, "draft.tmp"), "local draft")
    await writeFile(join(root, "important.tmp"), "important")
    await writeFile(join(root, "keep.txt"), "keep")
    await writeFile(join(root, "cache", "entry.txt"), "cached")
    const remote = new FakeDav([
      remoteFile("remote.tmp", "remote draft"),
      remoteFile("cache/old.txt", "old cache"),
      remoteFile("remove.txt", "remove"),
    ])

    const plan = await buildSyncPlan({ command: "push", scope: rootScope(root), dav: remote, progress })

    expect(plan.actions.map(({ type, path }) => [type, path])).toEqual([
      ["remove-remote", "remove.txt"],
      ["upload-add", ".fcksignore"],
      ["upload-add", "important.tmp"],
      ["upload-add", "keep.txt"],
    ])
  })

  test("merge uses the newer remote ignore file before planning sync", async () => {
    const root = await makeTempDirectory()
    await writeFile(join(root, ".fcksignore"), "*.local\n")
    await writeFile(join(root, "send.local"), "send")
    await writeFile(join(root, "skip.remote"), "skip")
    await utimes(join(root, ".fcksignore"), new Date(1_000), new Date(1_000))
    const remote = new FakeDav([
      remoteFile(".fcksignore", "*.remote\n", 3_000),
    ])

    const plan = await buildSyncPlan({ command: "merge", scope: rootScope(root), dav: remote, progress })

    expect(remote.textReads).toEqual([".fcksignore"])
    expect(plan.actions.map(({ type, path }) => [type, path])).toEqual([
      ["upload-add", "send.local"],
      ["download-update", ".fcksignore"],
    ])
  })

  test("push uses the newer local ignore file without reading the older remote copy", async () => {
    const root = await makeTempDirectory()
    await writeFile(join(root, ".fcksignore"), "*.tmp\n")
    await writeFile(join(root, "keep.txt"), "keep")
    await writeFile(join(root, "skip.tmp"), "skip")
    await utimes(join(root, ".fcksignore"), new Date(3_000), new Date(3_000))
    const remote = new FakeDav([
      remoteFile(".fcksignore", "*.txt\n", 1_000),
    ])

    const plan = await buildSyncPlan({ command: "push", scope: rootScope(root), dav: remote, progress })

    expect(remote.textReads).toEqual([])
    expect(plan.actions.map(({ type, path }) => [type, path])).toEqual([
      ["upload-add", "keep.txt"],
      ["upload-update", ".fcksignore"],
    ])
  })

  test("nested ignore rules are scoped to their containing folder", async () => {
    const root = await makeTempDirectory()
    await mkdir(join(root, "nested"))
    await writeFile(join(root, "private.txt"), "root")
    await writeFile(join(root, "nested", ".fcksignore"), "/private.txt\n*.tmp\n")
    await writeFile(join(root, "nested", "private.txt"), "nested")
    await mkdir(join(root, "nested", "deeper"))
    await writeFile(join(root, "nested", "deeper", "private.txt"), "deeper")
    await writeFile(join(root, "nested", "draft.tmp"), "draft")
    await writeFile(join(root, "nested", "keep.txt"), "keep")
    const remote = new FakeDav([])

    const plan = await buildSyncPlan({ command: "push", scope: rootScope(root), dav: remote, progress })

    expect(plan.actions.map(({ type, path }) => [type, path])).toEqual([
      ["upload-add", "nested/.fcksignore"],
      ["upload-add", "nested/deeper/private.txt"],
      ["upload-add", "nested/keep.txt"],
      ["upload-add", "private.txt"],
    ])
  })

  test("preserves the path below the configured local root", async () => {
    const root = await makeTempDirectory()
    const target = join(root, "bar")
    await mkdir(join(target, "one"), { recursive: true })
    await writeFile(join(target, "one", "test.txt"), "test")
    const remote = new FakeDav([])

    const plan = await buildSyncPlan({
      command: "push",
      scope: { root, target, relativePath: "bar" },
      dav: remote,
      progress,
    })
    expect(plan.actions.map(({ type, path }) => [type, path])).toEqual([
      ["upload-add", "bar/one/test.txt"],
    ])
  })

  test("pull treats remote as authoritative", async () => {
    const root = await makeTempDirectory()
    await writeFile(join(root, "local-only.txt"), "local")
    await writeFile(join(root, "changed.txt"), "local version")
    const remote = new FakeDav([
      remoteFile("changed.txt", "remote version"),
      remoteFile("remote-only.txt", "remote"),
    ])

    const plan = await buildSyncPlan({ command: "pull", scope: rootScope(root), dav: remote, progress })
    expect(plan.actions.map(({ type, path }) => [type, path])).toEqual([
      ["remove-local", "local-only.txt"],
      ["download-add", "remote-only.txt"],
      ["download-update", "changed.txt"],
    ])
  })

  test("executes streamed-transfer actions and creates a shared remote parent once", async () => {
    const root = await makeTempDirectory()
    await mkdir(join(root, "nested"))
    await writeFile(join(root, "nested", "one.txt"), "one")
    await writeFile(join(root, "nested", "two.txt"), "two")
    const remote = new FakeDav([remoteFile("old.txt", "old")])
    const plan = await buildSyncPlan({ command: "push", scope: rootScope(root), dav: remote, progress })

    await executeSyncPlan(plan, { dav: remote, progress })
    expect(remote.createdDirectories).toEqual(["nested"])
    expect(remote.deleted).toEqual(["old.txt"])
    expect(remote.contents.get("nested/one.txt").toString()).toBe("one")
    expect(remote.contents.get("nested/two.txt").toString()).toBe("two")
  })

  test("merge keeps both unique files and sends a changed file toward the newer side", async () => {
    const root = await makeTempDirectory()
    await writeFile(join(root, "local-only.txt"), "local")
    await writeFile(join(root, "changed.txt"), "new local")
    await utimes(join(root, "changed.txt"), new Date(3_000), new Date(3_000))
    const remote = new FakeDav([
      remoteFile("remote-only.txt", "remote", 2_000),
      remoteFile("changed.txt", "old remote", 1_000),
    ])

    const plan = await buildSyncPlan({ command: "merge", scope: rootScope(root), dav: remote, progress })
    expect(plan.actions.map(({ type, path }) => [type, path])).toEqual([
      ["upload-add", "local-only.txt"],
      ["download-add", "remote-only.txt"],
      ["upload-update", "changed.txt"],
    ])
  })

  test("merge leaves file-directory conflicts and their descendants untouched", async () => {
    const root = await makeTempDirectory()
    await writeFile(join(root, "local-file"), "local")
    await mkdir(join(root, "local-directory"))
    await writeFile(join(root, "local-directory", "child.txt"), "child")
    const remote = new FakeDav([
      remoteDirectory("local-file"),
      remoteFile("local-file/remote-child.txt", "remote child"),
      remoteFile("local-directory", "remote file"),
    ])

    const plan = await buildSyncPlan({ command: "merge", scope: rootScope(root), dav: remote, progress })
    expect(plan.actions.map(({ type, path }) => [type, path])).toEqual([
      ["conflict", "local-directory"],
      ["conflict", "local-file"],
    ])
  })

  if (process.platform !== "win32") {
    test("preserves a literal backslash in a POSIX filename", async () => {
      const root = await makeTempDirectory()
      const filename = "draft\\final.txt"
      await writeFile(join(root, filename), "content")
      const remote = new FakeDav([])

      const plan = await buildSyncPlan({ command: "push", scope: rootScope(root), dav: remote, progress })
      expect(plan.actions.map(({ type, path }) => [type, path])).toEqual([["upload-add", filename]])
      await executeSyncPlan(plan, { dav: remote, progress })
      expect(remote.contents.get(filename).toString()).toBe("content")
    })
  }

  test("scaffold preserves local contents and creates directories implied by remote files", async () => {
    const root = await makeTempDirectory()
    await mkdir(join(root, "obsolete"))
    await writeFile(join(root, "obsolete", "local.txt"), "local")
    const remote = new FakeDav([
      remoteFile("a/b/one.txt", "one"),
      remoteFile("top.txt", "top"),
    ])

    const plan = await buildSyncPlan({ command: "scaffold", scope: rootScope(root), dav: remote, progress })
    expect(plan.remoteFileCount).toBe(2)
    await executeSyncPlan(plan, { dav: remote, progress })

    expect((await stat(join(root, "a", "b"))).isDirectory()).toBe(true)
    expect((await stat(join(root, "obsolete"))).isDirectory()).toBe(true)
    expect(await readFile(join(root, "obsolete", "local.txt"), "utf8")).toBe("local")
    await expect(stat(join(root, "a", "b", "one.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("free removes files while preserving all directories", async () => {
    const root = await makeTempDirectory()
    await mkdir(join(root, "a", "b"), { recursive: true })
    await writeFile(join(root, "a", "b", "file.txt"), "data")
    await writeFile(join(root, "a", ".fcksignore"), "b/\n")

    const plan = await buildSyncPlan({ command: "free", scope: rootScope(root), dav: new FakeDav([]), progress })
    const lines = []
    printSyncPlan(plan, { log: (line) => lines.push(line) })
    expect(lines).toContain("Estimated size: 7 B to be freed locally.")
    await executeSyncPlan(plan, { dav: new FakeDav([]), progress })
    expect((await stat(join(root, "a", "b"))).isDirectory()).toBe(true)
    await expect(stat(join(root, "a", "b", "file.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(join(root, "a", ".fcksignore"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("previews approximate upload, download, and freed sizes", () => {
    const lines = []
    const plan = {
      command: "merge",
      scope: { target: "/example" },
      local: {
        files: new Map([
          ["old.txt", { size: 512 }],
        ]),
      },
      remote: {
        files: new Map([
          ["archive/one.bin", { size: 1_024 }],
          ["archive/two.bin", { size: 3_072 }],
        ]),
      },
      actions: [
        { type: "upload-add", path: "up.bin", primary: { size: 1_536 } },
        { type: "download-add", path: "down.bin", primary: { size: 2 * 1_024 * 1_024 } },
        { type: "remove-local", path: "old.txt", primary: { size: 512 } },
        { type: "remove-remote-directory", path: "archive" },
      ],
    }

    printSyncPlan(plan, { log: (line) => lines.push(line) })

    expect(lines).toContain("Estimated size: 1.5 KB to upload · 2.0 MB to download · 512 B to be freed locally · 4.0 KB to be freed remotely.")
  })

  test("shows a zero-byte estimate when empty files will be transferred", () => {
    const lines = []
    const plan = {
      command: "push",
      scope: { target: "/example" },
      local: { files: new Map(), dirs: new Set() },
      remote: { files: new Map(), dirs: new Set() },
      actions: [{ type: "upload-add", path: "empty.txt", primary: { size: 0 } }],
    }

    printSyncPlan(plan, { log: (line) => lines.push(line) })

    expect(lines).toContain("Estimated size: 0 B to upload.")
  })

  test("interrupts active transfers, reports completed work, and stops scheduling more", async () => {
    const root = await makeTempDirectory()
    const actions = []
    for (let index = 0; index < 5; index += 1) {
      const path = `${index}.txt`
      const absolute = join(root, path)
      await writeFile(absolute, String(index))
      actions.push({
        type: "upload-add",
        path,
        primary: { path, absolute, size: 1, mtimeMs: 0 },
      })
    }
    const abortController = new AbortController()
    const dav = new InterruptDav(abortController)
    const plan = {
      command: "push",
      scope: rootScope(root),
      local: { files: new Map(), dirs: new Set() },
      remote: { files: new Map(), dirs: new Set() },
      actions,
    }

    try {
      await executeSyncPlan(plan, { dav, progress, signal: abortController.signal })
      throw new Error("expected interruption")
    } catch (error) {
      expect(error.name).toBe("AbortError")
      expect(error.completedOperations).toBeGreaterThanOrEqual(0)
      expect(error.completedOperations).toBeLessThanOrEqual(1)
    }
    expect(dav.started.length).toBeLessThanOrEqual(3)
    expect(dav.started).not.toContain("3.txt")
    expect(dav.started).not.toContain("4.txt")
  })

  test("stops scheduling after a failure and waits for active operations", async () => {
    const root = await makeTempDirectory()
    const actions = []
    for (let index = 0; index < 5; index += 1) {
      const path = `${index}.txt`
      const absolute = join(root, path)
      await writeFile(absolute, String(index))
      actions.push({ type: "upload-add", path, primary: { path, absolute, size: 1, mtimeMs: 0 } })
    }
    const dav = new FailureDav()
    const plan = {
      command: "push",
      scope: rootScope(root),
      local: { files: new Map(), dirs: new Set() },
      remote: { files: new Map(), dirs: new Set() },
      actions,
    }

    try {
      await executeSyncPlan(plan, { dav, progress })
      throw new Error("expected failure")
    } catch (error) {
      expect(error.message).toContain('Failed to add to remote "0.txt"')
      expect(error.completedOperations).toBe(2)
    }
    expect(dav.started).toEqual(["0.txt", "1.txt", "2.txt"])
    expect(dav.active).toBe(0)
  })

  test("rejects targets outside the configured local root", async () => {
    const root = await makeTempDirectory()
    const outside = await makeTempDirectory()
    await expect(assertWithinLocalRoot(outside, root)).rejects.toThrow("inside the configured local root")
  })
})

class FakeDav {
  constructor(entries) {
    this.rootFolder = "/remote"
    this.entries = entries
    this.contents = new Map(entries.filter((entry) => entry.type === "file").map((entry) => [entry.filename.slice("/remote/".length), entry.contents]))
    this.createdDirectories = []
    this.deleted = []
    this.textReads = []
  }
  async list() {
    return this.entries
  }
  async hashLocalFile(path, algorithm) {
    return createHash(algorithm).update(await readFile(path)).digest("hex")
  }
  async getHash(path, algorithm) {
    return createHash(algorithm).update(this.contents.get(path)).digest("hex")
  }
  async getText(path) {
    this.textReads.push(path)
    return this.contents.get(path).toString("utf8")
  }
  async createDirectory(path) {
    this.createdDirectories.push(path)
  }
  async upload(source, path) {
    this.contents.set(path, await readFile(source))
  }
  async delete(path) {
    this.deleted.push(path)
    this.contents.delete(path)
  }
}

class InterruptDav {
  constructor(abortController) {
    this.abortController = abortController
    this.started = []
  }
  async upload(_source, path, _overwrite, _onProgress, signal) {
    this.started.push(path)
    if (path === "0.txt") {
      queueMicrotask(() => this.abortController.abort())
      return
    }
    await new Promise((resolve, reject) => {
      const abort = () => {
        const error = new Error("Operation interrupted")
        error.name = "AbortError"
        reject(error)
      }
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
    })
  }
}

class FailureDav {
  constructor() {
    this.started = []
    this.active = 0
  }
  async upload(_source, path) {
    this.started.push(path)
    this.active += 1
    try {
      if (path === "0.txt") throw new Error("permission denied")
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      this.active -= 1
    }
  }
}

function remoteFile(path, contents, mtimeMs = 1_000) {
  return {
    filename: `/remote/${path}`,
    basename: path.split("/").at(-1),
    type: "file",
    size: Buffer.byteLength(contents),
    lastmod: new Date(mtimeMs).toUTCString(),
    etag: `"${createHash("md5").update(contents).digest("hex")}"`,
    contents,
  }
}

function remoteDirectory(path) {
  return {
    filename: `/remote/${path}`,
    basename: path.split("/").at(-1),
    type: "directory",
    size: 0,
    lastmod: "",
    etag: null,
  }
}

function rootScope(root) {
  return { root, target: root, relativePath: "" }
}

async function makeTempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "fcks-sync-"))
  temporaryDirectories.push(directory)
  return directory
}
