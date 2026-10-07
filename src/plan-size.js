/** Summarize the amount of data a sync plan will transfer or remove. */
export function estimatePlanSizes(plan) {
  const actions = plan.actions ?? []
  const uploads = actions.filter((item) => item.type.startsWith("upload-"))
  const downloads = actions.filter((item) => item.type.startsWith("download-"))
  const localRemovals = actions.filter((item) => item.type === "remove-local" || item.type === "remove-local-directory")
  const remoteRemovals = actions.filter((item) => item.type === "remove-remote" || item.type === "remove-remote-directory")

  return {
    upload: category(uploads.length > 0, sumPrimarySizes(uploads)),
    download: category(downloads.length > 0, sumPrimarySizes(downloads)),
    freeLocal: category(localRemovals.length > 0, sumRemovalSizes(localRemovals, plan.local?.files)),
    freeRemote: category(remoteRemovals.length > 0, sumRemovalSizes(remoteRemovals, plan.remote?.files)),
  }
}

/** Format the non-empty size categories for a preview or review screen. */
export function formatPlanSizeEstimate(plan, separator = " · ") {
  const sizes = estimatePlanSizes(plan)
  return [
    sizes.upload.present ? `${formatBytes(sizes.upload.bytes)} to upload` : null,
    sizes.download.present ? `${formatBytes(sizes.download.bytes)} to download` : null,
    sizes.freeLocal.present ? `${formatBytes(sizes.freeLocal.bytes)} to be freed locally` : null,
    sizes.freeRemote.present ? `${formatBytes(sizes.freeRemote.bytes)} to be freed remotely` : null,
  ].filter(Boolean).join(separator)
}

export function formatBytes(value) {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let amount = Math.max(0, Number(value) || 0)
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`
}

function category(present, bytes) {
  return { present, bytes }
}

function sumPrimarySizes(actions) {
  return actions.reduce((total, item) => total + fileSize(item.primary), 0)
}

function sumRemovalSizes(actions, files = new Map()) {
  const paths = new Set()
  let fallbackBytes = 0
  for (const item of actions) {
    if (item.type.endsWith("-directory")) {
      for (const path of files.keys()) {
        if (path === item.path || path.startsWith(`${item.path}/`)) paths.add(path)
      }
    } else if (files.has(item.path)) {
      paths.add(item.path)
    } else {
      fallbackBytes += fileSize(item.primary)
    }
  }
  return fallbackBytes + [...paths].reduce((total, path) => total + fileSize(files.get(path)), 0)
}

function fileSize(file) {
  const size = Number(file?.size)
  return Number.isFinite(size) && size > 0 ? size : 0
}
