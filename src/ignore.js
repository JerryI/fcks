import { readFile } from "node:fs/promises"
import { posix } from "node:path"

import { Minimatch } from "minimatch"

const IGNORE_FILENAME = ".fcksignore"

/**
 * Apply the ignore files selected from the local and remote trees. Ignore
 * files themselves always remain visible so the regular planner can sync or
 * remove them like any other file.
 */
export async function applyIgnoreFiles({ local, remote, dav, signal }) {
  const ignorePaths = new Set()
  for (const path of local.files.keys()) if (isIgnoreFile(path)) ignorePaths.add(path)
  for (const path of remote.files.keys()) if (isIgnoreFile(path)) ignorePaths.add(path)

  const ruleSets = []
  // Read ignore files sequentially so a tree containing many of them cannot
  // turn planning into an unbounded burst of DAV requests.
  for (const path of [...ignorePaths].sort()) {
    throwIfAborted(signal)
    const localFile = local.files.get(path)
    const remoteFile = remote.files.get(path)
    // Local wins an exact timestamp tie. The sync planner will still report a
    // content conflict if the two same-time ignore files differ.
    const useLocal = localFile && (!remoteFile || localFile.mtimeMs >= remoteFile.mtimeMs)
    const contents = useLocal
      ? await readFile(localFile.absolute, "utf8")
      : await dav.getText(path, signal)
    ruleSets.push(compileIgnoreFile(path, contents))
  }

  ruleSets.sort((left, right) => depth(left.base) - depth(right.base) || left.path.localeCompare(right.path))
  return {
    local: filterTree(local, ruleSets),
    remote: filterTree(remote, ruleSets),
  }
}

function compileIgnoreFile(path, contents) {
  const base = posix.dirname(path) === "." ? "" : posix.dirname(path)
  const rules = []
  for (const sourceLine of String(contents).split(/\r?\n/)) {
    let line = sourceLine.trim()
    if (!line || line.startsWith("#")) continue

    if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1)
    let negated = false
    if (line.startsWith("!")) {
      negated = true
      line = line.slice(1)
    }
    if (!line) continue

    const anchored = line.startsWith("/")
    const directoryOnly = line.endsWith("/")
    if (directoryOnly) line = line.replace(/\/+$/, "")
    line = line.replace(/^\/+/, "")
    if (!line) continue

    rules.push({
      negated,
      directoryOnly,
      matcher: new Minimatch(line, {
        dot: true,
        matchBase: !anchored && !line.includes("/"),
        nocomment: true,
        nonegate: true,
      }),
    })
  }
  return { path, base, rules }
}

function filterTree(tree, ruleSets) {
  const files = new Map([...tree.files].filter(([path]) => !isIgnored(path, false, ruleSets)))
  const dirs = new Set([...tree.dirs].filter((path) => !isIgnored(path, true, ruleSets)))
  return { ...tree, files, dirs }
}

function isIgnored(path, directory, ruleSets) {
  if (isIgnoreFile(path)) return false
  let ignored = false
  for (const ruleSet of ruleSets) {
    const relative = relativeToBase(path, ruleSet.base)
    if (relative === null) continue
    const candidates = pathCandidates(relative, directory)
    for (const rule of ruleSet.rules) {
      const matches = candidates.some((candidate) => (
        (!rule.directoryOnly || candidate.directory) && rule.matcher.match(candidate.path)
      ))
      if (matches) ignored = !rule.negated
    }
  }
  return ignored
}

function pathCandidates(path, directory) {
  const segments = path.split("/")
  const candidates = []
  for (let length = 1; length <= segments.length; length += 1) {
    candidates.push({
      path: segments.slice(0, length).join("/"),
      directory: length < segments.length || directory,
    })
  }
  return candidates
}

function relativeToBase(path, base) {
  if (!base) return path
  if (!path.startsWith(`${base}/`)) return null
  return path.slice(base.length + 1)
}

function isIgnoreFile(path) {
  return posix.basename(path) === IGNORE_FILENAME
}

function depth(path) {
  return path ? path.split("/").length : 0
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const error = new Error("Operation interrupted")
  error.name = "AbortError"
  throw error
}
