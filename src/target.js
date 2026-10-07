import { realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

export async function resolveSyncTarget(input, cwd = process.cwd(), options = {}) {
  const absolutePath = resolve(cwd, input)
  try {
    const details = await stat(absolutePath)

    return {
      path: details.isDirectory() ? absolutePath : dirname(absolutePath),
    }
  } catch (error) {
    if (options.allowMissing && error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { path: absolutePath }
    }
    throw error
  }
}

/**
 * Ensure a requested sync target is the configured root or one of its
 * descendants. Existing symlinks are resolved so they cannot escape it.
 */
export async function assertWithinLocalRoot(target, configuredRoot) {
  if (!configuredRoot) throw new Error("No local root is configured. Run fcks --config first.")

  const root = resolve(configuredRoot)
  const requested = resolve(target)
  if (!isWithin(root, requested)) {
    throw new Error(`Target must be inside the configured local root: ${root}`)
  }

  const realRoot = await realpath(root)
  let existing = requested
  while (true) {
    try {
      existing = await realpath(existing)
      break
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      existing = parent
    }
  }

  if (!isWithin(realRoot, existing)) {
    throw new Error(`Target resolves outside the configured local root: ${realRoot}`)
  }

  return { root, target: requested, relativePath: toPortableRelative(root, requested) }
}

function isWithin(parent, child) {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function toPortableRelative(parent, child) {
  return relative(parent, child).split(sep).filter(Boolean).join("/")
}

export async function resolveConfiguredLocalFolder(input, cwd = process.cwd(), home = homedir()) {
  let path = input.trim()
  if (
    path.length >= 2 &&
    ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'")))
  ) {
    path = path.slice(1, -1)
  }
  if (path === "~") path = home
  else if (path.startsWith("~/") || path.startsWith("~\\")) path = resolve(home, path.slice(2))

  if (!path) throw new Error("Local folder is required")
  const absolutePath = resolve(cwd, path)
  const details = await stat(absolutePath)
  if (!details.isDirectory()) throw new Error("Local path must be a folder")
  return absolutePath
}
