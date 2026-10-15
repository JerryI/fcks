import {
  BoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextAttributes,
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

const sourceLabels = {
  both: "both sides",
  local: "local only",
  remote: "remote only",
}

/** Render one selectable level of the combined local and remote browser. */
export async function runListingTui({ path, entries, canGoUp = false }) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    backgroundColor: colors.background,
  })
  renderer.setTerminalTitle("fcks · Fucking Sync · ls")

  return new Promise((resolve) => {
    let finished = false
    let onKey
    const finish = (result = null) => {
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

    screen.add(new TextRenderable(renderer, {
      content: "fcks · Fucking Sync · LS",
      fg: colors.accent,
    }))
    screen.add(new TextRenderable(renderer, { content: path, fg: colors.muted }))
    screen.add(new TextRenderable(renderer, {
      content: listingSummary(entries),
      fg: colors.text,
    }))

    if (entries.length > 0) {
      screen.add(new TextRenderable(renderer, {
        content: `${"SOURCE".padEnd(13)} ${"TYPE".padEnd(19)} NAME`,
        fg: colors.muted,
        attributes: TextAttributes.BOLD,
      }))
      const list = new SelectRenderable(renderer, {
        flexGrow: 1,
        width: "100%",
        options: entries.map((entry) => ({
          name: listingRow(entry),
          description: "",
          value: entry,
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
        showDescription: false,
        wrapSelection: true,
      })
      screen.add(list)
      screen.add(new TextRenderable(renderer, {
        content: `${canGoUp ? "←/Backspace parent · " : ""}Enter open folder · P push · L pull · M merge · Q/Esc close`,
        fg: colors.muted,
      }))
      renderer.root.add(screen)
      list.focus()

      list.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
        const entry = option?.value
        if (entry && (entry.localType === "directory" || entry.remoteType === "directory")) {
          finish({ type: "open", name: entry.name })
        }
      })

      const selectedAction = (command) => {
        const entry = list.getSelectedOption()?.value
        if (!entry) return
        finish({ type: "sync", command, name: entry.name })
      }

      onKey = (key) => {
        if (key.name === "escape" || key.name === "q" || key.ctrl && key.name === "c") {
          key.preventDefault()
          finish()
        } else if (canGoUp && ["left", "backspace", "h"].includes(key.name)) {
          key.preventDefault()
          finish({ type: "up" })
        } else if (key.name === "p") {
          key.preventDefault()
          selectedAction("push")
        } else if (key.name === "l") {
          key.preventDefault()
          selectedAction("pull")
        } else if (key.name === "m") {
          key.preventDefault()
          selectedAction("merge")
        }
      }
    } else {
      const empty = new BoxRenderable(renderer, {
        flexGrow: 1,
        width: "100%",
        backgroundColor: colors.panel,
        padding: 1,
      })
      empty.add(new TextRenderable(renderer, {
        content: "No local or remote entries.",
        fg: colors.muted,
      }))
      screen.add(empty)
      screen.add(new TextRenderable(renderer, {
        content: `${canGoUp ? "←/Backspace parent · " : ""}Q/Esc close`,
        fg: colors.muted,
      }))
      renderer.root.add(screen)
      onKey = (key) => {
        if (key.name === "escape" || key.name === "q" || key.ctrl && key.name === "c") {
          key.preventDefault()
          finish()
        } else if (canGoUp && ["left", "backspace", "h"].includes(key.name)) {
          key.preventDefault()
          finish({ type: "up" })
        }
      }
    }
    renderer.keyInput.on("keypress", onKey)
  })
}

function listingSummary(entries) {
  const counts = { both: 0, local: 0, remote: 0 }
  for (const entry of entries) counts[entry.source] += 1
  return `${entries.length} ${entries.length === 1 ? "entry" : "entries"} · ${counts.both} both sides · ${counts.local} local only · ${counts.remote} remote only`
}

function listingRow(entry) {
  const source = `● ${sourceLabels[entry.source]}`.padEnd(13)
  return `${source} ${entry.type.padEnd(19)} ${entry.displayName}`
}
