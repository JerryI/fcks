import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, posix, win32 } from "node:path"

/**
 * @typedef {object} AppConfig
 * @property {string} serverUrl
 * @property {string} username
 * @property {string} password
 * @property {string} localFolder
 * @property {string} rootFolder
 */

/**
 * Return the native per-user configuration location for this OS.
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, home?: string }} [options]
 */
export function getAppDataDirectory(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const platformPath = platform === "win32" ? win32 : posix

  let baseDirectory
  if (platform === "darwin") {
    baseDirectory = platformPath.join(home, "Library", "Application Support")
  } else if (platform === "win32") {
    baseDirectory = env.APPDATA ?? platformPath.join(home, "AppData", "Roaming")
  } else {
    baseDirectory = env.XDG_CONFIG_HOME ?? platformPath.join(home, ".config")
  }

  return platformPath.join(baseDirectory, "fcks")
}

export function getConfigPath(options = {}) {
  const platform = options.platform ?? process.platform
  const platformPath = platform === "win32" ? win32 : posix
  return platformPath.join(getAppDataDirectory(options), "config.json")
}

/** @returns {Promise<AppConfig | null>} */
export async function loadConfig(path = getConfigPath()) {
  try {
    return parseConfig(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

/** @param {AppConfig} config */
export async function saveConfig(config, path = getConfigPath()) {
  const validated = parseConfig(config)
  const directory = dirname(path)
  const temporaryPath = `${path}.${process.pid}.tmp`

  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}

/** Delete the complete per-user fcks app-data directory. */
export async function resetConfig(options = {}) {
  const directory = getAppDataDirectory(options)
  await rm(directory, { recursive: true, force: true })
  return directory
}

/** @param {unknown} value @returns {AppConfig} */
function parseConfig(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid fcks configuration")

  const input = value
  if (
    typeof input.serverUrl !== "string" ||
    typeof input.username !== "string" ||
    typeof input.password !== "string" ||
    (typeof input.localFolder !== "string" && typeof input.localFolder !== "undefined") ||
    typeof input.rootFolder !== "string"
  ) {
    throw new Error("Invalid fcks configuration")
  }

  const url = new URL(input.serverUrl)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("DAV server URL must use http or https")
  }

  return {
    serverUrl: url.toString().replace(/\/$/, ""),
    username: input.username,
    password: input.password,
    // Older configs did not have a local folder. The next --config run fills it.
    localFolder: input.localFolder ?? "",
    rootFolder: normalizeRootFolder(input.rootFolder),
  }
}

export function normalizeRootFolder(path) {
  const segments = path.replaceAll("\\", "/").split("/")
  const normalized = []

  for (const segment of segments) {
    if (!segment || segment === ".") continue
    if (segment === "..") normalized.pop()
    else normalized.push(segment)
  }

  return normalized.length === 0 ? "/" : `/${normalized.join("/")}`
}
