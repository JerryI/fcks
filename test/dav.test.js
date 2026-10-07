import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"

import { DavClient } from "../src/dav.js"

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("DAV API", () => {
  test("keeps every operation under the configured root", async () => {
    const calls = []
    const remote = fakeDav(calls)
    const dav = new DavClient({
      serverUrl: "https://dav.example.com/",
      rootFolder: "/team/docs/",
    }, remote)

    expect(dav.serverUrl).toBe("https://dav.example.com")
    expect(dav.rootFolder).toBe("/team/docs")
    expect(dav.resolvePath("/")).toBe("/team/docs")
    expect(dav.resolvePath("notes/today.md")).toBe("/team/docs/notes/today.md")
    expect(() => dav.resolvePath("../outside")).toThrow("may not escape")

    await dav.list("notes")
    await dav.put("notes/today.md", "hello", false)
    await dav.createDirectory("archive/2026")
    await dav.move("one", "two")
    await dav.copy("two", "three", false)
    await dav.delete("old")

    expect(calls).toContainEqual(["list", "/team/docs/notes", false])
    expect(calls).toContainEqual(["put", "/team/docs/notes/today.md", "hello", false])
    expect(calls).toContainEqual(["mkdir", "/team/docs/archive/2026", true])
    expect(calls).toContainEqual(["move", "/team/docs/one", "/team/docs/two", true])
    expect(calls).toContainEqual(["copy", "/team/docs/two", "/team/docs/three", false])
    expect(calls).toContainEqual(["delete", "/team/docs/old"])
  })

  test("provides server ETags and explicit content hashes", async () => {
    const dav = new DavClient({ serverUrl: "https://dav.example.com" }, fakeDav([]))

    expect(await dav.getEtag("hello.txt")).toBe('"server-etag"')
    expect(await dav.getHash("hello.txt")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    )
    expect(await dav.getText("hello.txt")).toBe("hello")
  })

  if (process.platform !== "win32") {
    test("preserves the mode of a replaced local file", async () => {
      const directory = await mkdtemp(join(tmpdir(), "fcks-dav-"))
      temporaryDirectories.push(directory)
      const destination = join(directory, "script.sh")
      await writeFile(destination, "old")
      await chmod(destination, 0o751)
      const dav = new DavClient({ serverUrl: "https://dav.example.com" }, {
        async customRequest() {
          return { body: Readable.from([Buffer.from("new")]) }
        },
      })

      await dav.download("script.sh", destination)

      expect(await readFile(destination, "utf8")).toBe("new")
      expect((await stat(destination)).mode & 0o777).toBe(0o751)
    })

    test("creates a new local file with the process default mode", async () => {
      const directory = await mkdtemp(join(tmpdir(), "fcks-dav-"))
      temporaryDirectories.push(directory)
      const destination = join(directory, "new.txt")
      const dav = new DavClient({ serverUrl: "https://dav.example.com" }, {
        async customRequest() {
          return { body: Readable.from([Buffer.from("new")]) }
        },
      })

      await dav.download("new.txt", destination)

      expect((await stat(destination)).mode & 0o777).toBe(0o666 & ~process.umask())
    })
  }

  test("interrupts a direct download without leaving a staging file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fcks-dav-"))
    temporaryDirectories.push(directory)
    const destination = join(directory, "partial.bin")
    const controller = new AbortController()
    const dav = new DavClient({ serverUrl: "https://dav.example.com" }, {
      async customRequest() {
        return { body: Readable.from([Buffer.alloc(1024), Buffer.alloc(1024)]) }
      },
    })

    await expect(dav.download("large.bin", destination, () => controller.abort(), controller.signal))
      .rejects.toMatchObject({ name: "AbortError" })

    expect(await readdir(directory)).toEqual(["partial.bin"])
    expect((await stat(destination)).size).toBeLessThan(2048)
  })

  test("interrupts a streamed upload cleanly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fcks-dav-"))
    temporaryDirectories.push(directory)
    const source = join(directory, "large.bin")
    await writeFile(source, Buffer.alloc(128 * 1024))
    const controller = new AbortController()
    const dav = new DavClient({ serverUrl: "https://dav.example.com" }, {
      async putFileContents(_path, stream) {
        for await (const _chunk of stream) {}
        return true
      },
    })

    await expect(dav.upload(source, "large.bin", true, () => controller.abort(), controller.signal))
      .rejects.toMatchObject({ name: "AbortError" })
  })
})

function fakeDav(calls) {
  return {
    async getDirectoryContents(path, options) {
      calls.push(["list", path, options.deep])
      return []
    },
    async stat(path) {
      calls.push(["stat", path])
      return {
        filename: path,
        basename: path.split("/").at(-1) ?? "",
        lastmod: "",
        size: 5,
        type: "file",
        etag: '"server-etag"',
      }
    },
    async exists(path) {
      calls.push(["exists", path])
      return true
    },
    async getFileContents(path, options) {
      calls.push(["get", path, options.format])
      return options.format === "text" ? "hello" : new TextEncoder().encode("hello")
    },
    async putFileContents(path, contents, options) {
      calls.push(["put", path, contents, options.overwrite])
      return true
    },
    async createDirectory(path, options) {
      calls.push(["mkdir", path, options.recursive])
    },
    async deleteFile(path) {
      calls.push(["delete", path])
    },
    async moveFile(source, destination, options) {
      calls.push(["move", source, destination, options.overwrite])
    },
    async copyFile(source, destination, options) {
      calls.push(["copy", source, destination, options.overwrite])
    },
    async getQuota(options) {
      calls.push(["quota", options.path])
      return { used: 1, available: 2 }
    },
  }
}
