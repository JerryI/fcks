#!/usr/bin/env bun

import { getConfigPath, loadConfig, resetConfig } from "./config.js"
import { listFolder } from "./listing.js"
import { syncFolder } from "./sync.js"
import { resolveSyncTarget } from "./target.js"

export async function main(args = Bun.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--config") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("fcks --config needs an interactive terminal.")
      return 1
    }

    const { runConfigTui } = await import("./config-tui.js")
    const configured = await runConfigTui(await loadConfig())
    if (configured) {
      console.log(`Connected to ${configured.serverUrl}`)
      console.log(`Local folder: ${configured.localFolder}`)
      console.log(`Remote root: ${configured.rootFolder}`)
      console.log(`Configuration: ${getConfigPath()}`)
    } else {
      console.log("Configuration cancelled; nothing was changed.")
    }
    return 0
  }

  if (args.length === 1 && args[0] === "--reset") {
    const removedDirectory = await resetConfig()
    console.log(`Reset complete. Removed: ${removedDirectory}`)
    return 0
  }

  if (args.length === 0 || args[0] === "-" || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    await printHelp()
    return 0
  }

  let invocation
  try {
    invocation = parseInvocation(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  const config = await loadConfig()
  if (!config) {
    console.error("fcks is not configured. Run fcks --config first.")
    return 1
  }

  try {
    const allowMissing = ["pull", "merge", "scaffold", "ls"].includes(invocation.command)
    const resolved = await resolveSyncTarget(invocation.path, process.cwd(), { allowMissing })
    if (invocation.command === "ls") await listFolder(resolved, config)
    else {
      const result = await syncFolder({ ...resolved, command: invocation.command, force: invocation.force }, config)
      if (result?.interrupted) return 130
    }
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

export function parseInvocation(args) {
  const commands = new Set(["push", "pull", "merge", "scaffold", "free", "ls"])
  const aliases = new Map([
    ["ph", "push"],
    ["pl", "pull"],
    ["sc", "scaffold"],
    ["fr", "free"],
  ])
  let command = "merge"
  let rest = [...args]
  if (commands.has(rest[0])) command = rest.shift()
  else if (aliases.has(rest[0])) command = aliases.get(rest.shift())

  let force = false
  if (rest[0] === "-f") {
    force = true
    rest.shift()
  }
  if (rest.some((argument) => argument.startsWith("-")) || rest.length > 1) {
    throw new Error("Expected one local folder or file path, with a single -f before it. Run fcks --help for usage.")
  }
  return { command, force, path: rest[0] ?? "." }
}

async function printHelp() {
  const config = await loadConfig()
  console.log(`fcks · DAV file sync\n
Commands:
  fcks --config       Configure local folder, DAV connection, and remote root
  fcks --reset        Delete all saved fcks app data and configuration
  fcks [path]         Merge local and remote; the newer changed file wins
  fcks merge [path]   Merge without deleting files on either side
  fcks push [path]    Make remote files match local files
  fcks pull [path]    Make local files match remote files
  fcks scaffold [path] Recreate the remote folder structure locally
  fcks free [path]    Remove local files but preserve their folders
  fcks ls [path]      List local, remote-only, and shared folder entries
  Aliases: ph=push, pl=pull, sc=scaffold, fr=free
  fcks <command> -f   Approve all changes without prompting
  fcks --help         Show this help

Paths default to the current directory and must be inside the configured local
folder. Hidden files and folders are included; empty folders are not synced.

DAV server:  ${config?.serverUrl ?? "not configured"}
Local folder: ${config?.localFolder || "not configured"}
Remote root: ${config?.rootFolder ?? "not configured"}
Config file: ${getConfigPath()}`)
}

if (import.meta.main) {
  process.exitCode = await main()
}
