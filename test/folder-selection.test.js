import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"

import {
  readLocalChildFolders,
  readRemoteChildFolders,
  selectSyncChild,
} from "../src/folder-selection.js"

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("sync child folder selection", () => {
  test("lists only immediate local directories", async () => {
    const root = await makeTempDirectory()
    await mkdir(join(root, "z-folder"))
    await mkdir(join(root, ".hidden"))
    await writeFile(join(root, "file.txt"), "file")

    expect(await readLocalChildFolders(root)).toEqual([".hidden", "z-folder"])
  })

  test("lists only immediate remote directories", async () => {
    const dav = new SelectionDav([
      remoteEntry("base", "directory"),
      remoteEntry("base/z-folder", "directory"),
      remoteEntry("base/a-folder", "directory"),
      remoteEntry("base/file.txt", "file"),
      remoteEntry("base/a-folder/nested", "directory"),
    ])

    expect(await readRemoteChildFolders(dav, "base")).toEqual(["a-folder", "z-folder"])
    expect(dav.listedPath).toBe("base")
  })

  test("pull creates and returns the selected remote child path", async () => {
    const root = await makeTempDirectory()
    const dav = new SelectionDav([remoteEntry("photos", "directory")])

    const selected = await selectSyncChild({ command: "pull", path: root }, { localFolder: root }, {
      dav,
      choose: async ({ folders }) => {
        expect(folders).toEqual(["photos"])
        return "photos"
      },
    })

    expect(selected).toBe(join(root, "photos"))
    expect((await stat(selected)).isDirectory()).toBe(true)
  })

  test("push returns a selected local child without creating anything", async () => {
    const root = await makeTempDirectory()
    await mkdir(join(root, "documents"))

    const selected = await selectSyncChild({ command: "push", path: root }, { localFolder: root }, {
      choose: async () => "documents",
    })

    expect(selected).toBe(join(root, "documents"))
  })

  test("cancellation does not create the remote child locally", async () => {
    const root = await makeTempDirectory()
    const dav = new SelectionDav([remoteEntry("photos", "directory")])

    const selected = await selectSyncChild({ command: "pull", path: root }, { localFolder: root }, {
      dav,
      choose: async () => null,
    })

    expect(selected).toBeNull()
    await expect(stat(join(root, "photos"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

class SelectionDav {
  constructor(entries) {
    this.rootFolder = "/remote"
    this.entries = entries
  }
  resolvePath(path = "/") {
    return path === "/" ? this.rootFolder : posix.join(this.rootFolder, path)
  }
  async list(path) {
    this.listedPath = path
    return this.entries
  }
}

function remoteEntry(path, type) {
  return {
    filename: `/remote/${path}`,
    basename: posix.basename(path),
    type,
  }
}

async function makeTempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "fcks-selection-"))
  temporaryDirectories.push(directory)
  return directory
}
