import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  getAppDataDirectory,
  getConfigPath,
  loadConfig,
  normalizeRootFolder,
  resetConfig,
  saveConfig,
} from "../src/config.js"

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("configuration", () => {
  test("uses each OS user config convention", () => {
    expect(getConfigPath({ platform: "darwin", home: "/Users/me", env: {} }))
      .toBe("/Users/me/Library/Application Support/fcks/config.json")
    expect(getConfigPath({ platform: "linux", home: "/home/me", env: {} }))
      .toBe("/home/me/.config/fcks/config.json")
    expect(getConfigPath({ platform: "linux", home: "/home/me", env: { XDG_CONFIG_HOME: "/cfg" } }))
      .toBe("/cfg/fcks/config.json")
    expect(getConfigPath({ platform: "win32", home: "C:\\Users\\me", env: { APPDATA: "C:\\Data" } }))
      .toBe("C:\\Data\\fcks\\config.json")
  })

  test("saves, normalizes, and reloads configuration", async () => {
    const directory = await makeTempDirectory()
    const path = join(directory, "nested", "config.json")

    await saveConfig({
      serverUrl: "https://dav.example.com/",
      username: "kirill",
      password: "secret",
      localFolder: "/local/docs",
      rootFolder: "/work/./notes/../docs/",
    }, path)

    expect(await loadConfig(path)).toEqual({
      serverUrl: "https://dav.example.com",
      username: "kirill",
      password: "secret",
      localFolder: "/local/docs",
      rootFolder: "/work/docs",
    })
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })

  test("returns null for a missing file and rejects malformed config", async () => {
    const directory = await makeTempDirectory()
    expect(await loadConfig(join(directory, "missing.json"))).toBeNull()

    const path = join(directory, "bad.json")
    await writeFile(path, "{}")
    await expect(loadConfig(path)).rejects.toThrow("Invalid fcks configuration")
  })

  test("loads a config from before local-folder support", async () => {
    const directory = await makeTempDirectory()
    const path = join(directory, "old.json")
    await writeFile(path, JSON.stringify({
      serverUrl: "https://dav.example.com",
      username: "user",
      password: "secret",
      rootFolder: "/remote",
    }))

    expect((await loadConfig(path))?.localFolder).toBe("")
  })

  test("normalizes a root folder", () => {
    expect(normalizeRootFolder("/")).toBe("/")
    expect(normalizeRootFolder("projects\\one/../two/")).toBe("/projects/two")
  })

  test("reset removes only the fcks app-data directory", async () => {
    const directory = await makeTempDirectory()
    const options = {
      platform: "linux",
      home: directory,
      env: { XDG_CONFIG_HOME: join(directory, "config") },
    }
    const appData = getAppDataDirectory(options)
    await mkdir(appData, { recursive: true })
    await writeFile(join(appData, "cache.bin"), "cached")

    expect(await resetConfig(options)).toBe(appData)
    await expect(stat(appData)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await stat(join(directory, "config"))).isDirectory()).toBe(true)
  })
})

async function makeTempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "fcks-config-"))
  temporaryDirectories.push(directory)
  return directory
}
