import {
  BoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core"

const colors = {
  background: "#08111d",
  panel: "#101c2b",
  border: "#c45f2a",
  text: "#e5eefb",
  muted: "#91a4bd",
  accent: "#ee7a35",
}

/** Open a single-level folder picker and return the selected folder name. */
export async function runFolderSelector({ command, path, folders }) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    backgroundColor: colors.background,
  })
  renderer.setTerminalTitle(`fcks · Fucking Sync · ${command} folder`)

  return new Promise((resolve) => {
    let finished = false
    const finish = (result) => {
      if (finished) return
      finished = true
      renderer.keyInput.off("keypress", onKey)
      renderer.destroy()
      resolve(result)
    }

    const screen = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: colors.background,
      padding: 1,
      gap: 1,
    })
    const list = new SelectRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      options: folders.map((folder) => ({
        name: `▸ ${folder}/`,
        description: command === "pull" ? "remote folder" : "local folder",
        value: folder,
      })),
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
      content: `fcks · Fucking Sync · ${command.toUpperCase()} · SELECT FOLDER`,
      fg: colors.accent,
    }))
    screen.add(new TextRenderable(renderer, { content: path, fg: colors.muted }))
    screen.add(list)
    screen.add(new TextRenderable(renderer, {
      content: "↑↓ browse · Enter select · Esc cancel",
      fg: colors.muted,
    }))
    renderer.root.add(screen)
    list.focus()

    list.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => finish(option?.value ?? null))
    const onKey = (key) => {
      if (key.name === "escape" || key.ctrl && key.name === "c") {
        key.preventDefault()
        finish(null)
      }
    }
    renderer.keyInput.on("keypress", onKey)
  })
}
