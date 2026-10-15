import {
  BoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextAttributes,
  TextRenderable,
  createCliRenderer,
  parseColor,
} from "@opentui/core"

const colors = {
  background: "#08111d",
  panel: "#101c2b",
  border: "#c45f2a",
  text: "#e5eefb",
  muted: "#91a4bd",
  accent: "#ee7a35",
  danger: "#fb7185",
}

const sourceLabels = {
  both: "both sides",
  local: "local only",
  remote: "remote only",
}

const filenameColors = {
  normal: parseColor("#67e8f9"),
  selected: parseColor("#fff3a3"),
}

/** Scan, display, and select an action for combined local/remote find results. */
export async function runFindingTui({ path, patterns, buildEntries }) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    backgroundColor: colors.background,
  })
  renderer.setTerminalTitle("fcks · Fucking Sync · find")

  return new Promise((resolve) => {
    let state = "scanning"
    let finished = false
    let resultError = null
    const abortController = new AbortController()

    const screen = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: colors.background,
      padding: 1,
      gap: 1,
    })
    const summary = new TextRenderable(renderer, {
      content: "Searching local and remote entries…",
      fg: colors.text,
    })
    const progress = new TextRenderable(renderer, {
      content: progressBar("Starting", 0, null),
      fg: colors.accent,
    })
    const header = new TextRenderable(renderer, {
      content: `${"SOURCE".padEnd(13)} ${"TYPE".padEnd(19)} PATH`,
      fg: colors.muted,
      attributes: TextAttributes.BOLD,
      visible: false,
    })
    const list = new WrappedSelectRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      options: [],
      visible: false,
      backgroundColor: colors.panel,
      focusedBackgroundColor: colors.panel,
      textColor: colors.text,
      focusedTextColor: colors.text,
      selectedBackgroundColor: colors.border,
      selectedTextColor: "#ffffff",
      showDescription: false,
      showScrollIndicator: true,
      wrapSelection: true,
    })
    const status = new TextRenderable(renderer, {
      content: "Please wait…",
      fg: colors.muted,
    })
    const footer = new TextRenderable(renderer, {
      content: "Scanning…",
      fg: colors.muted,
    })

    screen.add(new TextRenderable(renderer, {
      content: "fcks · Fucking Sync · FIND",
      fg: colors.accent,
    }))
    screen.add(new TextRenderable(renderer, { content: path, fg: colors.muted }))
    screen.add(new TextRenderable(renderer, {
      content: patterns.map((pattern) => JSON.stringify(pattern)).join(" OR "),
      fg: colors.muted,
    }))
    screen.add(summary)
    screen.add(progress)
    screen.add(header)
    screen.add(list)
    screen.add(status)
    screen.add(footer)
    renderer.root.add(screen)

    const finish = (result = null) => {
      if (finished) return
      finished = true
      renderer.keyInput.off("keypress", onKey)
      renderer.destroy()
      resolve(result)
    }

    const selectedAction = (type, command) => {
      const entry = list.getSelectedOption()?.value
      if (!entry) return
      if ((type === "open" || type === "shell") && !entry.localType) {
        status.fg = colors.accent
        status.content = "This item is remote-only. Pull it before opening it locally."
        return
      }
      finish(command
        ? { type, command, path: entry.path }
        : { type, path: entry.path })
    }

    list.on(SelectRenderableEvents.ITEM_SELECTED, () => selectedAction("open"))

    const onKey = (key) => {
      const close = key.name === "escape" || key.name === "q" || key.ctrl && key.name === "c"
      if (state === "scanning" && close) {
        key.preventDefault()
        state = "cancelling"
        abortController.abort()
        status.content = "Cancelling search…"
        footer.content = "Please wait"
      } else if (state === "results" && close) {
        key.preventDefault()
        finish()
      } else if (state === "results" && key.name === "p") {
        key.preventDefault()
        selectedAction("sync", "push")
      } else if (state === "results" && key.name === "l") {
        key.preventDefault()
        selectedAction("sync", "pull")
      } else if (state === "results" && key.name === "m") {
        key.preventDefault()
        selectedAction("sync", "merge")
      } else if (state === "results" && key.name === "o") {
        key.preventDefault()
        selectedAction("open")
      } else if (state === "results" && key.name === "c") {
        key.preventDefault()
        selectedAction("shell")
      } else if (state === "error" && (close || key.name === "return" || key.name === "enter")) {
        key.preventDefault()
        finish({ type: "error", error: resultError })
      }
    }
    renderer.keyInput.on("keypress", onKey)

    let lastWrite = 0
    const reporter = {
      update(label, current, total) {
        if (finished || Date.now() - lastWrite < 35) return
        lastWrite = Date.now()
        progress.content = progressBar(label, current, total)
      },
      finish(label, current, total = current) {
        if (!finished) progress.content = progressBar(label, current, total)
      },
    }

    void buildEntries(reporter, abortController.signal).then((entries) => {
      if (finished) return
      state = "results"
      summary.content = `${entries.length} matching ${entries.length === 1 ? "entry" : "entries"}`
      progress.content = progressBar("Search complete", entries.length, entries.length)
      footer.content = "↑↓ select · Enter/O Finder · C shell here · P push · L pull · M merge · Q/Esc close"
      if (entries.length === 0) {
        status.content = "No matching local or remote entries."
        return
      }
      header.visible = true
      list.options = entries.map((entry) => ({
        name: entry.displayPath,
        description: "",
        value: entry,
      }))
      list.visible = true
      status.content = "Select an entry."
      list.focus()
    }).catch((error) => {
      if (finished) return
      if (error instanceof Error && error.name === "AbortError") {
        finish()
        return
      }
      state = "error"
      resultError = error
      summary.fg = colors.danger
      summary.attributes = TextAttributes.BOLD
      summary.content = "Search failed."
      progress.content = ""
      status.fg = colors.danger
      status.content = error instanceof Error ? error.message : String(error)
      footer.content = "Enter or Esc close"
    })
  })
}

class WrappedSelectRenderable extends SelectRenderable {
  updateScrollOffset() {
    // The base selector assumes every item is one line tall. This renderer
    // calculates visibility from each item's wrapped height during painting.
    this.requestRender()
  }

  refreshFrameBuffer() {
    if (!this.frameBuffer) return
    const background = this._focused ? this._focusedBackgroundColor : this._backgroundColor
    this.frameBuffer.clear(background)
    if (this._options.length === 0) return

    const wrapped = this._options.map((option) => findingLines(option.value, this.width))
    this.ensureSelectionVisible(wrapped)
    let y = 0
    for (let index = this.scrollOffset; index < wrapped.length && y < this.height; index += 1) {
      const lines = wrapped[index]
      const selected = index === this._selectedIndex
      const visibleHeight = Math.min(lines.length, this.height - y)
      if (selected) this.frameBuffer.fillRect(0, y, this.width, visibleHeight, this._selectedBackgroundColor)
      const color = selected
        ? this._selectedTextColor
        : this._focused ? this._focusedTextColor : this._textColor
      for (let line = 0; line < visibleHeight; line += 1) {
        const indicator = line === 0 ? selected ? "▶ " : "  " : "  "
        this.frameBuffer.drawText(indicator, 1, y + line, color)
        let x = 3
        for (const part of lines[line]) {
          const partColor = part.bold
            ? selected ? filenameColors.selected : filenameColors.normal
            : color
          this.frameBuffer.drawText(
            part.text,
            x,
            y + line,
            partColor,
            undefined,
            part.bold ? TextAttributes.BOLD : undefined,
          )
          x += Bun.stringWidth(part.text)
        }
      }
      y += lines.length
    }

    if (this._showScrollIndicator && wrapped.length > 1) {
      const maximum = Math.max(1, wrapped.length - 1)
      const indicatorY = Math.min(this.height - 1, Math.round(this._selectedIndex / maximum * (this.height - 1)))
      this.frameBuffer.drawText("█", this.width - 1, indicatorY, this._descriptionColor)
    }
  }

  ensureSelectionVisible(wrapped) {
    if (this._selectedIndex < this.scrollOffset) this.scrollOffset = this._selectedIndex
    while (this.scrollOffset < this._selectedIndex) {
      let height = 0
      for (let index = this.scrollOffset; index <= this._selectedIndex; index += 1) {
        height += wrapped[index].length
      }
      if (height <= this.height) break
      this.scrollOffset += 1
    }
  }
}

function findingLines(entry, width) {
  const source = `● ${sourceLabels[entry.source]}`.padEnd(13)
  const columns = `${source} ${entry.type.padEnd(19)}`
  const prefix = `${columns} `
  // Account for the selector's left margin, selection marker, and scrollbar.
  const contentWidth = Math.max(8, width - 5)
  if (contentWidth - prefix.length < 8) {
    const pathLines = highlightPath(entry.displayPath, Math.max(8, contentWidth - 2))
    return [plainLine(columns), ...pathLines.map((line) => [
      { text: "  ", bold: false },
      ...line,
    ])]
  }
  const pathWidth = contentWidth - prefix.length
  const pathLines = highlightPath(entry.displayPath, pathWidth)
  const continuation = " ".repeat(prefix.length)
  return pathLines.map((line, index) => [
    { text: index === 0 ? prefix : continuation, bold: false },
    ...line,
  ])
}

function plainLine(text) {
  return [{ text, bold: false }]
}

export function highlightPath(path, maxWidth) {
  const chunks = wrapPath(path, maxWidth)
  const characters = Array.from(path)
  const lastSlash = characters.lastIndexOf("/")
  const filename = characters.slice(lastSlash + 1)
  const extensionDot = filename.lastIndexOf(".")
  const boldStart = extensionDot > 0 && extensionDot < filename.length - 1
    ? lastSlash + 1
    : -1
  let offset = 0
  return chunks.map((chunk) => {
    const chunkCharacters = Array.from(chunk)
    const start = offset
    const end = start + chunkCharacters.length
    offset = end
    if (boldStart < 0 || end <= boldStart) return [{ text: chunk, bold: false }]
    const localBoldStart = Math.max(0, boldStart - start)
    const parts = []
    if (localBoldStart > 0) {
      parts.push({ text: chunkCharacters.slice(0, localBoldStart).join(""), bold: false })
    }
    parts.push({ text: chunkCharacters.slice(localBoldStart).join(""), bold: true })
    return parts
  })
}

export function wrapPath(path, maxWidth) {
  const remaining = Array.from(path)
  const lines = []
  while (remaining.length > 0) {
    let width = 0
    let fit = 0
    let lastBoundary = 0
    while (fit < remaining.length) {
      const nextWidth = Bun.stringWidth(remaining[fit])
      if (width + nextWidth > maxWidth) break
      width += nextWidth
      fit += 1
      if (remaining[fit - 1] === "/" || remaining[fit - 1] === " ") lastBoundary = fit
    }
    if (fit === remaining.length) {
      lines.push(remaining.splice(0).join(""))
      break
    }
    const take = lastBoundary > 0 ? lastBoundary : Math.max(1, fit)
    lines.push(remaining.splice(0, take).join(""))
  }
  return lines.length > 0 ? lines : [""]
}

function progressBar(label, current, total) {
  const width = 26
  if (!Number.isFinite(total)) {
    const offset = current % width
    const activity = Array.from({ length: width }, (_, index) => {
      return (index - offset + width) % width < 7 ? "█" : "░"
    }).join("")
    return `${label}  [${activity}] ${current}`
  }
  const ratio = total === 0 ? 1 : Math.min(1, current / total)
  const filled = Math.round(ratio * width)
  return `${label}  [${"█".repeat(filled)}${"░".repeat(width - filled)}] ${Math.round(ratio * 100)}%`
}
