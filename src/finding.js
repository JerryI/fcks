import { lstat, opendir } from "node:fs/promises"
import { dirname, join, posix, relative, sep } from "node:path"

import { minimatch } from "minimatch"

import { DavClient } from "./dav.js"
import { syncFolder } from "./sync.js"
import { assertWithinLocalRoot } from "./target.js"

/** Recursively find the union of local and remote entries matching glob patterns. */
export async function findEntries(target, patterns, config, dependencies = {}) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error("The find command requires at least one pattern.")
  }

  const scope = await assertWithinLocalRoot(target.path, config.localFolder)
  const dav = dependencies.dav ?? DavClient.fromConfig(config)
  const useTui = dependencies.useTui ?? (
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    dependencies.output === undefined
  )
  if (useTui) {
    const renderFinding = dependencies.renderFinding ?? (await import("./finding-tui.js")).runFindingTui
    const synchronize = dependencies.synchronize ?? ((syncTarget) => syncFolder(syncTarget, config, { dav }))
    const openLocal = dependencies.openLocal ?? openInFileManager
    const openShell = dependencies.openShell ?? openShellAt
    let entries = []
    while (true) {
      const action = await renderFinding({
        path: scope.target,
        patterns,
        buildEntries: async (progress, signal) => {
          entries = await buildFindResults(scope, patterns, dav, progress, signal)
          return entries
        },
      })
      if (!action || typeof action !== "object") return entries
      if (action.type === "error") throw action.error

      const selected = entries.find((entry) => entry.path === action.path)
      if (!selected) throw new Error("The finder selected an unknown entry.")
      const selectedPath = localPath(scope.target, selected.path)
      if (action.type === "sync" && ["push", "pull", "merge"].includes(action.command)) {
        const result = await synchronize({ path: selectedPath, command: action.command, force: false })
        if (result?.interrupted) return entries
      } else if (action.type === "open" && selected.localType) {
        await openLocal(selectedPath, selected.localType === "directory")
      } else if (action.type === "shell" && selected.localType) {
        const directory = selected.localType === "directory" ? selectedPath : dirname(selectedPath)
        await openShell(directory)
      }
    }
  }

  const entries = await buildFindResults(scope, patterns, dav)

  const output = dependencies.output ?? console
  printFindResults(entries, scope, patterns, output)
  return entries
}

export async function buildFindResults(scope, patterns, dav, progress = new NullProgress(), signal) {
  throwIfAborted(signal)
  progress.update("Scanning local entries", 0, null)
  const local = await scanLocalEntries(scope, (count) => progress.update("Scanning local entries", count, null), signal)
  progress.finish("Scanning local entries", local.size, local.size)

  progress.update("Reading remote entries", 0, null)
  const remote = await scanRemoteEntries(dav, scope.relativePath, (current, total) => {
    progress.update("Reading remote entries", current, total)
  }, signal)
  progress.finish("Reading remote entries", remote.size, remote.size)

  const normalizedPatterns = patterns.map(normalizePattern)
  const paths = new Set([...local.keys(), ...remote.keys()])
  const matches = []
  let matched = 0
  progress.update("Matching patterns", 0, paths.size)
  for (const path of paths) {
    throwIfAborted(signal)
    if (normalizedPatterns.some((pattern) => matchesPattern(path, pattern))) matches.push(path)
    progress.update("Matching patterns", ++matched, paths.size)
  }
  progress.finish("Matching patterns", paths.size, paths.size)
  return matches
    .sort((left, right) => left.localeCompare(right))
    .map((path) => mergeEntry(path, local.get(path), remote.get(path)))
}

function printFindResults(entries, scope, patterns, output) {
  output.log(`Finding ${patterns.map((pattern) => JSON.stringify(pattern)).join(" OR ")} in ${scope.target}`)
  if (entries.length === 0) {
    output.log("No matching local or remote entries.")
    return
  }
  output.log(`${"SOURCE".padEnd(8)} ${"TYPE".padEnd(18)} PATH`)
  for (const entry of entries) {
    output.log(`${entry.source.padEnd(8)} ${entry.type.padEnd(18)} ${entry.displayPath}`)
  }
}

async function scanLocalEntries(scope, onEntry, signal) {
  throwIfAborted(signal)
  const entries = new Map()
  let details
  try {
    details = await lstat(scope.target)
  } catch (error) {
    if (isNotFound(error)) return entries
    throw error
  }
  if (!details.isDirectory()) throw new Error(`Find target is not a folder: ${scope.target}`)

  let count = 0
  async function visit(directory) {
    throwIfAborted(signal)
    const handle = await opendir(directory)
    for await (const entry of handle) {
      throwIfAborted(signal)
      const absolute = join(directory, entry.name)
      const path = portableRelative(scope.target, absolute)
      const type = localType(entry)
      entries.set(path, type)
      onEntry?.(++count)
      if (entry.isDirectory()) await visit(absolute)
    }
  }
  await visit(scope.target)
  return entries
}

async function scanRemoteEntries(dav, scopePath, onEntry, signal) {
  throwIfAborted(signal)
  const entries = new Map()
  let target
  try {
    target = await dav.stat(scopePath || "/", signal)
  } catch (error) {
    if (isNotFound(error)) return entries
    throw error
  }
  if (target.type !== "directory") throw new Error(`Find target is not a folder: ${scopePath || "."}`)

  let contents
  try {
    contents = await dav.list(scopePath || "/", true, signal)
  } catch (error) {
    if (isNotFound(error)) return entries
    throw error
  }
  const remoteRoot = normalizeRemotePath(dav.resolvePath(scopePath || "/"))
  for (let index = 0; index < contents.length; index += 1) {
    throwIfAborted(signal)
    const entry = contents[index]
    const filename = normalizeRemotePath(entry.filename)
    const path = relativeRemotePath(remoteRoot, filename)
    if (path === null || path === "") continue
    if (!path || path.split("/").includes("..")) {
      throw new Error(`DAV server returned an unsafe path: ${entry.filename}`)
    }
    entries.set(path, entry.type)
    onEntry?.(index + 1, contents.length)
  }
  for (const [path, type] of [...entries]) {
    if (type === "directory") continue
    let parent = posix.dirname(path)
    while (parent !== ".") {
      if (!entries.has(parent)) entries.set(parent, "directory")
      parent = posix.dirname(parent)
    }
  }
  return entries
}

export async function openInFileManager(path, isDirectory) {
  let command
  if (process.platform === "darwin") command = isDirectory ? ["open", path] : ["open", "-R", path]
  else if (process.platform === "win32") command = isDirectory
    ? ["explorer.exe", path]
    : ["explorer.exe", "/select,", path]
  else command = ["xdg-open", isDirectory ? path : dirname(path)]
  await runExternal(command, undefined, false)
}

export async function openShellAt(directory) {
  const shell = process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : process.env.SHELL ?? "/bin/sh"
  await runExternal([shell], directory, true)
}

async function runExternal(command, cwd, interactive) {
  const child = Bun.spawn(command, {
    cwd,
    stdin: interactive ? "inherit" : "ignore",
    stdout: interactive ? "inherit" : "ignore",
    stderr: interactive ? "inherit" : "ignore",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`${command[0]} exited with status ${exitCode}.`)
}

function relativeRemotePath(root, filename) {
  if (root === "/") return filename.replace(/^\/+/, "")
  if (filename === root) return ""
  if (filename.startsWith(`${root}/`)) return filename.slice(root.length + 1)
  return null
}

function matchesPattern(path, pattern) {
  const candidate = pattern.includes("/") ? path : posix.basename(path)
  return minimatch(candidate, pattern, {
    dot: true,
    nocase: process.platform === "win32",
    nonegate: true,
  })
}

function normalizePattern(pattern) {
  let normalized = String(pattern)
  if (process.platform === "win32") normalized = normalized.replaceAll("\\", "/")
  while (normalized.startsWith("./")) normalized = normalized.slice(2)
  return normalized.replace(/\/+$/, "")
}

function mergeEntry(path, localType, remoteType) {
  const type = localType && remoteType && localType !== remoteType
    ? `${localType}/${remoteType}`
    : localType ?? remoteType
  return {
    path,
    source: localType && remoteType ? "both" : localType ? "local" : "remote",
    type,
    localType: localType ?? null,
    remoteType: remoteType ?? null,
    displayPath: type === "directory" ? `${path}/` : path,
  }
}

function portableRelative(parent, child) {
  return relative(parent, child).split(sep).filter(Boolean).join("/")
}

function localPath(root, path) {
  return path ? join(root, ...path.split("/")) : root
}

function localType(entry) {
  if (entry.isDirectory()) return "directory"
  if (entry.isFile()) return "file"
  if (entry.isSymbolicLink()) return "symlink"
  return "other"
}

function normalizeRemotePath(path) {
  const normalized = String(path).replace(/\/+$/, "") || "/"
  if (normalized.split("/").includes("..")) {
    throw new Error(`DAV server returned an unsafe path: ${path}`)
  }
  return normalized
}

function isNotFound(error) {
  return error && typeof error === "object" && (
    error.code === "ENOENT" || error.status === 404 || error.statusCode === 404
  )
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const error = new Error("Search interrupted")
  error.name = "AbortError"
  throw error
}

class NullProgress {
  update() {}
  finish() {}
}
