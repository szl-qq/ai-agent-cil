// 终端 UI：配色、横幅、流式渲染、spinner、diff、状态行、历史输入
import readline from "node:readline/promises";
import fs from "node:fs";
import path from "node:path";
import { stdin, stdout } from "node:process";

const NO_COLOR = !!process.env.NO_COLOR;

export function makeTheme(enabled = true) {
  const on = enabled && !NO_COLOR && stdout.isTTY !== false;
  const wrap = code => s => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return {
    on,
    reset: wrap("0"),
    dim: wrap("2"),
    bold: wrap("1"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    blue: wrap("34"),
    magenta: wrap("35"),
    cyan: wrap("36"),
    gray: wrap("90"),
    bRed: wrap("1;31"),
    bGreen: wrap("1;32"),
    bCyan: wrap("1;36"),
    bMagenta: wrap("1;35"),
    bg: wrap("48;5;236"),
  };
}

export const t = makeTheme(true);

export const ICON = { user: "›", agent: "◆", tool: "⚙", ok: "✓", fail: "✗", warn: "!", info: "·", plan: "☰" };

export function banner(cfg, version = "1.0.0") {
  const L = [
    `${t.bCyan("Agent CLI")} ${t.gray("v" + version)}  ${t.dim("本机终端智能体")}`,
    `${t.gray("网关")}   ${cfg.baseUrl}`,
    `${t.gray("模型")}   ${cfg.models.join(" → ")}`,
    `${t.gray("权限")}   ${cfg.permission.mode}${cfg.stream ? t.gray("   流式 开") : t.gray("   流式 关")}`,
    `${t.gray("工作区")} ${cfg.projectRoot}`,
  ];
  return L.join("\n");
}

export function info(msg) { console.log(`${t.gray(ICON.info + " " + msg)}`); }
export function warn(msg) { console.log(`${t.yellow(ICON.warn + " " + msg)}`); }
export function error(msg) { console.log(`${t.red(ICON.fail + " " + msg)}`); }
export function success(msg) { console.log(`${t.green(ICON.ok + " " + msg)}`); }

export function section(title, body) {
  if (body === undefined) return console.log(t.bold(title));
  console.log(`${t.bold(title)}\n${body}`);
}

// ---------- 流式输出 ----------
export class StreamPrinter {
  constructor() { this.started = false; this.chars = 0; }
  begin() { if (!this.started) { process.stdout.write(`${t.bMagenta(ICON.agent)} `); this.started = true; } }
  write(chunk) { this.begin(); process.stdout.write(chunk); this.chars += chunk.length; }
  end() { if (this.started) { process.stdout.write("\n"); this.started = false; } }
}

// ---------- Spinner ----------
export class Spinner {
  constructor(label = "思考中") {
    this.frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    this.label = label;
    this.timer = null;
    this.i = 0;
    this.t0 = 0;
    this.enabled = !!stdout.isTTY;
  }
  start(label) {
    if (label) this.label = label;
    if (!this.enabled || this.timer) return;
    this.t0 = Date.now();
    this.timer = setInterval(() => {
      const s = ((Date.now() - this.t0) / 1000).toFixed(0);
      process.stdout.write(`\r\x1b[2K${t.cyan(this.frames[this.i++ % this.frames.length])} ${t.dim(this.label + " " + s + "s")}`);
    }, 90);
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; process.stdout.write("\r\x1b[2K"); }
  }
}

// ---------- 工具调用展示 ----------
function short(value, max = 220) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + "…" : one;
}

export function toolCall(name, args) {
  const keys = Object.entries(args || {}).map(([k, v]) => `${t.gray(k + "=")}${short(v, 90)}`).join(" ");
  console.log(`${t.cyan(ICON.tool)} ${t.bold(name)} ${keys}`);
}

export function toolResult(result, ok = true, meta = "") {
  const first = short(result, 300);
  const tag = ok ? t.green(ICON.ok) : t.red(ICON.fail);
  console.log(`  ${tag} ${t.dim(first)}${meta ? t.gray("  " + meta) : ""}`);
}

// ---------- 简单行级 diff ----------
export function diff(oldText, newText, file = "") {
  const a = String(oldText).split("\n");
  const b = String(newText).split("\n");
  let head = 0, tailA = a.length, tailB = b.length;
  while (head < tailA && head < tailB && a[head] === b[head]) head++;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) { tailA--; tailB--; }
  const out = [];
  if (file) out.push(t.gray(file));
  for (let i = head; i < tailA; i++) out.push(t.red("- " + a[i]));
  for (let i = head; i < tailB; i++) out.push(t.green("+ " + b[i]));
  if (!out.length) out.push(t.gray("(内容无变化)"));
  return out.join("\n");
}

// ---------- 状态行 ----------
export function statusLine({ model, steps, tokens, elapsedMs, mode }) {
  const parts = [t.gray("model " + model), t.gray("steps " + steps), t.gray("ctx≈" + tokens), t.gray((elapsedMs / 1000).toFixed(1) + "s")];
  if (mode && mode !== "smart") parts.push(t.yellow(mode));
  return t.gray("── ") + parts.join(t.gray(" · "));
}

// ---------- 输入（带历史） ----------
async function readAllStdin(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks.map(c => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), "utf8")))).toString("utf8").split(/\r?\n/);
}

/** 输入组件：TTY 下用 readline 带历史；管道/重定向下预读全部行按序消费 */
export class Prompt {
  constructor(historyFile) {
    this.historyFile = historyFile;
    this.history = [];
    try {
      this.history = fs.readFileSync(historyFile, "utf8").split("\n").filter(Boolean).slice(-300);
    } catch { /* 首次运行 */ }
    this.rl = null;
    this.queue = null;
    this.closed = false;
    this.inited = false;
    this.interactive = !!stdin.isTTY;
  }
  /** 惰性初始化：第一次真正需要输入时才接管 stdin，避免单次模式被管道阻塞 */
  async ensureInit() {
    if (this.inited) return;
    this.inited = true;
    if (this.interactive) {
      this.rl = readline.createInterface({
        input: stdin, output: stdout, terminal: true,
        history: [...this.history].reverse(), historySize: 300,
      });
    } else {
      this.queue = await readAllStdin(stdin);
    }
  }
  async ask(promptText = `${t.bCyan("你")} ${t.gray("›")} `) {
    if (this.closed) return null;
    await this.ensureInit();
    if (this.queue) {
      while (this.queue.length && this.queue[0].trim() === "") this.queue.shift();
      if (!this.queue.length) return null;
      const line = this.queue.shift();
      process.stdout.write(`${promptText}${line}\n`);
      return line;
    }
    try { return await this.rl.question(promptText); } catch { return null; }
  }
  async confirm(question) {
    const a = (await this.ask(`${t.yellow(question)} ${t.gray("[y=允许 / a=本会话允许此类 / N=拒绝]")} `)) ?? "";
    return a.trim().toLowerCase();
  }
  save() {
    if (!this.interactive) return;
    try {
      fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
      const merged = [...this.history, ...(this.rl?.history || [])].filter(Boolean);
      fs.writeFileSync(this.historyFile, [...new Set(merged)].slice(-300).join("\n"), "utf8");
    } catch { /* 忽略 */ }
  }
  close() { if (!this.closed) { this.closed = true; this.save(); this.rl?.close(); } }
}

export function formatDuration(ms) {
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 60000) + "m" + Math.round((ms % 60000) / 1000) + "s";
}

export function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + "k";
  return (n / 1000000).toFixed(2) + "M";
}
