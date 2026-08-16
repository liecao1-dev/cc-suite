const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const TARGETS = Object.freeze({
  codex: Object.freeze({
    efforts: Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
    access: Object.freeze(["read-only", "workspace-write", "danger-full-access"]),
    approvals: Object.freeze(["untrusted", "on-request", "never"]),
    defaultEffort: "medium",
    defaultAccess: "workspace-write",
    defaultApproval: "on-request",
  }),
  claude: Object.freeze({
    efforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    access: Object.freeze([
      "default", "acceptEdits", "auto", "manual", "dontAsk", "plan", "bypassPermissions",
    ]),
    defaultEffort: "medium",
    defaultAccess: "default",
  }),
});

function targetSpec(target) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`unsupported dispatch target: ${target}`);
  return spec;
}

function cleanString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function effortsForModel(model, catalog) {
  const detail = (catalog?.modelsDetail ?? []).find((entry) => entry.slug === model);
  if (Array.isArray(detail?.reasoning_efforts) && detail.reasoning_efforts.length) {
    return detail.reasoning_efforts;
  }
  return catalog?.efforts ?? [];
}

export function defaultEffortForModel(target, model, catalog, preferred = null) {
  const supported = effortsForModel(model, catalog);
  if (!supported.length) throw new Error(`${target} model has no advertised reasoning levels: ${model}`);
  if (preferred && supported.includes(preferred)) return preferred;
  const detail = (catalog?.modelsDetail ?? []).find((entry) => entry.slug === model);
  if (detail?.default_reasoning_effort && supported.includes(detail.default_reasoning_effort)) {
    return detail.default_reasoning_effort;
  }
  const fallback = TARGETS[target].defaultEffort;
  if (supported.includes(fallback)) return fallback;
  return supported[0];
}

export function normalizeDispatchConfig(target, value, capabilities = {}) {
  const spec = targetSpec(target);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dispatch config must be an object");
  }

  const model = cleanString(value.model, "model");
  if (!MODEL_ID.test(model)) {
    throw new Error(`invalid model id: ${JSON.stringify(model)}`);
  }

  const effort = cleanString(value.effort, "effort");
  const advertisedEfforts = Array.isArray(capabilities.efforts) && capabilities.efforts.length
    ? capabilities.efforts
    : spec.efforts;
  if (!advertisedEfforts.includes(effort)) {
    throw new Error(`unsupported ${target} effort for ${model}: ${effort}`);
  }

  const access = cleanString(value.access, "access");
  const advertisedAccess = Array.isArray(capabilities.access) && capabilities.access.length
    ? capabilities.access
    : spec.access;
  if (!advertisedAccess.includes(access)) {
    throw new Error(`unsupported ${target} access mode: ${access}`);
  }

  const result = { model, effort, access };
  if (target === "codex") {
    const approval = cleanString(value.approval ?? spec.defaultApproval, "approval");
    const advertisedApprovals = Array.isArray(capabilities.approvals) && capabilities.approvals.length
      ? capabilities.approvals
      : spec.approvals;
    if (!advertisedApprovals.includes(approval)) {
      throw new Error(`unsupported codex approval policy: ${approval}`);
    }
    result.approval = approval;
  }
  return result;
}

export function validateAgainstCatalog(target, value, catalog) {
  if (!catalog || !Array.isArray(catalog.models) || !catalog.models.length) {
    throw new Error(`${target} catalog has no models`);
  }
  if (target === "codex" && !catalog.models.includes(value.model)) {
    throw new Error(`Codex model is not in the current catalog: ${value.model}`);
  }
  return normalizeDispatchConfig(target, value, {
    efforts: effortsForModel(value.model, catalog),
    access: catalog.access,
    approvals: catalog.approvals,
  });
}

export function dispatchConfigKey(config) {
  return [config.model, config.effort, config.access, config.approval ?? ""].join("\u0000");
}

export function describeDispatchConfig(target, config) {
  if (target === "codex") {
    return `${config.model} · ${config.effort} · sandbox=${config.access} · approval=${config.approval}`;
  }
  return `${config.model} · ${config.effort} · permission=${config.access}`;
}

function profile(target, id, config, badges, displayName, description, extra = {}) {
  return {
    id,
    badges,
    label: displayName ?? config.model,
    description: description ?? describeDispatchConfig(target, config),
    config,
    ...extra,
  };
}

function modelDisplayName(model, catalog) {
  return (catalog.modelsDetail ?? []).find((entry) => entry.slug === model)?.display_name ?? model;
}

function normalizeRecentRecord(recent) {
  if (!recent || typeof recent !== "object") return null;
  if (recent.config && typeof recent.config === "object") return recent;
  return { config: recent, usedAt: null };
}

/** Build compact model rows. Reasoning/access combinations are intentionally
 * not flattened: Enter opens the editor and uses the selected model's actual
 * capability list. */
export function buildDispatchProfiles({
  target,
  recent,
  defaultConfig,
  defaultSource = "target CLI effective configuration",
  catalog,
}) {
  targetSpec(target);
  const normalizedDefault = validateAgainstCatalog(target, defaultConfig, catalog);
  const rows = [];
  const seenModels = new Set([normalizedDefault.model]);
  const recentRecord = normalizeRecentRecord(recent);
  let normalizedRecent = null;
  let recentUnavailable = false;

  if (recentRecord?.config) {
    try {
      normalizedRecent = validateAgainstCatalog(target, recentRecord.config, catalog);
    } catch {
      recentUnavailable = true;
    }
  }

  if (normalizedRecent) {
    seenModels.add(normalizedRecent.model);
    const time = recentRecord.usedAt ? ` · ${recentRecord.usedAt}` : "";
    rows.push(profile(
      target,
      "recent",
      normalizedRecent,
      ["recent"],
      "最近配置",
      `${describeDispatchConfig(target, normalizedRecent)}${time}`,
      { usedAt: recentRecord.usedAt ?? null },
    ));
  } else {
    rows.push(profile(
      target,
      "recent",
      normalizedDefault,
      ["recent"],
      "最近配置（首次使用）",
      `尚无可用记录；本次明确采用 ${describeDispatchConfig(target, normalizedDefault)}`,
      { usedAt: null, resolvesTo: "default" },
    ));
  }

  rows.push(profile(
    target,
    "default",
    normalizedDefault,
    ["default"],
    "默认配置",
    `${describeDispatchConfig(target, normalizedDefault)} · 来源：${defaultSource}`,
    { source: defaultSource },
  ));

  for (const model of catalog.models) {
    if (seenModels.has(model)) continue;
    const config = validateAgainstCatalog(target, {
      model,
      effort: defaultEffortForModel(target, model, catalog),
      access: normalizedDefault.access,
      ...(target === "codex" ? { approval: normalizedDefault.approval } : {}),
    }, catalog);
    rows.push(profile(
      target,
      `model:${model}`,
      config,
      [],
      modelDisplayName(model, catalog),
      describeDispatchConfig(target, config),
    ));
    seenModels.add(model);
  }

  if (target === "claude") {
    rows.push({
      id: "custom-model",
      badges: ["advanced"],
      label: "其他 Claude 模型 ID…",
      description: "输入 Claude Code 支持的完整模型名称",
      config: null,
    });
  }

  return { profiles: rows, recentUnavailable };
}

export function readRecentDispatchRecord(configState, target) {
  const value = configState?.recentDispatch?.[target];
  if (!value || typeof value !== "object" || !value.config) return null;
  return { config: value.config, usedAt: value.usedAt ?? null };
}

export function readRecentDispatch(configState, target) {
  return readRecentDispatchRecord(configState, target)?.config ?? null;
}

export function withRecentDispatch(configState, target, config, usedAt = new Date().toISOString()) {
  targetSpec(target);
  const normalized = normalizeDispatchConfig(target, config);
  return {
    ...(configState ?? {}),
    recentDispatch: {
      ...(configState?.recentDispatch ?? {}),
      [target]: { config: normalized, usedAt },
    },
  };
}
