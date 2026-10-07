import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getAppDataDirectory, getConfigPath, saveConfig } from "../src/config.js"
import { parseInvocation } from "../src/cli.js"

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test("normal invocation lists commands and connection status", async () => {
  const home = await makeHome()
  const result = await runCli([], home)

  expect(result.exitCode).toBe(0)
  expect(result.error).toBe("")
  expect(result.output).toContain("fcks --config")
  expect(result.output).toContain("DAV server:  not configured")
})

test("parses explicit commands, default paths, implicit merge, and force", () => {
  expect(parseInvocation(["push"])).toEqual({ command: "push", force: false, path: "." })
  expect(parseInvocation(["pull", "-f", "folder"])).toEqual({ command: "pull", force: true, path: "folder" })
  expect(parseInvocation(["merge", "folder"])).toEqual({ command: "merge", force: false, path: "folder" })
  expect(parseInvocation(["scaffold", "folder"])).toEqual({ command: "scaffold", force: false, path: "folder" })
  expect(parseInvocation(["ls", "folder"])).toEqual({ command: "ls", force: false, path: "folder" })
  expect(parseInvocation(["ph", "folder"])).toEqual({ command: "push", force: false, path: "folder" })
  expect(parseInvocation(["pl", "folder"])).toEqual({ command: "pull", force: false, path: "folder" })
  expect(parseInvocation(["sc", "folder"])).toEqual({ command: "scaffold", force: false, path: "folder" })
  expect(parseInvocation(["fr", "folder"])).toEqual({ command: "free", force: false, path: "folder" })
  expect(parseInvocation(["folder"])).toEqual({ command: "merge", force: false, path: "folder" })
})

test("passes force mode only when -f comes before the path", async () => {
  const home = await makeHome()
  const options = configOptions(home)
  await saveConfig({
    serverUrl: "https://dav.example.com",
    username: "user",
    password: "secret",
    rootFolder: "/remote",
  }, getConfigPath(options))

  const result = await runCli(["-f", "."], home)
  expect(result.exitCode).toBe(0)
  expect(result.error).toBe("")
  expect(result.output).toContain("Force mode:   yes")
  expect(result.output).toContain(`Local folder: ${join(import.meta.dir, "..")}`)

  for (const args of [[".", "-f"], ["--force", "."], ["-f", "-f", "."]]) {
    const rejected = await runCli(args, home)
    expect(rejected.exitCode).toBe(1)
    expect(rejected.output).toBe("")
    expect(rejected.error).toContain("Expected one local folder or file path")
  }
})

test("reset deletes the entire fcks app-data directory and nothing above it", async () => {
  const home = await makeHome()
  const options = configOptions(home)
  const appData = getAppDataDirectory(options)
  await mkdir(appData, { recursive: true })
  await writeFile(join(appData, "future-cache.bin"), "cache")

  const result = await runCli(["--reset"], home)
  expect(result.exitCode).toBe(0)
  expect(result.output).toContain(`Removed: ${appData}`)
  await expect(stat(appData)).rejects.toMatchObject({ code: "ENOENT" })
  expect((await stat(home)).isDirectory()).toBe(true)
})

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), "fcks-cli-"))
  temporaryDirectories.push(home)
  return home
}

function configOptions(home) {
  return {
    platform: process.platform,
    home,
    env: {
      ...Bun.env,
      HOME: home,
      APPDATA: join(home, "AppData", "Roaming"),
      XDG_CONFIG_HOME: join(home, ".config"),
    },
  }
}

async function runCli(args, home) {
  const process = Bun.spawn(["bun", "run", "src/cli.js", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: configOptions(home).env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [output, error, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { output, error, exitCode }
}
