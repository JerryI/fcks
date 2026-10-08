import {
  BoxRenderable,
  SelectRenderable,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core"

import { formatPlanSizeEstimate } from "./plan-size.js"

const colors = {
  background: "#08111d",
  panel: "#101c2b",
  border: "#3c82f6",
  text: "#e5eefb",
  muted: "#91a4bd",
  accent: "#5eead4",
  danger: "#fb7185",
  warning: "#fbbf24",
  success: "#86efac",
}

/** Render the existing plan → confirm → execute flow in OpenTUI. */
export async function runSyncTui({ command, scope, buildPlan, executePlan, interrupt }) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    backgroundColor: colors.background,
  })
  renderer.setTerminalTitle(`fcks · Fucking Sync · ${command}`)

  return new Promise((resolve) => {
    const screen = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: colors.background,
      padding: 1,
      gap: 1,
    })
    const summary = new TextRenderable(renderer, {
      content: "Scanning files…",
      fg: colors.text,
    })
    const progress = new TextRenderable(renderer, {
      content: progressBar("Starting", 0, null),
      fg: colors.accent,
    })
    const changes = new SelectRenderable(renderer, {
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
      descriptionColor: colors.muted,
      selectedDescriptionColor: "#dbeafe",
      showScrollIndicator: true,
      wrapSelection: true,
    })
    const status = new TextRenderable(renderer, {
      content: "Please wait…",
      fg: colors.muted,
    })
    const footer = new TextRenderable(renderer, {
      content: "",
      fg: colors.muted,
    })

    screen.add(new TextRenderable(renderer, {
      content: `fcks · Fucking Sync · ${command.toUpperCase()}`,
      fg: colors.accent,
    }))
    screen.add(new TextRenderable(renderer, {
      content: scope.target,
      fg: colors.muted,
    }))
    screen.add(summary)
    screen.add(progress)
    screen.add(changes)
    screen.add(status)
    screen.add(footer)
    renderer.root.add(screen)

    let state = "planning"
    let plan = null
    let resultError = null
    let completed = 0
    let finished = false

    const finish = (result) => {
      if (finished) return
      finished = true
      renderer.keyInput.off("keypress", onKey)
      renderer.destroy()
      resolve(result)
    }

    const progressReporter = {
      lastWrite: 0,
      phase: "",
      startedAt: 0,
      startedValue: 0,
      update(label, current, total, options = {}) {
        if (finished || Date.now() - this.lastWrite < 40) return
        this.lastWrite = Date.now()
        if (this.phase !== label || current < this.startedValue) {
          this.phase = label
          this.startedAt = Date.now()
          this.startedValue = current
        }
        progress.content = progressBar(label, current, total, estimateTimeLeft(
          current,
          total,
          this.startedValue,
          this.startedAt,
        ), options)
      },
      finish(label, current, total = current, options = {}) {
        if (!finished) progress.content = progressBar(label, current, total, null, options)
      },
    }

    const execute = async () => {
      state = "executing"
      changes.blur()
      const planned = plan.actions.filter((item) => item.type !== "conflict").length
      summary.content = `Applying ${planned} operation${planned === 1 ? "" : "s"}…`
      status.content = "Sync in progress."
      footer.content = "Esc or Ctrl+C interrupt"
      try {
        const result = await executePlan(plan, progressReporter)
        completed = result?.completed ?? planned
        process.stdout.write("\x07")
        state = "done"
        summary.content = `${command.toUpperCase()} completed.`
        status.fg = colors.success
        status.content = `${completed} operation${completed === 1 ? "" : "s"} completed.`
        footer.content = "Enter or Esc close"
      } catch (error) {
        completed = error.completedOperations ?? 0
        state = isAbortError(error) ? "interrupted" : "error"
        resultError = error
        summary.content = isAbortError(error) ? `${command.toUpperCase()} interrupted.` : `${command.toUpperCase()} stopped.`
        status.fg = isAbortError(error) ? colors.warning : colors.danger
        status.content = isAbortError(error)
          ? completed > 0
            ? `${completed} operation${completed === 1 ? "" : "s"} completed before interruption; those changes were kept.`
            : "No operations completed."
          : `${errorMessage(error)}${completed > 0 ? ` ${completed} operation${completed === 1 ? "" : "s"} completed before the failure.` : ""}`
        footer.content = "Enter or Esc close"
      }
    }

    const onKey = (key) => {
      const close = key.name === "escape" || key.ctrl && key.name === "c"
      if (state === "planning" && close) {
        key.preventDefault()
        interrupt()
        finish({ status: "interrupted", plan: null, completed: 0 })
      } else if (state === "review" && (close || key.name === "n")) {
        key.preventDefault()
        finish({ status: "cancelled", plan, completed: 0 })
      } else if (state === "review" && (key.name === "return" || key.name === "enter" || key.name === "y")) {
        key.preventDefault()
        void execute()
      } else if (state === "executing" && close) {
        key.preventDefault()
        state = "interrupting"
        interrupt()
        status.fg = colors.warning
        status.content = "Interrupting active transfers…"
        footer.content = "Please wait"
      } else if ((state === "done" || state === "error") && (close || key.name === "return" || key.name === "enter")) {
        key.preventDefault()
        finish({
          status: state === "done" ? "completed" : "error",
          plan,
          completed,
          error: resultError,
        })
      } else if (state === "interrupted" && (close || key.name === "return" || key.name === "enter")) {
        key.preventDefault()
        finish({ status: "interrupted", plan, completed })
      } else if (state === "unchanged" && (close || key.name === "return" || key.name === "enter")) {
        key.preventDefault()
        finish({ status: "unchanged", plan, completed: 0 })
      }
    }
    renderer.keyInput.on("keypress", onKey)

    void buildPlan(progressReporter).then((nextPlan) => {
      if (finished) return
      plan = nextPlan
      const actionable = plan.actions.filter((item) => item.type !== "conflict")
      const conflicts = plan.actions.length - actionable.length
      summary.content = planSummary(plan)
      progress.content = "Review the proposed changes."

      if (plan.actions.length === 0) {
        state = "unchanged"
        status.fg = colors.success
        status.content = command === "scaffold"
          ? `Remote contains ${plan.remoteFileCount} file${plan.remoteFileCount === 1 ? "" : "s"}; required folders already exist.`
          : "Already up to date; no changes are needed."
        footer.content = "Enter or Esc close"
        return
      }

      changes.options = plan.actions.map(actionOption)
      changes.visible = true
      changes.focus()
      if (actionable.length === 0) {
        state = "unchanged"
        status.content = command === "scaffold"
          ? `Remote contains ${plan.remoteFileCount} file${plan.remoteFileCount === 1 ? "" : "s"}; ${conflicts} folder conflict${conflicts === 1 ? " was" : "s were"} left unchanged.`
          : `${conflicts} conflict${conflicts === 1 ? " was" : "s were"} left unchanged.`
        footer.content = "↑↓ inspect · Enter or Esc close"
      } else {
        state = "review"
        if (command === "free") {
          status.fg = colors.warning
          status.content = `Run merge first for safety. ${actionable.length} local file${actionable.length === 1 ? "" : "s"} will be removed.`
        } else if (command === "scaffold") {
          status.content = `Remote contains ${plan.remoteFileCount} file${plan.remoteFileCount === 1 ? "" : "s"}; local files stay unchanged.`
        } else {
          status.content = `${actionable.length} operation${actionable.length === 1 ? "" : "s"} will be applied.`
        }
        footer.content = "↑↓ inspect · Enter or Y apply all · N or Esc cancel"
      }
    }).catch((error) => {
      if (finished) return
      state = isAbortError(error) ? "interrupted" : "error"
      resultError = error
      summary.content = isAbortError(error) ? `${command.toUpperCase()} interrupted.` : `${command.toUpperCase()} could not prepare a plan.`
      status.fg = isAbortError(error) ? colors.warning : colors.danger
      status.content = isAbortError(error) ? "No operations were started." : errorMessage(error)
      footer.content = "Enter or Esc close"
    })
  })
}

function actionOption(item) {
  return {
    name: `${item.type === "conflict" ? "!" : actionMarker(item.type)} ${actionLabel(item.type)}  ${JSON.stringify(item.path || ".")}`,
    description: item.reason || actionDirection(item.type),
  }
}

function actionMarker(type) {
  if (type.includes("add") || type.startsWith("create")) return "+"
  if (type.includes("remove")) return "-"
  return "~"
}

function actionLabel(type) {
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

function actionDirection(type) {
  if (type.startsWith("upload-")) return "local → remote"
  if (type.startsWith("download-")) return "remote → local"
  return type.includes("remote") ? "remote destination" : "local destination"
}

function planSummary(plan) {
  const actions = plan.actions
  const add = actions.filter((item) => item.type.includes("add")).length
  const update = actions.filter((item) => item.type.includes("update")).length
  const remove = actions.filter((item) => item.type.includes("remove")).length
  const folders = actions.filter((item) => item.type.startsWith("create-")).length
  const conflicts = actions.filter((item) => item.type === "conflict").length
  const parts = [`Add ${add}`, `Update ${update}`, `Remove ${remove}`, `Folders ${folders}`]
  if (conflicts) parts.push(`Conflicts ${conflicts}`)
  const sizeEstimate = formatPlanSizeEstimate(plan, "  ·  ")
  if (sizeEstimate) parts.push(`Approx. ${sizeEstimate}`)
  return parts.join("  ·  ")
}

function progressBar(label, current, total, eta = null, options = {}) {
  if (total === null) return `${label}  [${formatAmount(current, options.unit)}]`
  const ratio = total === 0 ? 1 : Math.min(1, current / total)
  const width = 28
  const filled = Math.round(ratio * width)
  const remaining = eta === null ? "" : ` · ${formatDuration(eta)} left`
  return `${label}  [${"█".repeat(filled)}${"░".repeat(width - filled)}] ${Math.round(ratio * 100)}%${remaining}`
}

function estimateTimeLeft(current, total, startedValue, startedAt) {
  if (!Number.isFinite(total) || total <= current || current <= startedValue) return null
  const elapsedSeconds = (Date.now() - startedAt) / 1000
  // Startup latency and the first network chunks make very early estimates
  // wildly unstable. Wait for a representative sample before showing an ETA.
  if (elapsedSeconds < 2) return null
  const rate = (current - startedValue) / elapsedSeconds
  return rate > 0 ? (total - current) / rate : null
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${Math.round(seconds % 3600 / 60)}m`
}

function formatAmount(value, unit) {
  if (unit !== "bytes") return String(value)
  const units = ["B", "KB", "MB", "GB", "TB"]
  let amount = value
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError"
}
