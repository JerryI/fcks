import { posix } from "node:path"
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core"

import { normalizeRootFolder, saveConfig } from "./config.js"
import { DavClient } from "./dav.js"
import { resolveConfiguredLocalFolder } from "./target.js"

const colors = {
  background: "#08111d",
  panel: "#101c2b",
  border: "#3c82f6",
  text: "#e5eefb",
  muted: "#91a4bd",
  accent: "#5eead4",
  danger: "#fb7185",
  input: "#17263a",
}

/**
 * Open the interactive local-folder, credentials, and remote-root flow.
 * @param {import("./config.js").AppConfig | null} savedConfig
 */
export async function runConfigTui(savedConfig) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    backgroundColor: colors.background,
  })
  renderer.setTerminalTitle("fcks · Fucking Sync · configuration")

  return new Promise((resolve, reject) => {
    let finished = false

    const finish = (result) => {
      if (finished) return
      finished = true
      renderer.destroy()
      resolve(result)
    }

    const fail = (error) => {
      if (finished) return
      finished = true
      renderer.destroy()
      reject(error)
    }

    showLocalFolderForm(renderer, savedConfig, finish, fail)
  })
}

function showLocalFolderForm(renderer, savedConfig, finish, fail) {
  const screen = makeScreen(renderer, "local-folder-screen")
  const panel = makePanel(renderer, "local-folder-panel")
  panel.add(new TextRenderable(renderer, { content: "fcks · Fucking Sync", fg: colors.accent }))
  panel.add(new TextRenderable(renderer, { content: "1/3  Local folder", fg: colors.text }))
  panel.add(new TextRenderable(renderer, {
    content: "Choose the local folder that will map to the remote root.",
    fg: colors.muted,
  }))
  const input = addInput(renderer, panel, "Path", {
    value: savedConfig?.localFolder || process.cwd(),
    placeholder: process.cwd(),
  })
  const status = new TextRenderable(renderer, {
    content: "Enter continue · Esc cancel",
    fg: colors.muted,
  })
  panel.add(status)
  screen.add(panel)
  renderer.root.add(screen)
  input.focus()

  let resolving = false
  const onKey = async (key) => {
    if (key.ctrl && key.name === "c" || key.name === "escape") {
      key.preventDefault()
      renderer.keyInput.off("keypress", onKey)
      finish(null)
      return
    }
    if (key.name !== "return" && key.name !== "enter") return
    key.preventDefault()
    if (resolving) return
    resolving = true

    try {
      const localFolder = await resolveConfiguredLocalFolder(input.value)
      renderer.keyInput.off("keypress", onKey)
      removeScreen(renderer, screen)
      showCredentialsForm(renderer, savedConfig, localFolder, finish, fail)
    } catch (error) {
      resolving = false
      status.fg = colors.danger
      status.content = errorMessage(error)
    }
  }
  renderer.keyInput.on("keypress", onKey)
}

function showCredentialsForm(renderer, savedConfig, localFolder, finish, fail) {
  const screen = makeScreen(renderer, "credentials-screen")
  const panel = makePanel(renderer, "credentials-panel")

  panel.add(new TextRenderable(renderer, { content: "fcks · Fucking Sync", fg: colors.accent }))
  panel.add(new TextRenderable(renderer, {
    content: "2/3  DAV connection",
    fg: colors.text,
  }))

  const serverInput = addInput(renderer, panel, "DAV server URL", {
    value: savedConfig?.serverUrl ?? "",
    placeholder: "https://dav.example.com/remote.php/dav/files/me",
  })
  const usernameInput = addInput(renderer, panel, "Username", {
    value: savedConfig?.username ?? "",
    placeholder: "name@example.com",
  })
  const passwordInput = addInput(renderer, panel, "Password / app password", {
    placeholder: savedConfig ? "Leave blank to keep the saved password" : "Type password",
    hidden: true,
  })
  const passwordPreview = new TextRenderable(renderer, {
    content: savedConfig ? "Password: •••••••• (saved)" : "Password: (not entered)",
    fg: colors.muted,
  })
  panel.add(passwordPreview)

  const status = new TextRenderable(renderer, {
    content: "Tab next · Enter connect · Esc cancel",
    fg: colors.muted,
  })
  panel.add(status)
  screen.add(panel)
  renderer.root.add(screen)

  passwordInput.on(InputRenderableEvents.INPUT, (value) => {
    passwordPreview.content = value.length > 0
      ? `Password: ${"•".repeat(Math.min(value.length, 40))}`
      : savedConfig
        ? "Password: •••••••• (saved)"
        : "Password: (not entered)"
  })

  const fields = [serverInput, usernameInput, passwordInput]
  let focusIndex = 0
  let connecting = false
  serverInput.focus()

  const onKey = async (key) => {
    if (key.ctrl && key.name === "c" || key.name === "escape") {
      key.preventDefault()
      renderer.keyInput.off("keypress", onKey)
      finish(null)
      return
    }

    if (key.name === "tab") {
      key.preventDefault()
      fields[focusIndex]?.blur()
      focusIndex = (focusIndex + (key.shift ? fields.length - 1 : 1)) % fields.length
      fields[focusIndex]?.focus()
      return
    }

    if (key.name !== "return" && key.name !== "enter") return
    key.preventDefault()
    if (connecting) return

    const serverUrl = serverInput.value.trim()
    const username = usernameInput.value.trim()
    const password = passwordInput.value || savedConfig?.password || ""

    try {
      validateCredentials(serverUrl, username, password)
      connecting = true
      status.fg = colors.accent
      status.content = "Connecting and reading the DAV root…"

      const client = new DavClient({ serverUrl, username, password, rootFolder: "/" })
      // Exercise the exact operation needed by the remote folder picker.
      // Some DAV implementations reject a Depth: 0 PROPFIND used by stat(),
      // while correctly supporting the Depth: 1 directory listing.
      await client.list("/")

      renderer.keyInput.off("keypress", onKey)
      removeScreen(renderer, screen)
      showFolderBrowser(renderer, client, {
        serverUrl,
        username,
        password,
        localFolder,
        rootFolder: savedConfig?.rootFolder ?? "/",
      }, finish, fail)
    } catch (error) {
      connecting = false
      status.fg = colors.danger
      status.content = connectionErrorMessage(error)
    }
  }

  renderer.keyInput.on("keypress", onKey)
}

function makeScreen(renderer, id) {
  return new BoxRenderable(renderer, {
    id,
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: colors.background,
    padding: 1,
  })
}

function makePanel(renderer, id) {
  return new BoxRenderable(renderer, {
    id,
    width: "100%",
    flexDirection: "column",
    backgroundColor: colors.background,
    gap: 1,
  })
}

function removeScreen(renderer, screen) {
  renderer.root.remove(screen)
  screen.destroy()
}

function addInput(renderer, parent, label, options = {}) {
  parent.add(new TextRenderable(renderer, { content: label, fg: colors.muted }))
  const hidden = options.hidden === true
  const input = new InputRenderable(renderer, {
    width: "100%",
    value: options.value ?? "",
    placeholder: options.placeholder ?? "",
    backgroundColor: colors.input,
    focusedBackgroundColor: colors.input,
    textColor: hidden ? colors.input : colors.text,
    focusedTextColor: hidden ? colors.input : colors.text,
    cursorColor: hidden ? colors.input : colors.accent,
    placeholderColor: colors.muted,
  })
  parent.add(input)
  return input
}

function showFolderBrowser(renderer, client, config, finish, fail) {
  const screen = new BoxRenderable(renderer, {
    id: "folder-screen",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: colors.background,
    padding: 1,
  })
  const pathText = new TextRenderable(renderer, { content: "", fg: colors.accent })
  const status = new TextRenderable(renderer, {
    content: "↑↓ browse · Enter open · N new · S select · Esc cancel",
    fg: colors.muted,
  })
  const createLabel = new TextRenderable(renderer, {
    content: "New folder",
    fg: colors.text,
    visible: false,
  })
  const createInput = new InputRenderable(renderer, {
    width: "100%",
    placeholder: "folder name",
    backgroundColor: colors.input,
    focusedBackgroundColor: colors.input,
    textColor: colors.text,
    focusedTextColor: colors.text,
    cursorColor: colors.accent,
    placeholderColor: colors.muted,
    visible: false,
  })
  const list = new SelectRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    options: [],
    backgroundColor: colors.panel,
    focusedBackgroundColor: colors.panel,
    textColor: colors.text,
    focusedTextColor: colors.text,
    selectedBackgroundColor: colors.border,
    selectedTextColor: "#ffffff",
    descriptionColor: colors.muted,
    selectedDescriptionColor: "#dbeafe",
    showScrollIndicator: true,
    wrapSelection: true,
  })

  screen.add(new TextRenderable(renderer, {
    content: "fcks · Fucking Sync · 3/3  Remote folder",
    fg: colors.accent,
  }))
  screen.add(pathText)
  screen.add(createLabel)
  screen.add(createInput)
  screen.add(list)
  screen.add(status)
  renderer.root.add(screen)
  list.focus()

  let currentPath = normalizeRootFolder(config.rootFolder)
  let loading = false
  let creating = false

  const startCreate = () => {
    if (loading || creating) return
    creating = true
    list.blur()
    list.visible = false
    createLabel.content = `Create inside ${currentPath}`
    createLabel.visible = true
    createInput.value = ""
    createInput.visible = true
    createInput.focus()
    status.fg = colors.muted
    status.content = "Enter create · Esc back"
  }

  const stopCreate = () => {
    creating = false
    createInput.blur()
    createInput.visible = false
    createLabel.visible = false
    list.visible = true
    list.focus()
    status.fg = colors.muted
    status.content = "↑↓ browse · Enter open · N new · S select · Esc cancel"
  }

  const createFolder = async () => {
    if (loading) return
    const name = createInput.value.trim()
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      status.fg = colors.danger
      status.content = "Enter one folder name without / or \\."
      return
    }

    loading = true
    status.fg = colors.accent
    status.content = "Creating remote folder…"
    const newPath = posix.join(currentPath, name)
    try {
      await client.createDirectory(newPath, false)
      loading = false
      stopCreate()
      await open(newPath)
    } catch (error) {
      loading = false
      status.fg = colors.danger
      status.content = `Could not create folder: ${errorMessage(error)}`
    }
  }

  const choose = async () => {
    if (loading) return
    loading = true
    status.fg = colors.accent
    status.content = "Saving configuration…"
    try {
      const finalConfig = { ...config, rootFolder: currentPath }
      await saveConfig(finalConfig)
      renderer.keyInput.off("keypress", onKey)
      finish(finalConfig)
    } catch (error) {
      loading = false
      status.fg = colors.danger
      status.content = `Could not save: ${errorMessage(error)}`
    }
  }

  const open = async (path) => {
    if (loading) return
    loading = true
    currentPath = normalizeRootFolder(path)
    pathText.content = `Remote folder: ${currentPath}`
    status.fg = colors.muted
    status.content = "Loading folders…"
    const navigationOptions = [
      {
        name: "✓ Choose this folder",
        description: currentPath,
        value: { action: "choose" },
      },
      ...(currentPath === "/" ? [] : [{
        name: "↰ Parent folder",
        description: posix.dirname(currentPath),
        value: { action: "open", path: posix.dirname(currentPath) },
      }]),
      {
        name: "+ Create folder",
        description: `inside ${currentPath}`,
        value: { action: "create" },
      },
    ]
    list.options = navigationOptions
    list.setSelectedIndex(0)

    try {
      const entries = await client.list(currentPath)
      const directories = entries
        .filter((entry) => entry.type === "directory" && normalizeRootFolder(entry.filename) !== currentPath)
        .sort((left, right) => left.basename.localeCompare(right.basename))

      list.options = [
        ...navigationOptions,
        ...directories.map((entry) => ({
          name: `▸ ${entry.basename}`,
          description: normalizeRootFolder(entry.filename),
          value: { action: "open", path: entry.filename },
        })),
      ]
      list.setSelectedIndex(0)
      status.content = "↑↓ browse · Enter open · N new · S select · Esc cancel"
    } catch (error) {
      status.fg = colors.danger
      status.content = `Could not list ${currentPath}: ${errorMessage(error)} · use Parent to recover`
    } finally {
      loading = false
    }
  }

  list.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
    const action = option?.value
    if (action?.action === "choose") void choose()
    if (action?.action === "open") void open(action.path)
    if (action?.action === "create") startCreate()
  })

  const onKey = (key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      renderer.keyInput.off("keypress", onKey)
      finish(null)
    } else if (creating && key.name === "escape") {
      key.preventDefault()
      stopCreate()
    } else if (creating && (key.name === "return" || key.name === "enter")) {
      key.preventDefault()
      void createFolder()
    } else if (!creating && key.name === "escape") {
      key.preventDefault()
      renderer.keyInput.off("keypress", onKey)
      finish(null)
    } else if (!creating && key.name === "s") {
      key.preventDefault()
      void choose()
    } else if (!creating && key.name === "n") {
      key.preventDefault()
      startCreate()
    }
  }
  renderer.keyInput.on("keypress", onKey)
  void open(currentPath).catch(fail)
}

function validateCredentials(serverUrl, username, password) {
  const url = new URL(serverUrl)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("server URL must use http or https")
  }
  if (!username) throw new Error("username is required")
  if (!password) throw new Error("password is required")
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function connectionErrorMessage(error) {
  const status = error && typeof error === "object" && "status" in error ? error.status : null

  if (status === 405) {
    return "DAV listing rejected (405). Use the WebDAV collection URL, not a login, browser, or share URL."
  }
  if (status === 401) return "Authentication failed (401). Check the username and password/app password."
  if (status === 403) return "DAV access was forbidden (403). Check account and server permissions."
  if (status === 404) return "DAV endpoint was not found (404). Check the complete WebDAV URL."
  return `Could not connect: ${errorMessage(error)}`
}
