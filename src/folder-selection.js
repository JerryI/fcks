import { mkdir, opendir } from "node:fs/promises"
import { join, posix } from "node:path"

import { DavClient } from "./dav.js"
import { assertWithinLocalRoot } from "./target.js"

/** Select one immediate child folder for a push or pull operation. */
export async function selectSyncChild(target, config, dependencies = {}) {
  if (target.command !== "push" && target.command !== "pull") {
    throw new Error("Folder selection is only available for push and pull commands.")
  }
  if (!dependencies.choose && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("Folder selection needs an interactive terminal.")
  }

  const scope = await assertWithinLocalRoot(target.path, config.localFolder)
  let folders
  if (target.command === "pull") {
    const dav = dependencies.dav ?? DavClient.fromConfig(config)
    folders = await readRemoteChildFolders(dav, scope.relativePath)
  } else {
    folders = await readLocalChildFolders(scope.target)
  }

  if (folders.length === 0) {
    throw new Error(`No ${target.command === "pull" ? "remote" : "local"} folders found in the selected path.`)
  }

  const choose = dependencies.choose ?? (await import("./folder-selector-tui.js")).runFolderSelector
  const selected = await choose({
    command: target.command,
    path: scope.target,
    folders,
  })
  if (selected === null || selected === undefined) return null
  if (!folders.includes(selected)) throw new Error("The folder selector returned an unknown folder.")

  const selectedPath = join(scope.target, selected)
  if (target.command === "pull") {
    await (dependencies.mkdir ?? mkdir)(selectedPath, { recursive: true })
  }
  return selectedPath
}

export async function readLocalChildFolders(path) {
  const directory = await opendir(path)
  const folders = []
  for await (const entry of directory) {
    if (entry.isDirectory()) folders.push(entry.name)
  }
  return folders.sort((left, right) => left.localeCompare(right))
}

export async function readRemoteChildFolders(dav, path) {
  const requested = normalizeRemotePath(dav.resolvePath(path || "/"))
  const entries = await dav.list(path || "/", false)
  const folders = new Set()
  for (const entry of entries) {
    if (entry.type !== "directory") continue
    const filename = normalizeRemotePath(entry.filename)
    if (filename === requested || posix.dirname(filename) !== requested) continue
    const name = posix.basename(filename)
    if (name && name !== "." && name !== "..") folders.add(name)
  }
  return [...folders].sort((left, right) => left.localeCompare(right))
}

function normalizeRemotePath(path) {
  const normalized = String(path).replace(/\/+$/, "") || "/"
  if (normalized.split("/").includes("..")) {
    throw new Error(`DAV server returned an unsafe path: ${path}`)
  }
  return normalized
}
