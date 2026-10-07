import { opendir } from "node:fs/promises"
import { lstat, mkdir, rm, stat, utimes } from "node:fs/promises"
import { dirname, join, posix, relative, sep } from "node:path"
import { createInterface } from "node:readline/promises"

import { DavClient } from "./dav.js"
import { formatPlanSizeEstimate } from "./plan-size.js"
import { assertWithinLocalRoot } from "./target.js"

const TRANSFER_CONCURRENCY = 3
const HASH_CONCURRENCY = 4
const MUTATION_CONCURRENCY = 4

/** Plan, display, confirm, and execute a sync operation. */
export async function syncFolder(target, config, dependencies = {}) {
  if (!config.localFolder) {
    // Never infer a root for old configurations: that could map files to
    // surprising remote paths. Re-running --config upgrades the config.
    console.log(`Local folder: ${target.path}`)
    console.log(`Force mode:   ${target.force === true ? "yes" : "no"}`)
    console.log("No local root is configured; run fcks --config before syncing.")
    return { command: target.command ?? "merge", actions: [], skipped: true }
  }

  const abortController = dependencies.abortController ?? new AbortController()
  const onInterrupt = () => abortController.abort()
  process.once("SIGINT", onInterrupt)
  try {
    return await syncFolderOperation(target, config, dependencies, abortController)
  } catch (error) {
    if (!isAbortError(error)) throw error
    const completed = error.completedOperations ?? 0
    const message = completed > 0
      ? `Interrupted after ${completed} completed operation${completed === 1 ? "" : "s"}; completed changes were kept.`
      : "Interrupted; no operations were completed."
    ;(dependencies.output ?? console).log(message)
    return { command: target.command ?? "merge", actions: [], interrupted: true, completed }
  } finally {
    process.removeListener("SIGINT", onInterrupt)
  }
}

async function syncFolderOperation(target, config, dependencies, abortController) {
  const signal = abortController.signal
  const scope = await assertWithinLocalRoot(target.path, config.localFolder)
  const dav = dependencies.dav ?? DavClient.fromConfig(config)

  const useTui = dependencies.useTui ?? (
    target.force !== true &&
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    dependencies.confirm === undefined &&
    dependencies.output === undefined &&
    dependencies.progress === undefined
  )
  if (useTui) {
    const { runSyncTui } = await import("./sync-tui.js")
    const result = await runSyncTui({
      command: target.command ?? "merge",
      scope,
      interrupt: () => abortController.abort(),
      buildPlan: (progress) => buildSyncPlan({ command: target.command ?? "merge", scope, dav, progress, signal }),
      executePlan: (plan, progress) => executeSyncPlan(plan, { dav, progress, signal }),
    })
    if (result.status === "error") throw result.error
    if (result.status === "interrupted") {
      const completed = result.completed ?? 0
      console.log(completed > 0
        ? `Interrupted after ${completed} completed operation${completed === 1 ? "" : "s"}; completed changes were kept.`
        : "Interrupted; no operations were completed.")
      return { ...(result.plan ?? { command: target.command ?? "merge", actions: [] }), interrupted: true, completed }
    }
    if (result.status === "cancelled") {
      console.log("Cancelled; no files were changed.")
      return { ...(result.plan ?? { command: target.command ?? "merge", actions: [] }), cancelled: true }
    }
    if (result.status === "unchanged") {
      if (result.plan?.actions.some((item) => item.type === "conflict")) {
        console.log("No operations were applied; conflicts were left unchanged.")
      } else {
        console.log("Already up to date; no changes were needed.")
      }
    } else {
      console.log(`Completed ${result.completed} operation${result.completed === 1 ? "" : "s"}.`)
    }
    return result.plan
  }

  const progress = dependencies.progress ?? new TerminalProgress()
  const plan = await buildSyncPlan({ command: target.command ?? "merge", scope, dav, progress, signal })

  printSyncPlan(plan, dependencies.output ?? console)
  const actionable = plan.actions.filter((item) => item.type !== "conflict")
  if (actionable.length === 0) return plan

  const confirmed = target.force === true || await (dependencies.confirm ?? confirmSync)(plan, signal)
  if (!confirmed) {
    ;(dependencies.output ?? console).log("Cancelled; no files were changed.")
    return { ...plan, cancelled: true }
  }

  await executeSyncPlan(plan, { dav, progress, signal })
  ringTerminalBell()
  ;(dependencies.output ?? console).log(`Completed ${actionable.length} operation${actionable.length === 1 ? "" : "s"}.`)
  return plan
}

export async function buildSyncPlan({ command, scope, dav, progress = new NullProgress(), signal }) {
  if (!["push", "pull", "merge", "scaffold", "free"].includes(command)) {
    throw new Error(`Unknown sync command: ${command}`)
  }

  progress.update("Scanning local files", 0, null)
  throwIfAborted(signal)
  const local = await scanLocalTree(scope.root, scope.target, (count) => progress.update("Scanning local files", count, null), signal)
  progress.finish("Scanning local files", local.files.size)

  if (command === "free") {
    return {
      command,
      scope,
      local,
      remote: { files: new Map(), dirs: new Set() },
      actions: [...local.files.keys()].sort().map((path) => action("remove-local", path, local.files.get(path))),
      remoteFileCount: 0,
    }
  }

  progress.update("Reading remote files", 0, null)
  throwIfAborted(signal)
  const remote = await scanRemoteTree(dav, scope.relativePath, signal)
  progress.finish("Reading remote files", remote.files.size)

  if (command === "scaffold") {
    const dirs = impliedDirectories(remote.files.keys(), scope.relativePath)
    const actions = []
    const blocked = []
    if (!local.exists) actions.push(action("create-local-directory", scope.relativePath))
    for (const path of dirs) {
      if (blocked.some((parent) => isSameOrChild(path, parent))) continue
      if (local.files.has(path)) {
        actions.push(action("conflict", path, local.files.get(path), null, "local file blocks creation of this remote folder"))
        blocked.push(path)
      } else if (!local.dirs.has(path)) {
        actions.push(action("create-local-directory", path))
      }
    }
    return { command, scope, local, remote, actions, remoteFileCount: remote.files.size }
  }

  const common = [...local.files.keys()].filter((path) => remote.files.has(path)).sort()
  const comparisonWork = new Map(common.map((path) => [path, Math.max(1, local.files.get(path).size)]))
  const comparisonObserved = new Map()
  const totalComparisonBytes = [...comparisonWork.values()].reduce((total, size) => total + size, 0)
  let comparedBytes = 0
  progress.update("Comparing content", comparedBytes, totalComparisonBytes, { unit: "bytes" })
  const equality = new Map(await parallelMap(common, HASH_CONCURRENCY, async (path) => {
    const updateComparison = (current) => {
      const next = Math.min(comparisonWork.get(path), Math.max(0, current))
      const previous = comparisonObserved.get(path) ?? 0
      if (next <= previous) return
      comparisonObserved.set(path, next)
      comparedBytes += next - previous
      progress.update("Comparing content", comparedBytes, totalComparisonBytes, { unit: "bytes" })
    }
    const same = await filesMatch(local.files.get(path), remote.files.get(path), dav, path, updateComparison, signal)
    updateComparison(comparisonWork.get(path))
    return [path, same]
  }, signal))
  progress.finish("Comparing content", totalComparisonBytes, totalComparisonBytes, { unit: "bytes" })

  const localOnly = [...local.files.keys()].filter((path) => !remote.files.has(path)).sort()
  const remoteOnly = [...remote.files.keys()].filter((path) => !local.files.has(path)).sort()
  const changed = common.filter((path) => equality.get(path) === false)
  const actions = []

  if (command === "push") {
    const conflictingRemoteDirs = [...remote.dirs].filter((path) => local.files.has(path)).sort(byDepthDescending)
    for (const path of remoteOnly) {
      if (!conflictingRemoteDirs.some((dir) => isSameOrChild(path, dir))) actions.push(action("remove-remote", path, remote.files.get(path)))
    }
    for (const path of conflictingRemoteDirs) actions.push(action("remove-remote-directory", path))
    for (const path of localOnly) actions.push(action("upload-add", path, local.files.get(path)))
    for (const path of changed) actions.push(action("upload-update", path, local.files.get(path), remote.files.get(path)))
  } else if (command === "pull") {
    const conflictingLocalDirs = [...local.dirs].filter((path) => remote.files.has(path)).sort(byDepthDescending)
    for (const path of localOnly) {
      if (!conflictingLocalDirs.some((dir) => isSameOrChild(path, dir))) actions.push(action("remove-local", path, local.files.get(path)))
    }
    for (const path of conflictingLocalDirs) actions.push(action("remove-local-directory", path))
    for (const path of remoteOnly) actions.push(action("download-add", path, remote.files.get(path)))
    for (const path of changed) actions.push(action("download-update", path, remote.files.get(path), local.files.get(path)))
  } else {
    const shapeConflicts = new Map()
    for (const path of localOnly) {
      if ([...remote.dirs].some((dir) => dir === path || isSameOrChild(dir, path))) {
        shapeConflicts.set(path, action("conflict", path, local.files.get(path), null, "local file conflicts with a remote directory"))
      }
    }
    for (const path of remoteOnly) {
      if ([...local.dirs].some((dir) => dir === path || isSameOrChild(dir, path))) {
        shapeConflicts.set(path, action("conflict", path, remote.files.get(path), null, "remote file conflicts with a local directory"))
      }
    }
    const conflictRoots = [...shapeConflicts.keys()]
    actions.push(...[...shapeConflicts.values()].sort((left, right) => left.path.localeCompare(right.path)))
    for (const path of localOnly) {
      if (!conflictRoots.some((root) => isSameOrChild(path, root))) {
        actions.push(action("upload-add", path, local.files.get(path)))
      }
    }
    for (const path of remoteOnly) {
      if (!conflictRoots.some((root) => isSameOrChild(path, root))) {
        actions.push(action("download-add", path, remote.files.get(path)))
      }
    }
    for (const path of changed) {
      const localFile = local.files.get(path)
      const remoteFile = remote.files.get(path)
      if (localFile.mtimeMs > remoteFile.mtimeMs) actions.push(action("upload-update", path, localFile, remoteFile, "local file is newer"))
      else if (remoteFile.mtimeMs > localFile.mtimeMs) actions.push(action("download-update", path, remoteFile, localFile, "remote file is newer"))
      else actions.push(action("conflict", path, localFile, remoteFile, "different content has the same modification time"))
    }
  }

  return { command, scope, local, remote, actions, remoteFileCount: remote.files.size }
}

export async function executeSyncPlan(plan, { dav, progress = new NullProgress(), signal }) {
  let completedOperations = 0
  try {
    await executeSyncPlanActions(plan, { dav, progress, signal }, () => {
      completedOperations += 1
    })
    return { completed: completedOperations }
  } catch (error) {
    if (error && typeof error === "object") error.completedOperations = completedOperations
    throw error
  }
}

async function executeSyncPlanActions(plan, { dav, progress, signal }, operationCompleted) {
  throwIfAborted(signal)
  const executable = plan.actions.filter((item) => item.type !== "conflict")
  const removalTypes = new Set(["remove-local", "remove-local-directory", "remove-remote", "remove-remote-directory"])
  const removals = executable.filter((item) => removalTypes.has(item.type))
  const directories = executable.filter((item) => item.type === "create-local-directory")
  const transfers = executable.filter((item) => !removalTypes.has(item.type) && item.type !== "create-local-directory")

  // Removals happen first so file/directory shape changes cannot block writes.
  let removed = 0
  if (removals.length > 0) progress.update("Removing files", removed, removals.length)
  await parallelMap(removals, MUTATION_CONCURRENCY, async (item) => {
    await executeAction(item, plan, dav, undefined, signal)
    operationCompleted()
    progress.update("Removing files", ++removed, removals.length)
  }, signal)
  if (removals.length > 0) progress.finish("Removing files", removals.length, removals.length)

  let created = 0
  if (directories.length > 0) progress.update("Creating folders", created, directories.length)
  for (const item of directories.sort((a, b) => a.path.localeCompare(b.path))) {
    throwIfAborted(signal)
    await executeAction(item, plan, dav, undefined, signal)
    operationCompleted()
    progress.update("Creating folders", ++created, directories.length)
  }
  if (directories.length > 0) progress.finish("Creating folders", directories.length, directories.length)

  const uploadParents = new Set(transfers
    .filter((item) => item.type.startsWith("upload-"))
    .map((item) => posix.dirname(item.path))
    .filter((path) => path !== "." && !plan.remote.dirs.has(path)))
  const deepestUploadParents = [...uploadParents]
    .filter((path) => ![...uploadParents].some((other) => other !== path && other.startsWith(`${path}/`)))
    .sort()
  if (deepestUploadParents.length > 0) progress.update("Preparing folders", 0, deepestUploadParents.length)
  for (let index = 0; index < deepestUploadParents.length; index += 1) {
    throwIfAborted(signal)
    await dav.createDirectory(deepestUploadParents[index], true, signal)
    progress.update("Preparing folders", index + 1, deepestUploadParents.length)
  }
  if (deepestUploadParents.length > 0) progress.finish("Preparing folders", deepestUploadParents.length, deepestUploadParents.length)

  const work = new Map(transfers.map((item) => [item, Math.max(1, Number(item.primary?.size) || 0)]))
  const observed = new Map()
  const totalBytes = [...work.values()].reduce((total, size) => total + size, 0)
  let transferred = 0
  if (transfers.length > 0) progress.update("Transferring data", 0, totalBytes, { unit: "bytes" })
  await parallelMap(transfers, TRANSFER_CONCURRENCY, async (item) => {
    const updateTransfer = (current) => {
      const next = Math.min(work.get(item), Math.max(0, current))
      const previous = observed.get(item) ?? 0
      if (next <= previous) return
      observed.set(item, next)
      transferred += next - previous
      progress.update("Transferring data", transferred, totalBytes, { unit: "bytes" })
    }
    await executeAction(item, plan, dav, updateTransfer, signal)
    operationCompleted()
    updateTransfer(work.get(item))
  }, signal)
  if (transfers.length > 0) progress.finish("Transferring data", totalBytes, totalBytes, { unit: "bytes" })
  progress.finish("Applying changes", executable.length, executable.length)
}

async function executeAction(item, plan, dav, onProgress, signal) {
  throwIfAborted(signal)
  const localPath = localPathFor(plan.scope.root, item.path)
  try {
    switch (item.type) {
      case "remove-local":
        await rm(localPath, { force: true })
        break
      case "remove-local-directory":
        await rm(localPath, { recursive: true, force: true })
        break
      case "remove-remote":
      case "remove-remote-directory":
        await dav.delete(item.path, signal)
        break
      case "create-local-directory":
        await mkdir(localPath, { recursive: true })
        break
      case "upload-add":
      case "upload-update":
        await dav.upload(localPath, item.path, true, onProgress, signal)
        break
      case "download-add":
      case "download-update": {
        await mkdir(dirname(localPath), { recursive: true })
        await dav.download(item.path, localPath, onProgress, signal)
        if (Number.isFinite(item.primary?.mtimeMs)) await utimes(localPath, new Date(), new Date(item.primary.mtimeMs))
        break
      }
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to ${actionDescription(item.type)} ${JSON.stringify(item.path || ".")}: ${message}`, { cause: error })
  }
}

export function printSyncPlan(plan, output = console) {
  output.log(`\n${plan.command.toUpperCase()} preview for ${plan.scope.target}`)
  if (plan.command === "free") output.log("Warning: run merge first if local changes have not been uploaded.")
  if (plan.command === "scaffold") output.log(`Remote contains ${plan.remoteFileCount} file${plan.remoteFileCount === 1 ? "" : "s"}; missing folders will be created without changing local files.`)
  if (plan.actions.length === 0) {
    output.log("Already up to date; no changes are needed.")
    return
  }
  for (const item of plan.actions) {
    output.log(`${actionMarker(item.type)} ${actionDescription(item.type).padEnd(25)} ${JSON.stringify(item.path || ".")}${item.reason ? ` — ${item.reason}` : ""}`)
  }
  const sizeEstimate = formatPlanSizeEstimate(plan)
  if (sizeEstimate) output.log(`Estimated size: ${sizeEstimate}.`)
  const conflicts = plan.actions.filter((item) => item.type === "conflict").length
  if (conflicts > 0) output.log(`${conflicts} conflict${conflicts === 1 ? " was" : "s were"} left unchanged.`)
}

export async function confirmSync(plan, signal) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Confirmation needs an interactive terminal; use -f to approve all operations.")
  const interface_ = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const warning = plan.command === "free" ? " This removes every local file in the selected folder." : ""
    const answer = (await interface_.question(`Proceed with all listed operations?${warning} (y/N) `, { signal })).trim().toLowerCase()
    return ["y", "yes", "a", "all"].includes(answer)
  } finally {
    interface_.close()
  }
}

async function scanLocalTree(root, target, onEntry, signal) {
  throwIfAborted(signal)
  const files = new Map()
  const dirs = new Set()
  let targetStat
  try {
    targetStat = await stat(target)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { files, dirs, exists: false }
    throw error
  }
  if (!targetStat.isDirectory()) throw new Error(`Sync target is not a folder: ${target}`)

  let count = 0
  async function visit(directory) {
    throwIfAborted(signal)
    const handle = await opendir(directory)
    for await (const entry of handle) {
      throwIfAborted(signal)
      const absolute = join(directory, entry.name)
      const path = portableRelative(root, absolute)
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${absolute}`)
      if (entry.isDirectory()) {
        dirs.add(path)
        onEntry?.(++count)
        await visit(absolute)
      } else if (entry.isFile()) {
        const details = await lstat(absolute)
        files.set(path, { path, absolute, size: details.size, mtimeMs: details.mtimeMs, hashes: new Map() })
        onEntry?.(++count)
      } else {
        throw new Error(`Unsupported filesystem entry: ${absolute}`)
      }
    }
  }
  await visit(target)
  return { files, dirs, exists: true }
}

async function scanRemoteTree(dav, scopePath, signal) {
  throwIfAborted(signal)
  const files = new Map()
  const dirs = new Set()
  let entries
  try {
    entries = await dav.list(scopePath || "/", true, signal)
  } catch (error) {
    if (isNotFound(error)) return { files, dirs }
    throw error
  }
  for (const entry of entries) {
    throwIfAborted(signal)
    const path = remoteRelativePath(dav.rootFolder, entry.filename)
    if (path === null || !isWithinScope(path, scopePath)) continue
    if (entry.type === "directory") {
      if (path) dirs.add(path)
    } else {
      files.set(path, { path, size: Number(entry.size) || 0, mtimeMs: validDateMilliseconds(entry.lastmod), etag: entry.etag ?? null })
    }
  }
  // Some DAV servers omit collection entries from a deep listing. Infer
  // parent directories from file paths so shape-conflict planning stays safe.
  for (const path of impliedDirectories(files.keys(), scopePath)) dirs.add(path)
  return { files, dirs }
}

async function filesMatch(local, remote, dav, path, onProgress, signal) {
  throwIfAborted(signal)
  if (local.size !== remote.size) return false
  // RFC 4918 ETags are opaque validators, even when they happen to look like
  // MD5/SHA digests. Without a sync database there is no standards-compliant
  // way to compare one with a local file, so hash both streams for correctness.
  let localBytes = 0
  let remoteBytes = 0
  // Both streams must finish, so the slower side is the useful measure of
  // comparison progress and produces a less optimistic ETA.
  const report = () => onProgress?.(Math.min(localBytes, remoteBytes))
  const [localDigest, remoteDigest] = await Promise.all([
    localHash(local, "sha256", dav, (current) => {
      localBytes = current
      report()
    }, signal),
    dav.getHash(path, "sha256", (current) => {
      remoteBytes = current
      report()
    }, signal),
  ])
  return localDigest === remoteDigest
}

async function localHash(file, algorithm, dav, onProgress, signal) {
  if (!file.hashes.has(algorithm)) file.hashes.set(algorithm, dav.hashLocalFile(file.absolute, algorithm, onProgress, signal))
  return file.hashes.get(algorithm)
}

function remoteRelativePath(rootFolder, filename) {
  const path = String(filename ?? "").replace(/\/+$/, "") || "/"
  const root = rootFolder === "/" ? "/" : rootFolder.replace(/\/+$/, "")
  let relativePath
  if (root === "/") relativePath = path.replace(/^\/+/, "")
  else if (path === root) relativePath = ""
  else if (path.startsWith(`${root}/`)) relativePath = path.slice(root.length + 1)
  else return null

  const segments = relativePath.split("/")
  if (segments.includes("..")) throw new Error(`DAV server returned a path outside the configured root: ${filename}`)
  return segments.filter((segment) => segment && segment !== ".").join("/")
}

function impliedDirectories(filePaths, scopePath) {
  const dirs = new Set()
  for (const filePath of filePaths) {
    let parent = posix.dirname(filePath)
    while (parent !== "." && parent !== scopePath && isWithinScope(parent, scopePath)) {
      dirs.add(parent)
      parent = posix.dirname(parent)
    }
  }
  return [...dirs].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
}

function localPathFor(root, path) {
  return path ? join(root, ...path.split("/")) : root
}
function portableRelative(root, child) {
  return relative(root, child).split(sep).filter(Boolean).join("/")
}
function isWithinScope(path, scope) {
  return !scope || path === scope || path.startsWith(`${scope}/`)
}
function isSameOrChild(path, parent) {
  return path === parent || path.startsWith(`${parent}/`)
}
function action(type, path, primary = null, secondary = null, reason = "") {
  return { type, path, primary, secondary, reason }
}
function actionMarker(type) {
  if (type.includes("add") || type.startsWith("create")) return "+"
  if (type.includes("remove")) return "-"
  if (type === "conflict") return "!"
  return "~"
}
function actionDescription(type) {
  return ({
    "remove-local": "remove local file",
    "remove-local-directory": "replace local directory",
    "remove-remote": "remove remote file",
    "remove-remote-directory": "replace remote directory",
    "create-local-directory": "create local directory",
    "upload-add": "add to remote",
    "upload-update": "update remote",
    "download-add": "add to local",
    "download-update": "update local",
    conflict: "leave conflict unchanged",
  })[type] ?? type
}
function validDateMilliseconds(value) {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? milliseconds : 0
}
function isNotFound(error) {
  return error && typeof error === "object" && (error.status === 404 || error.statusCode === 404)
}
function depth(path) {
  return path.split("/").length
}
function byDepthDescending(a, b) {
  return depth(b) - depth(a) || a.localeCompare(b)
}

async function parallelMap(items, concurrency, operation, signal) {
  const results = new Array(items.length)
  let next = 0
  let firstError = null
  async function worker() {
    while (true) {
      if (firstError) return
      try {
        throwIfAborted(signal)
        const index = next++
        if (index >= items.length) return
        results[index] = await operation(items[index], index)
      } catch (error) {
        firstError ??= error
        return
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  if (firstError) throw firstError
  return results
}

class NullProgress {
  update() {}
  finish() {}
}

export class TerminalProgress {
  constructor(stream = process.stderr) {
    this.stream = stream
    this.lastLength = 0
    this.lastWrite = 0
  }
  update(label, current, total, options = {}) {
    if (!this.stream.isTTY || Date.now() - this.lastWrite < 50) return
    this.lastWrite = Date.now()
    const text = this.format(label, current, total, options)
    this.stream.write(`\r${text}${" ".repeat(Math.max(0, this.lastLength - text.length))}`)
    this.lastLength = text.length
  }
  finish(label, current, total = current, options = {}) {
    const text = this.format(label, current, total, options)
    if (this.stream.isTTY) {
      this.stream.write(`\r${text}${" ".repeat(Math.max(0, this.lastLength - text.length))}\n`)
      this.lastLength = 0
    } else this.stream.write(`${text}\n`)
  }
  format(label, current, total, options = {}) {
    if (total === null) return `${label} [${formatProgressAmount(current, options.unit)}]`
    const ratio = total === 0 ? 1 : Math.min(1, current / total)
    const width = 24
    const filled = Math.round(ratio * width)
    return `${label} [${"=".repeat(filled)}${" ".repeat(width - filled)}] ${Math.round(ratio * 100)}% (${formatProgressAmount(current, options.unit)}/${formatProgressAmount(total, options.unit)})`
  }
}

function formatProgressAmount(value, unit) {
  if (unit !== "bytes") return String(value)
  const units = ["B", "KB", "MB", "GB", "TB"]
  let amount = value
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)}${units[index]}`
}

function ringTerminalBell() {
  if (process.stdout.isTTY) process.stdout.write("\x07")
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const error = new Error("Operation interrupted")
  error.name = "AbortError"
  throw error
}

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError"
}
