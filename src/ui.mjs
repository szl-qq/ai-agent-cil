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

// ---------- Markdown 渲染 ----------
/** 把模型输出的 Markdown 转成终端样式（**粗体**、`代码`、# 标题、- 列表…）。
 *
 *  两个必须遵守的约束：
 *   ① 只用「精确关闭码」——\x1b[22m 关粗体、\x1b[23m 关斜体、\x1b[39m 关前景色。
 *      绝不用 \x1b[0m：它会连同外层样式一起重置，导致「引用行里的粗体一结束、
 *      后面整段都掉色」这类嵌套失效。
 *   ② 非 TTY / NO_COLOR / --no-color 时**整行原样透传**，不做任何改写。
 *      终端风格全靠 ANSI 承载，没有 ANSI 就不存在"渲染"，此时保留原文才无损：
 *      重定向到日志后仍可 grep、可复制、可继续处理。
 */
export function createMarkdown(useAnsi) {
  if (!useAnsi) return { render: (line) => String(line) };

  const w = (open, close) => (s) => `\x1b[${open}m${s}\x1b[${close}m`;
  const bold = w(1, 22);
  const italic = w(3, 23);
  const strike = w(9, 29);
  const cyan = w(36, 39);
  const green = w(32, 39);
  const gray = w(90, 39);

  const RE_FENCE = /^\s*(?:```|~~~)/;
  const RE_HEADING = /^(#{1,6})\s+(.*)$/;
  const RE_RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
  const RE_QUOTE = /^(\s*)>\s?(.*)$/;
  const RE_TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
  const RE_UL = /^(\s*)[-*+]\s+(.*)$/;
  const RE_OL = /^(\s*)(\d+)([.)])\s+(.*)$/;

  /** 行内标记。先把行内代码摘出来用占位符保护、最后才还原，
   *  否则代码里的 `*` `_` 会被当成强调标记二次解析。 */
  function inline(src) {
    const codes = [];
    let s = String(src).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, txt, url) => `${txt} ${gray(url)}`);
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, (_, x) => bold(italic(x)));
    s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, x) => bold(x));
    s = s.replace(/__([^_\n]+)__/g, (_, x) => bold(x));
    s = s.replace(/(^|[\s(（])\*([^*\n]+)\*/g, (_, p, x) => p + italic(x));
    s = s.replace(/(^|[\s(（])_([^_\n]+)_/g, (_, p, x) => p + italic(x));
    s = s.replace(/~~([^~\n]+)~~/g, (_, x) => strike(x));
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => cyan(codes[Number(i)]));
  }

  let inCode = false;
  return {
    /** 渲染一行（不含换行符）。只改样式、不增删行——增删行会打乱流式输出的节奏，
     *  也会让用户复制到的内容与看到的不一致。 */
    render(line) {
      const raw = String(line);
      if (RE_FENCE.test(raw)) { inCode = !inCode; return gray(raw); }
      if (inCode) return cyan(raw);

      const h = raw.match(RE_HEADING);
      if (h) {
        const text = inline(h[2]);
        return h[1].length <= 2 ? `\x1b[1;36m${text}\x1b[39m\x1b[22m` : bold(text);
      }
      if (RE_RULE.test(raw)) return gray("─".repeat(28));

      const q = raw.match(RE_QUOTE);
      if (q) return gray("│ ") + inline(q[2]);

      const task = raw.match(RE_TASK);
      if (task) return `${task[1]}${task[2].trim() ? green("☑") : gray("☐")} ${inline(task[3])}`;

      const ul = raw.match(RE_UL);
      if (ul) return `${ul[1]}${gray("•")} ${inline(ul[2])}`;

      const ol = raw.match(RE_OL);
      if (ol) return `${ol[1]}${bold(ol[2] + ol[3])} ${inline(ol[4])}`;

      return inline(raw);
    },
  };
}

// ---------- 流式输出 ----------
/** 行内标记是否已成对闭合。只有成对时才允许把「尚未换行」的内容提前输出：
 *  `**加` 这种半截标记一旦脱口而出，就会被当作普通文本渲染、把星号漏给用户——
 *  而消除星号正是本功能的目的。未成对时宁可多等一会儿。 */
function markersBalanced(s) {
  const count = (re, str) => (str.match(re) || []).length;
  const even = (n) => n % 2 === 0;
  return even(count(/\*\*/g, s))
      && even(count(/\*/g, s.replace(/\*\*/g, "")))
      && even(count(/`/g, s))
      && even(count(/~/g, s))
      && even(count(/_/g, s));
}

export class StreamPrinter {
  /** markdown=false 时原样透传；ansi 默认跟随主题（--no-color / 非 TTY 下为 false） */
  constructor({ markdown = true, ansi = t.on } = {}) {
    this.started = false;
    this.chars = 0;
    this.buffer = "";
    this.md = markdown ? createMarkdown(ansi) : null;
  }
  begin() { if (!this.started) { process.stdout.write(`${t.bMagenta(ICON.agent)} `); this.started = true; } }
  write(chunk) {
    this.begin();
    const text = String(chunk);
    this.chars += text.length;
    if (!this.md) { process.stdout.write(text); return; }

    this.buffer += text;
    // ① 拿到完整的一行就立即渲染。行内标记（**粗体**、`代码`）可能被切成两个 chunk
    //    先后到达，按整行渲染才能保证标记成对。
    let i;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      process.stdout.write(this.md.render(line) + "\n");
    }
    // ② 剩下的内容还没换行（模型常把短句一次吐完，没有换行）。此时若标记已闭合就
    //    立刻输出，保留逐字流式的手感；否则留着等后续 chunk 补全。
    //    ③ 单行超长时无条件输出，避免整段话长时间不显示。
    if (this.buffer && (this.buffer.length > 400 || markersBalanced(this.buffer))) {
      process.stdout.write(this.md.render(this.buffer));
      this.buffer = "";
    }
  }
  end() {
    if (this.md && this.buffer) { process.stdout.write(this.md.render(this.buffer)); this.buffer = ""; }
    if (this.started) { process.stdout.write("\n"); this.started = false; }
  }
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
