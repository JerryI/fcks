import { opendir } from "node:fs/promises"
import { posix } from "node:path"

import { DavClient } from "./dav.js"
import { assertWithinLocalRoot } from "./target.js"

const sourceColors = {
  both: "\x1b[1;32m",
  local: "\x1b[1;36m",
  remote: "\x1b[1;35m",
}
const resetColor = "\x1b[0m"

/** List the immediate union of local and remote directory entries. */
export async function listFolder(target, config, dependencies = {}) {
  const scope = await assertWithinLocalRoot(target.path, config.localFolder)
  const dav = dependencies.dav ?? DavClient.fromConfig(config)
  const [local, remote] = await Promise.all([
    readLocalDirectory(scope.target),
    readRemoteDirectory(dav, scope.relativePath),
  ])
  const entries = mergeEntries(local, remote)
  const output = dependencies.output ?? console
  const useColor = dependencies.color ?? supportsColor()

  output.log(`Listing ${scope.target}`)
  if (entries.length === 0) {
    output.log("No local or remote entries.")
    return entries
  }

  const nameWidth = Math.min(60, Math.max(4, ...entries.map((entry) => displayName(entry).length)))
  output.log(`${"SOURCE".padEnd(8)} ${"TYPE".padEnd(18)} NAME`)
  for (const entry of entries) {
    output.log(`${displaySource(entry.source, useColor)} ${entry.type.padEnd(18)} ${displayName(entry).padEnd(nameWidth)}`)
  }
  return entries
}

function displaySource(source, useColor) {
  const label = source.padEnd(8)
  return useColor ? `${sourceColors[source]}${label}${resetColor}` : label
}

function supportsColor() {
  if ("NO_COLOR" in process.env || process.env.FORCE_COLOR === "0") return false
  return Boolean(process.stdout.isTTY || process.env.FORCE_COLOR)
}

async function readLocalDirectory(path) {
  const entries = new Map()
  let directory
  try {
    directory = await opendir(path)
  } catch (error) {
    if (isNotFound(error)) return entries
    throw error
  }
  for await (const entry of directory) entries.set(entry.name, localType(entry))
  return entries
}

async function readRemoteDirectory(dav, scopePath) {
  const entries = new Map()
  let contents
  try {
    contents = await dav.list(scopePath || "/", false)
  } catch (error) {
    if (isNotFound(error)) return entries
    throw error
  }

  const requested = normalizeRemotePath(dav.resolvePath(scopePath || "/"))
  for (const entry of contents) {
    const filename = normalizeRemotePath(entry.filename)
    if (filename === requested || posix.dirname(filename) !== requested) continue
    const name = entry.basename || posix.basename(filename)
    if (!name || name === "." || name === "..") continue
    entries.set(name, entry.type)
  }
  return entries
}

function mergeEntries(local, remote) {
  const names = new Set([...local.keys(), ...remote.keys()])
  return [...names].sort((left, right) => left.localeCompare(right)).map((name) => {
    const localType = local.get(name)
    const remoteType = remote.get(name)
    return {
      name,
      source: localType && remoteType ? "both" : localType ? "local" : "remote",
      type: localType && remoteType && localType !== remoteType
        ? `${localType}/${remoteType}`
        : localType ?? remoteType,
      localType: localType ?? null,
      remoteType: remoteType ?? null,
    }
  })
}

function localType(entry) {
  if (entry.isDirectory()) return "directory"
  if (entry.isFile()) return "file"
  if (entry.isSymbolicLink()) return "symlink"
  return "other"
}

function displayName(entry) {
  const escaped = entry.name.replace(/[\u0000-\u001f\u007f]/g, (character) => {
    return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`
  })
  return entry.type === "directory" ? `${escaped}/` : escaped
}

function normalizeRemotePath(path) {
  const normalized = String(path).replace(/\/+$/, "") || "/"
  const segments = normalized.split("/")
  if (segments.includes("..")) throw new Error(`DAV server returned an unsafe path: ${path}`)
  return normalized
}

function isNotFound(error) {
  return error && typeof error === "object" && (
    error.code === "ENOENT" || error.status === 404 || error.statusCode === 404
  )
}
