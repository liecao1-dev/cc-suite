#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDispatchProfiles,
  describeDispatchConfig,
  effortsForModel,
  validateAgainstCatalog,
} from "./lib/dispatch-config.mjs";
import { getDispatchEnvironment } from "./lib/dispatch-catalog.mjs";
import { recentDispatchRecord } from "./lib/dispatch-state.mjs";

const ESC = "\u001b";
const COLORS = Object.freeze({
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
});

export function pickerFields(target, config, catalog) {
  const fields = [
    { key: "effort", label: "推理强度", values: effortsForModel(config.model, catalog) },
    {
      key: "access",
      label: target === "codex" ? "沙盒权限" : "权限模式",
      values: catalog.access,
    },
  ];
  if (target === "codex") {
    fields.push({ key: "approval", label: "审批策略", values: catalog.approvals });
  }
  return fields;
}

export function cycleConfigField(config, field, delta) {
  const index = field.values.indexOf(config[field.key]);
  if (index === -1 || !field.values.length) return config;
  const next = (index + delta + field.values.length) % field.values.length;
  return { ...config, [field.key]: field.values[next] };
}

export function isRiskyConfig(target, config) {
  return (target === "codex" && config.access === "danger-full-access")
    || (target === "claude" && config.access === "bypassPermissions");
}

class TtyTerminal {
  constructor() {
    this.fd = fs.openSync("/dev/tty", "r+");
    const state = spawnSync("stty", ["-g"], {
      encoding: "utf8",
      stdio: [this.fd, "pipe", "pipe"],
    });
    if (state.status !== 0 || !state.stdout.trim()) {
      fs.closeSync(this.fd);
      throw new Error(state.stderr?.trim() || "stty -g failed");
    }
    this.saved = state.stdout.trim();
    const raw = spawnSync("stty", ["raw", "-echo", "min", "0", "time", "1"], {
      stdio: [this.fd, this.fd, this.fd],
    });
    if (raw.status !== 0) {
      fs.closeSync(this.fd);
      throw new Error("could not put /dev/tty into raw mode");
    }
    this.closed = false;
    this.signalHandlers = new Map();
    for (const [signal, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]) {
      const handler = () => {
        this.close();
        process.exit(code);
      };
      this.signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
    this.write(`${ESC}[?25l`);
  }

  write(text) {
    fs.writeSync(this.fd, String(text));
  }

  draw(lines) {
    this.write(`${ESC}[2J${ESC}[H${lines.join("\r\n")}${ESC}[0m`);
  }

  readChunk() {
    const buffer = Buffer.alloc(16);
    const count = fs.readSync(this.fd, buffer, 0, buffer.length, null);
    return count ? buffer.subarray(0, count).toString("utf8") : "";
  }

  readKey() {
    let value = "";
    while (!value) value = this.readChunk();
    if (value[0] === ESC && value.length < 3) {
      for (let attempt = 0; attempt < 2 && value.length < 3; attempt += 1) {
        const more = this.readChunk();
        if (!more) break;
        value += more;
      }
    }
    if (value === `${ESC}[A`) return "up";
    if (value === `${ESC}[B`) return "down";
    if (value === `${ESC}[C`) return "right";
    if (value === `${ESC}[D`) return "left";
    if (value === ESC) return "escape";
    if (value === "\r" || value === "\n") return "enter";
    if (value === "\u0003") return "cancel";
    if (value === "\u007f" || value === "\b") return "backspace";
    return value;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [signal, handler] of this.signalHandlers ?? []) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers?.clear();
    try { this.write(`${ESC}[0m${ESC}[?25h${ESC}[2J${ESC}[H`); } catch {}
    try { spawnSync("stty", [this.saved], { stdio: [this.fd, this.fd, this.fd] }); } catch {}
    try { fs.closeSync(this.fd); } catch {}
  }
}

function targetName(target) {
  return target === "codex" ? "Codex" : "Claude";
}

function badgeText(row) {
  if (row.badges?.includes("recent")) return "最近";
  if (row.badges?.includes("default")) return "默认";
  if (row.badges?.includes("advanced")) return "高级";
  return "模型";
}

function menuLines(target, profiles, selected, note) {
  const lines = [
    `${COLORS.bold}cc-suite｜派遣给 ${targetName(target)}${COLORS.reset}`,
    `${COLORS.dim}↑/↓ 选择　Enter 进入配置　Esc 取消${COLORS.reset}`,
    "",
  ];
  profiles.forEach((row, index) => {
    const active = index === selected;
    const prefix = active ? `${COLORS.cyan}›${COLORS.reset}` : " ";
    const badge = `[${badgeText(row)}]`;
    const title = `${prefix} ${active ? COLORS.bold : ""}${badge} ${row.label}${COLORS.reset}`;
    lines.push(title);
    lines.push(`    ${COLORS.dim}${row.description}${COLORS.reset}`);
  });
  if (note) lines.push("", `${COLORS.yellow}${note}${COLORS.reset}`);
  return lines;
}

function configLines(target, config, fields, selected, warning) {
  const lines = [
    `${COLORS.bold}配置 ${targetName(target)}${COLORS.reset}`,
    `${COLORS.dim}↑/↓ 选择项目　←/→ 切换可用值　Enter 确认　Esc 返回${COLORS.reset}`,
    "",
    `  模型　　 ${COLORS.bold}${config.model}${COLORS.reset}`,
  ];
  fields.forEach((field, index) => {
    const active = index === selected;
    const prefix = active ? `${COLORS.cyan}›${COLORS.reset}` : " ";
    const value = active ? `${COLORS.bold}${config[field.key]}${COLORS.reset}` : config[field.key];
    lines.push(`${prefix} ${field.label.padEnd(6, "　")} ${value}`);
  });
  lines.push("", `${COLORS.dim}${describeDispatchConfig(target, config)}${COLORS.reset}`);
  if (warning) lines.push("", `${COLORS.red}${COLORS.bold}${warning}${COLORS.reset}`);
  return lines;
}

function promptCustomModel(terminal, target, value = "") {
  let text = value;
  for (;;) {
    terminal.draw([
      `${COLORS.bold}输入其他 ${targetName(target)} 模型 ID${COLORS.reset}`,
      `${COLORS.dim}仅接受 CLI 模型标识符；Enter 继续，Esc 返回${COLORS.reset}`,
      "",
      `› ${text}${COLORS.cyan}_${COLORS.reset}`,
    ]);
    const key = terminal.readKey();
    if (key === "escape" || key === "cancel") return null;
    if (key === "backspace") {
      text = text.slice(0, -1);
      continue;
    }
    if (key === "enter") return text.trim() || null;
    if (typeof key === "string" && /^[A-Za-z0-9._:-]+$/.test(key)) text += key;
  }
}

function editConfig(terminal, target, initial, catalog) {
  let config = { ...initial };
  let selected = 0;
  let dangerousConfirm = false;
  for (;;) {
    const fields = pickerFields(target, config, catalog);
    const warning = dangerousConfirm
      ? "高风险权限会绕过常规隔离；再次按 Enter 才确认"
      : (isRiskyConfig(target, config) ? "当前包含高风险权限，确认时需要再按一次 Enter" : "");
    terminal.draw(configLines(target, config, fields, selected, warning));
    const key = terminal.readKey();
    if (key === "escape") return { back: true };
    if (key === "cancel") return { cancelled: true };
    if (key === "up") {
      selected = (selected - 1 + fields.length) % fields.length;
      dangerousConfirm = false;
    } else if (key === "down") {
      selected = (selected + 1) % fields.length;
      dangerousConfirm = false;
    } else if (key === "left" || key === "right") {
      config = cycleConfigField(config, fields[selected], key === "right" ? 1 : -1);
      dangerousConfirm = false;
    } else if (key === "enter") {
      config = validateAgainstCatalog(target, config, catalog);
      if (isRiskyConfig(target, config) && !dangerousConfirm) {
        dangerousConfirm = true;
      } else {
        return { config };
      }
    }
  }
}

export function preparePicker(target, cwd) {
  const environment = getDispatchEnvironment(target, cwd);
  const recent = recentDispatchRecord(cwd, target);
  const built = buildDispatchProfiles({
    target,
    recent,
    defaultConfig: environment.defaultConfig,
    defaultSource: environment.defaultSource,
    catalog: environment.catalog,
  });
  return { ...environment, recent, ...built };
}

export function runPreparedPicker({ target, prepared, terminal }) {
  let selected = 0;
  let note = prepared.recentUnavailable ? "上次配置已失效；最近配置行明确解析为当前默认配置" : "";
  for (;;) {
    terminal.draw(menuLines(target, prepared.profiles, selected, note));
    note = "";
    const key = terminal.readKey();
    if (key === "escape" || key === "cancel") return { cancelled: true };
    if (key === "up") selected = (selected - 1 + prepared.profiles.length) % prepared.profiles.length;
    else if (key === "down") selected = (selected + 1) % prepared.profiles.length;
    else if (key === "enter") {
      const row = prepared.profiles[selected];
      let initial = row.config;
      if (row.id === "custom-model") {
        const model = promptCustomModel(terminal, target);
        if (!model) continue;
        initial = { ...prepared.defaultConfig, model };
      }
      const edited = editConfig(terminal, target, initial, prepared.catalog);
      if (edited.cancelled) return { cancelled: true };
      if (edited.back) continue;
      return {
        cancelled: false,
        config: edited.config,
        profileId: row.id,
        catalogVersion: prepared.catalog.metadata?.codexVersion
          ?? prepared.catalog.metadata?.claudeVersion
          ?? null,
        defaultSource: prepared.defaultSource,
      };
    }
  }
}

export function runDispatchPicker({ target, cwd, terminal = null }) {
  const prepared = preparePicker(target, cwd);
  const ownTerminal = terminal ?? new TtyTerminal();
  try {
    return runPreparedPicker({ target, prepared, terminal: ownTerminal });
  } finally {
    if (!terminal) ownTerminal.close();
  }
}

function parseArgs(argv) {
  const args = { target: null, cwd: process.cwd() };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || !["--target", "--cwd"].includes(key)) {
      throw new Error("usage: dispatch-picker.mjs --target <codex|claude> [--cwd <dir>]");
    }
    args[key.slice(2)] = value;
  }
  return args;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!/^(codex|claude)$/.test(args.target)) throw new Error("--target must be codex or claude");
    const result = runDispatchPicker({ target: args.target, cwd: path.resolve(args.cwd) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`cc-suite picker: ${error.message}\n`);
    process.exitCode = 1;
  }
}
