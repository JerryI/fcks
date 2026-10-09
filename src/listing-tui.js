import {
  BoxRenderable,
  ScrollBoxRenderable,
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

const sourceColors = {
  both: "#86efac",
  local: "#67e8f9",
  remote: "#c4b5fd",
}

/** Render a read-only, scrollable view of a combined local and remote listing. */
export async function runListingTui({ path, entries }) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    backgroundColor: colors.background,
  })
  renderer.setTerminalTitle("fcks · Fucking Sync · ls")

  return new Promise((resolve) => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      renderer.keyInput.off("keypress", onKey)
      renderer.destroy()
      resolve()
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
      const list = new ScrollBoxRenderable(renderer, {
        flexGrow: 1,
        width: "100%",
        backgroundColor: colors.panel,
        focusable: true,
        scrollX: false,
        scrollY: true,
        contentOptions: {
          flexDirection: "column",
          backgroundColor: colors.panel,
          padding: 1,
        },
      })
      for (const entry of entries) {
        list.add(new TextRenderable(renderer, {
          width: "100%",
          height: 1,
          content: listingRow(entry),
          fg: sourceColors[entry.source],
          wrapMode: "none",
          truncate: true,
        }))
      }
      screen.add(list)
      screen.add(new TextRenderable(renderer, {
        content: "↑↓ or PgUp/PgDn scroll · Enter, q, Esc, or Ctrl+C close",
        fg: colors.muted,
      }))
      renderer.root.add(screen)
      list.focus()
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
        content: "Enter, q, Esc, or Ctrl+C close",
        fg: colors.muted,
      }))
      renderer.root.add(screen)
    }

    const onKey = (key) => {
      if (
        key.name === "escape" ||
        key.name === "return" ||
        key.name === "enter" ||
        key.name === "q" ||
        key.ctrl && key.name === "c"
      ) {
        key.preventDefault()
        finish()
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
