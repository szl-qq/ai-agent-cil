// 配置系统：默认值 < 全局配置 ~/.agent-cli/config.json < 项目配置 ./.agent-cli/config.json < 环境变量 < 命令行参数
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULTS = {
  baseUrl: "http://127.0.0.1:31415/v1",
  apiKey: "",
  models: ["auto"],              // 候选链，前一个失败自动降级到下一个
  temperature: 0.3,
  maxSteps: 25,                  // 单次任务最大工具循环
  retries: 3,                    // 每个模型的瞬时故障重试次数
  timeoutMs: 180000,
  idleTimeoutMs: 90000,          // 流式期间无任何数据的判定阈值，触发中断并进入重试/降级
  stream: true,
  maxContextChars: 180000,       // 超过则触发上下文压缩
  keepRecentTurns: 6,            // 压缩时保留最近 N 轮
  permission: {
    mode: "smart",               // smart=仅危险/隐私拦截 | strict=所有写操作拦截 | yolo=全部放行
    allow: [],                   // glob 规则，命中直接放行（如 "run_command:git *"）
    deny: [],                    // glob 规则，命中直接拒绝
  },
  tools: {
    enableFetch: true,           // fetch_url 工具开关
    commandTimeoutMs: 60000,
    maxOutputChars: 30000,       // 工具输出截断上限，防止爆上下文
  },
  sessionDir: ".agent-cli/sessions",
  auditFile: ".agent-cli/audit.log",
  historyFile: ".agent-cli/history",
  color: true,
};

const USER_CONFIG = path.join(os.homedir(), ".agent-cli", "config.json");
const LOCAL_CONFIG = ".agent-cli/config.json";

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const opts = { _: [] };
  const alias = {
    "-p": "prompt", "--prompt": "prompt",
    "--model": "models",
    "--base-url": "baseUrl",
    "--api-key": "apiKey",
    "--max-steps": "maxSteps",
    "--retries": "retries",
    "--timeout": "timeoutMs",
    "--temperature": "temperature",
    "--cwd": "cwd",
    "--session": "session",
    "--dir": "sessionDir",
  };
  // --resume / --continue 的值可选：`--resume` 恢复最近会话，`--resume <名称>` 恢复指定会话
  const optionalValue = { "--resume": "resume", "--continue": "continue", "-c": "continue" };
  const flags = { "--yolo": "yolo", "--strict": "strict", "--no-stream": "noStream", "--json": "json", "--verbose": "verbose", "--list-sessions": "listSessions", "--help": "help", "-h": "help", "--version": "version", "--no-color": "noColor" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags[a]) { opts[flags[a]] = true; continue; }
    if (optionalValue[a]) {
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("-")) { opts[optionalValue[a]] = val; i++; }
      else opts[optionalValue[a]] = true;
      continue;
    }
    const key = alias[a];
    if (key) {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) continue;
      opts[key] = key === "models" ? val.split(",").map(s => s.trim()).filter(Boolean) : val;
      i++;
      continue;
    }
    if (a.startsWith("--")) continue;
    opts._.push(a);
  }
  return opts;
}

function loadKeyFile() {
  const candidates = [
    path.join(ROOT, "agent.key"),
    path.join(process.cwd(), "agent.key"),
    path.join(os.homedir(), ".agent-cli", "key"),
  ];
  for (const p of candidates) {
    try { const k = fs.readFileSync(p, "utf8").trim(); if (k) return k; } catch { /* 忽略 */ }
  }
  return "";
}

export function loadConfig(argv = process.argv.slice(2)) {
  const cli = parseArgs(argv);
  let cfg = { ...DEFAULTS };

  const global = readJson(USER_CONFIG);
  if (global) cfg = deepMerge(cfg, global);
  const local = readJson(path.join(process.cwd(), LOCAL_CONFIG));
  if (local) cfg = deepMerge(cfg, local);

  // 环境变量
  const env = {};
  if (process.env.AGENT_BASE_URL) env.baseUrl = process.env.AGENT_BASE_URL;
  if (process.env.AGENT_API_KEY) env.apiKey = process.env.AGENT_API_KEY;
  if (process.env.AGENT_MODELS) env.models = process.env.AGENT_MODELS.split(",").map(s => s.trim()).filter(Boolean);
  if (process.env.NO_COLOR) env.color = false;
  cfg = deepMerge(cfg, env);

  cfg.apiKey = cfg.apiKey || loadKeyFile();

  // 命令行优先级最高
  for (const k of ["baseUrl", "apiKey", "models", "sessionDir"]) {
    if (cli[k] !== undefined) cfg[k] = cli[k];
  }
  for (const k of ["maxSteps", "retries", "timeoutMs", "temperature"]) {
    if (cli[k] === undefined) continue;
    const n = Number(cli[k]);
    // 非法数值（如 `--max-steps abc` → NaN）会让 `step < NaN` 恒为 false，
    // 工具循环一次都不执行却毫无提示。这里保留默认值，忽略非法输入。
    if (Number.isFinite(n)) cfg[k] = n;
  }
  if (cli.noStream) cfg.stream = false;
  if (cli.noColor) cfg.color = false;
  if (cli.yolo) cfg.permission.mode = "yolo";
  if (cli.strict) cfg.permission.mode = "strict";

  cfg.baseUrl = String(cfg.baseUrl).replace(/\/+$/, "");
  cfg.projectRoot = path.resolve(cli.cwd || process.cwd());
  if (!path.isAbsolute(cfg.sessionDir)) cfg.sessionDir = path.join(cfg.projectRoot, cfg.sessionDir);
  if (!path.isAbsolute(cfg.auditFile)) cfg.auditFile = path.join(cfg.projectRoot, cfg.auditFile);
  if (!path.isAbsolute(cfg.historyFile)) cfg.historyFile = path.join(cfg.projectRoot, cfg.historyFile);
  cfg.cli = cli;
  return cfg;
}

export const CONFIG_PATHS = { ROOT, USER_CONFIG, LOCAL_CONFIG };
export { deepMerge, readJson };
