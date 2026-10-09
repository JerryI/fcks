import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveConfiguredLocalFolder, resolveSyncTarget } from "../src/target.js"

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("local sync target", () => {
  test("keeps a directory path", async () => {
    const directory = await makeTempDirectory()
    const child = join(directory, "folder")
    await mkdir(child)
    expect(await resolveSyncTarget("folder", directory)).toEqual({ path: child })
  })

  test("keeps an exact file path", async () => {
    const directory = await makeTempDirectory()
    const file = join(directory, "notes.txt")
    await writeFile(file, "hello")
    expect(await resolveSyncTarget(file)).toEqual({ path: file })
  })

  test("allows an exact missing path when requested", async () => {
    const directory = await makeTempDirectory()
    const missing = join(directory, "missing")

    expect(await resolveSyncTarget(missing, directory, { allowMissing: true })).toEqual({ path: missing })
  })

  test("rejects a missing target", async () => {
    const directory = await makeTempDirectory()
    await expect(resolveSyncTarget("missing", directory)).rejects.toThrow()
  })

  test("resolves quoted and home-relative configured folders", async () => {
    const directory = await makeTempDirectory()
    const child = join(directory, "folder with spaces")
    await mkdir(child)

    expect(await resolveConfiguredLocalFolder('"folder with spaces"', directory)).toBe(child)
    expect(await resolveConfiguredLocalFolder("~/folder with spaces", "/", directory)).toBe(child)
  })

  test("requires the configured local path to be a folder", async () => {
    const directory = await makeTempDirectory()
    const file = join(directory, "notes.txt")
    await writeFile(file, "hello")
    await expect(resolveConfiguredLocalFolder(file)).rejects.toThrow("must be a folder")
  })
})

async function makeTempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "fcks-target-"))
  temporaryDirectories.push(directory)
  return directory
}
