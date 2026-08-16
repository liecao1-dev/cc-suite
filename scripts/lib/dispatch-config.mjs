const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const TARGETS = Object.freeze({
  codex: Object.freeze({
    efforts: Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
    access: Object.freeze(["read-only", "workspace-write", "danger-full-access"]),
    defaultEffort: "medium",
    defaultAccess: "workspace-write",
  }),
  claude: Object.freeze({
    efforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    access: Object.freeze(["default", "acceptEdits", "plan"]),
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
    throw new Error(`unsupported ${target} effort: ${effort}`);
  }

  const access = cleanString(value.access, "access");
  const advertisedAccess = Array.isArray(capabilities.access) && capabilities.access.length
    ? capabilities.access
    : spec.access;
  if (!advertisedAccess.includes(access)) {
    throw new Error(`unsupported ${target} access mode: ${access}`);
  }

  return { model, effort, access };
}

export function dispatchConfigKey(config) {
  return `${config.model}\u0000${config.effort}\u0000${config.access}`;
}

export function describeDispatchConfig(target, config) {
  const accessLabel = target === "codex" ? "sandbox" : "permission";
  return `${config.model} · ${config.effort} · ${accessLabel}=${config.access}`;
}

function effortsForModel(model, catalog) {
  const detail = (catalog.modelsDetail ?? []).find((entry) => entry.slug === model);
  if (Array.isArray(detail?.reasoning_efforts) && detail.reasoning_efforts.length) {
    return detail.reasoning_efforts;
  }
  return catalog.efforts ?? [];
}

function compatibleEffort(preferred, model, catalog, target) {
  const supported = effortsForModel(model, catalog);
  if (supported.includes(preferred)) return preferred;
  const fallback = TARGETS[target].defaultEffort;
  if (supported.includes(fallback)) return fallback;
  return supported[0] ?? fallback;
}

function isRecentUsable(target, config, catalog) {
  try {
    const efforts = effortsForModel(config.model, catalog);
    normalizeDispatchConfig(target, config, {
      efforts: efforts.length ? efforts : catalog.efforts,
      access: catalog.access,
    });
  } catch {
    return false;
  }
  if (target === "codex") return catalog.models.includes(config.model);
  return config.model === "default" || MODEL_ID.test(config.model);
}

function profile(target, id, config, badges, displayName, description) {
  return {
    id,
    badges,
    label: displayName ?? config.model,
    description: description ?? describeDispatchConfig(target, config),
    config,
  };
}

function modelDisplayName(model, catalog) {
  return (catalog.modelsDetail ?? []).find((entry) => entry.slug === model)?.display_name ?? model;
}

/**
 * Build chooser rows in the fixed UX order:
 * recent configuration, default configuration, then remaining models.
 * Recent and default always remain separate rows. Even when their tuples are
 * identical, the two entries communicate different intent: "reuse my last
 * choice" versus "use the product default". Keeping both is also what makes
 * the composer order stable on first use.
 */
export function buildDispatchProfiles({ target, recent, defaultConfig, catalog }) {
  targetSpec(target);
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error(`${target} catalog has no models`);
  }

  const defaultEfforts = effortsForModel(defaultConfig.model, catalog);
  const normalizedDefault = normalizeDispatchConfig(target, defaultConfig, {
    efforts: defaultEfforts.length ? defaultEfforts : catalog.efforts,
    access: catalog.access,
  });
  const rows = [];
  const seenModels = new Set();
  let recentUnavailable = false;
  let normalizedRecent = null;

  if (recent) {
    try {
      normalizedRecent = normalizeDispatchConfig(target, recent);
    } catch {
      normalizedRecent = null;
    }
    if (normalizedRecent && !isRecentUsable(target, normalizedRecent, catalog)) {
      normalizedRecent = null;
      recentUnavailable = true;
    }
  }

  if (normalizedRecent) {
    rows.push(profile(
      target,
      "recent",
      normalizedRecent,
      ["recent"],
      modelDisplayName(normalizedRecent.model, catalog),
      describeDispatchConfig(target, normalizedRecent),
    ));
  } else {
    // The first-use recent row is explicit and visibly resolves to default at
    // dispatch time. It must not disappear merely because no MRU exists yet.
    rows.push(profile(
      target,
      "recent",
      normalizedDefault,
      ["recent"],
      `最近配置（首次为 ${modelDisplayName(normalizedDefault.model, catalog)}）`,
      `本项目尚无可用最近配置时采用 ${describeDispatchConfig(target, normalizedDefault)}`,
    ));
  }

  rows.push(profile(
    target,
    "default",
    normalizedDefault,
    ["default"],
    modelDisplayName(normalizedDefault.model, catalog),
    describeDispatchConfig(target, normalizedDefault),
  ));
  seenModels.add(normalizedDefault.model);

  for (const model of catalog.models) {
    if (seenModels.has(model)) continue;
    const config = {
      model,
      effort: compatibleEffort(normalizedDefault.effort, model, catalog, target),
      access: normalizedDefault.access,
    };
    const detail = (catalog.modelsDetail ?? []).find((entry) => entry.slug === model);
    rows.push(profile(
      target,
      `model:${model}`,
      config,
      [],
      detail?.display_name ?? model,
      describeDispatchConfig(target, config),
    ));
    seenModels.add(model);
  }

  return { profiles: rows, recentUnavailable };
}

export function readRecentDispatch(configState, target) {
  const value = configState?.recentDispatch?.[target];
  if (!value || typeof value !== "object") return null;
  return value.config ?? null;
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
