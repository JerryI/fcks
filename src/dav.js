import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { stat } from "node:fs/promises"
import { posix } from "node:path"
import { pipeline } from "node:stream/promises"
import { PassThrough, Readable, Transform } from "node:stream"
import { createClient } from "webdav"

import { normalizeRootFolder } from "./config.js"

export class DavClient {
  /**
   * @param {{ serverUrl: string, username?: string, password?: string, rootFolder?: string }} options
   * @param {import("webdav").WebDAVClient} [client] Optional injected client for tests.
   */
  constructor(options, client) {
    this.serverUrl = options.serverUrl.replace(/\/$/, "")
    this.rootFolder = normalizeRootFolder(options.rootFolder ?? "/")
    this.client = client ?? createClient(this.serverUrl, {
      username: options.username,
      password: options.password,
    })
  }

  /** @param {import("./config.js").AppConfig} config */
  static fromConfig(config) {
    return new DavClient(config)
  }

  resolvePath(path = "/") {
    // DAV paths always use `/`. A backslash can be a legitimate filename
    // character on POSIX, so treating it as a separator silently targets the
    // wrong remote object for names such as `draft\\final.txt`.
    const input = path
    const segments = input.split("/").filter((segment) => segment && segment !== ".")
    if (segments.some((segment) => segment === "..")) {
      throw new Error(`Remote path may not escape the configured root: ${path}`)
    }

    if (segments.length === 0) return this.rootFolder
    return posix.join(this.rootFolder, ...segments)
  }

  async list(path = "/", deep = false, signal) {
    return this.client.getDirectoryContents(this.resolvePath(path), { deep, signal })
  }

  async stat(path = "/") {
    return this.client.stat(this.resolvePath(path))
  }

  async exists(path) {
    return this.client.exists(this.resolvePath(path))
  }

  async get(path) {
    const contents = await this.client.getFileContents(this.resolvePath(path), { format: "binary" })
    return contents instanceof Uint8Array ? contents : new Uint8Array(contents)
  }

  async getText(path) {
    const contents = await this.client.getFileContents(this.resolvePath(path), { format: "text" })
    return typeof contents === "string" ? contents : new TextDecoder().decode(contents)
  }

  async put(path, contents, overwrite = true) {
    return this.client.putFileContents(this.resolvePath(path), contents, { overwrite })
  }

  createReadStream(path, signal) {
    const resolved = this.resolvePath(path)
    if (typeof this.client.customRequest === "function") {
      const output = new PassThrough()
      // Retain a listener because a consumer can detach just before the
      // underlying HTTP body reports its abort.
      output.on("error", () => {})
      void this.client.customRequest(resolved, { method: "GET", signal })
        .then((response) => {
          if (!response.body) throw new Error(`DAV response has no body: ${resolved}`)
          return pipeline(response.body, output)
        })
        .catch((error) => {
          if (!output.destroyed) output.destroy(error)
        })
      return output
    }
    if (typeof this.client.createReadStream === "function") {
      const stream = this.client.createReadStream(resolved, { signal })
      // webdav may emit a second, late AbortError after a stream consumer has
      // already detached. Keep one listener through stream disposal so that
      // duplicate event cannot become an unhandled EventEmitter error.
      signal?.addEventListener("abort", () => stream.on("error", () => {}), { once: true })
      return stream
    }
    // Small injected clients used by consumers and tests may only expose the
    // buffer API. The real webdav client always takes the streaming branch.
    const client = this.client
    return Readable.from((async function* () {
      yield await client.getFileContents(resolved, { format: "binary", signal })
    })())
  }

  /** Stream a remote file directly into place. */
  async download(path, destination, onProgress, signal) {
    let transferred = 0
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        transferred += chunk.length
        onProgress?.(transferred)
        callback(null, chunk)
      },
    })

    // Opening an existing file truncates it without changing its mode. A new
    // file receives the ordinary 0666 & umask mode. If the stream is aborted,
    // the partial file is deliberately left for the next sync to reconcile.
    await pipeline(this.createReadStream(path, signal), counter, createWriteStream(destination), { signal })
  }

  /** Stream a local file to DAV. Memory use is independent of file size. */
  async upload(source, path, overwrite = true, onProgress, signal) {
    const details = await stat(source)
    let transferred = 0
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        transferred += chunk.length
        onProgress?.(transferred)
        callback(null, chunk)
      },
    })
    const sourceStream = createReadStream(source)
    const piping = pipeline(sourceStream, counter, { signal })
    try {
      const [, uploaded] = await Promise.all([piping, this.client.putFileContents(this.resolvePath(path), counter, {
        overwrite,
        contentLength: details.size,
        signal,
      })])
      return uploaded
    } catch (error) {
      sourceStream.destroy(error)
      counter.destroy(error)
      throw error
    }
  }

  async createDirectory(path, recursive = true, signal) {
    await this.client.createDirectory(this.resolvePath(path), { recursive, signal })
  }

  async delete(path, signal) {
    await this.client.deleteFile(this.resolvePath(path), { signal })
  }

  async move(source, destination, overwrite = true) {
    await this.client.moveFile(this.resolvePath(source), this.resolvePath(destination), { overwrite })
  }

  async copy(source, destination, overwrite = true) {
    await this.client.copyFile(this.resolvePath(source), this.resolvePath(destination), { overwrite })
  }

  async quota() {
    return this.client.getQuota({ path: this.rootFolder })
  }

  async getEtag(path) {
    return (await this.stat(path)).etag
  }

  async getHash(path, algorithm = "sha256", onProgress, signal) {
    return hashStream(this.createReadStream(path, signal), algorithm, onProgress, signal)
  }

  async hashLocalFile(path, algorithm = "sha256", onProgress, signal) {
    return hashStream(createReadStream(path), algorithm, onProgress, signal)
  }
}

async function hashStream(stream, algorithm, onProgress, signal) {
  const hash = createHash(algorithm)
  let processed = 0
  const abort = () => {
    stream.on("error", () => {})
    stream.destroy(abortError())
  }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    if (signal?.aborted) {
      stream.destroy()
      throw abortError()
    }
    for await (const chunk of stream) {
      if (signal?.aborted) throw abortError()
      hash.update(chunk)
      processed += chunk.length
      onProgress?.(processed)
    }
    return hash.digest("hex")
  } finally {
    signal?.removeEventListener("abort", abort)
  }
}

function abortError() {
  const error = new Error("Operation interrupted")
  error.name = "AbortError"
  return error
}
