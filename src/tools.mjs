// 工具集：文件读写/编辑、目录与内容检索、命令执行、网页抓取、技能加载、计划更新
import fs from "node:fs";
import path from "node:path";
import { exec, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";

const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "dist", "build", ".next", ".cache", "__pycache__", ".venv", "venv"]);

function safeResolve(root, p) {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  return abs;
}

function truncate(text, max, hint = "") {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const rest = s.length - max;
  return s.slice(0, max) + `\n…（已截断：以上仅为前 ${max} 字符，后面还有 ${rest} 字符未显示。${hint}）`;
}

/** 通配符匹配（逐字符解析，支持跨目录语义）：
 *  - 以「双星号 + 斜杠」开头的模式匹配"零或多层目录"，因此既能匹配根目录文件，也能匹配子目录文件
 *  - 单个星号匹配除路径分隔符外的任意字符，问号匹配单个字符
 *  早期实现把双星号简单替换为点星再拼斜杠，导致根目录文件永远匹配不到。 */
function globMatch(pattern, name) {
  const p = String(pattern).replace(/\\/g, "/");
  const n = String(name).replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }   // **/ → 零或多层目录
        else { re += ".*"; i += 1; }                          // **  → 任意内容
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "i").test(n);
}

function walk(dir, out = [], depth = 0, maxDepth = 12) {
  if (depth > maxDepth || out.length > 20000) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".") && depth > 3) continue;
      walk(full, out, depth + 1, maxDepth);
    } else {
      out.push(full);
    }
  }
  return out;
}

// 目录树缓存：同一轮内 find_files / search_text 往往对同一目录重复遍历，
// 缓存可将其降为一次。任何写操作都会使缓存失效，避免读到过期结果。
let WALK_VERSION = 0;
const WALK_CACHE = new Map();
export function invalidateWalkCache() { WALK_VERSION++; WALK_CACHE.clear(); }

export function walkCached(dir, maxDepth = 12) {
  const key = `${dir}\u0000${maxDepth}`;
  const hit = WALK_CACHE.get(key);
  if (hit && hit.version === WALK_VERSION && Date.now() - hit.ts < 10000) return hit.files;
  const files = walk(dir, [], 0, maxDepth);
  if (WALK_CACHE.size > 64) WALK_CACHE.clear();
  WALK_CACHE.set(key, { files, version: WALK_VERSION, ts: Date.now() });
  return files;
}

// 正在运行的前台子进程（用于 Ctrl+C 时连带终止）
export const RUNNING_CHILDREN = new Set();
export function killRunningChildren() {
  let n = 0;
  for (const child of RUNNING_CHILDREN) {
    try { child.kill(); n++; } catch { /* 已退出 */ }
  }
  RUNNING_CHILDREN.clear();
  return n;
}

// 不会自行退出的 GUI 程序：命中则自动后台启动，避免阻塞会话。
// 注意：不包含 cmd / powershell / bash 等 shell —— 它们本身会产生输出，误判为后台会静默丢掉结果，
// 这类交互式 shell 由模型显式传 wait=false 处理。
const GUI_APPS = /^\s*(?:"[^"]+"\s*)?(notepad|mspaint|calc|explorer|control|mmc|regedit|taskmgr|charmap|osk|magnify|dxdiag|write|wordpad|code|cursor|sublime_text|chrome|msedge|firefox|iexplore|wechat|weixin|qq|dingtalk|thunderbird|outlook|spotify|vlc|wmplayer|photoshop|illustrator|pycharm|idea64|devenv)\b/i;

/** 是否 URL（`start <url>` 会拉起默认浏览器，属于 GUI 程序，按程序名名单匹配不到） */
function isUrlLike(s) {
  return /^[a-z][a-z0-9+.\-]*:\/\//i.test(String(s).trim());
}

export function isGuiLike(cmd) {
  const c = String(cmd).replace(/^start\s+("")?\s*/i, "");
  if (isUrlLike(c)) return true;
  return GUI_APPS.test(c);
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const countReplacement = s => (s.match(/\uFFFD/g) || []).length;

/** 解码子进程输出。
 *  Windows 内置命令（taskkill / dir / net 等）按系统 ANSI 代码页输出，中文系统即 GBK；
 *  而现代工具多输出 UTF-8。固定按 UTF-8 解码会让 cmd 的中文整片变成 `�ɹ�:` 之类乱码。
 *  做法：先按 UTF-8 试解，出现替换字符再回退 GBK，取替换字符更少的结果。 */
export function decodeOutput(buf) {
  if (!buf || !buf.length) return "";
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const utf8 = b.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    const gbk = new TextDecoder("gb18030").decode(b);
    return countReplacement(gbk) < countReplacement(utf8) ? gbk : utf8;
  } catch {
    return utf8;
  }
}

/** HTML → 纯文本。
 *  **保留 `<a href>` 链接**并把相对地址补成绝对地址 —— 早先的实现把所有标签连同链接一起替换成空格，
 *  抓搜索结果页只会得到一堆没有地址的文字，模型根本无法"再点进去看那一条"，搜索流程直接断掉。 */
export function htmlToText(html, baseUrl = "") {
  const toAbs = href => {
    if (!href) return "";
    if (/^\s*(javascript:|mailto:|tel:|#)/i.test(href)) return "";
    try { return baseUrl ? new URL(href, baseUrl).href : href; } catch { return href; }
  };
  const links = [];
  const out = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    // 导航、页脚、侧栏整块丢弃：这些区域全是重复的站点链接。实测在某模型页上，
    // 真正的数据被前面几千字符的导航挤到第 6589 字符处，导致按小 max_chars 抓取时永远看不到。
    // 保留 <header>/<main>，因为不少站点把标题与正文放在里面。
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, " ")
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
      const label = String(inner).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const link = toAbs(href);
      if (!link) return label ? ` ${label} ` : " ";
      // 必须先换成占位符：直接写 <URL> 会被后面的「剥离所有标签」规则当成 HTML 标签删掉，
      // 链接刚加上就没了（这正是抓搜索结果页拿不到任何链接的原因）。
      links.push(link);
      return ` ${label} \u0000${links.length - 1}\u0000 `;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // 标签全部剥完，最后才把占位符还原成真正的链接
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<${links[Number(i)] ?? ""}>`);
}

// ---------- fetch_url 短时缓存 ----------
// 实测模型会对同一地址连抓五六次（只改 max_chars），每次都要等 0.3~4 秒。
// 缓存整份文本、按需截断，命中时明确告知"刚抓过，内容相同"，引导它别再重复。
const FETCH_CACHE = new Map();
const FETCH_TTL_MS = 30000;
const FETCH_CACHE_MAX_ENTRY = 256 * 1024;  // 单条正文上限
const FETCH_CACHE_MAX_ITEMS = 20;

function fetchCacheGet(key) {
  const hit = FETCH_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > FETCH_TTL_MS) { FETCH_CACHE.delete(key); return null; }
  return hit;
}
function fetchCacheSet(key, entry) {
  // 超大正文不入缓存：单条可达 5 MB，若按 50 条上限最坏能吃掉 250 MB 内存。
  // 缓存只为消除"同一地址连抓五六次"的浪费，大页面本来也不会被反复抓，直接放弃缓存更划算。
  if (typeof entry.body === "string" && entry.body.length > FETCH_CACHE_MAX_ENTRY) return;
  if (FETCH_CACHE.size >= FETCH_CACHE_MAX_ITEMS) FETCH_CACHE.clear();
  FETCH_CACHE.set(key, { ...entry, ts: Date.now() });
}

/** 后台启动：不阻塞会话，进程脱离父进程独立运行 */
function spawnDetached(command, cwd) {
  // shell:true 让 Node 负责命令字符串的引号处理（与 exec 同一机制）。
  // 手工拼 `cmd /d /s /c "..."` 会被 cmd 剥引号，导致 `node -e "..."` 这类命令参数丢失、静默失败。
  const child = spawn(command, {
    cwd, shell: true, detached: true, stdio: "ignore", windowsHide: true,
  });
  // spawn 失败（cwd 不存在等）会 emit 'error'；没有监听器会变成未捕获异常直接崩溃进程
  child.on("error", () => { /* 交由调用方的返回信息体现 */ });
  child.unref();
  return { pid: child.pid ?? null };
}

// ---------- Windows GUI 交互支持 ----------

/** 调用 PowerShell，脚本经 Base64(UTF-16LE) 由 -EncodedCommand 传入。
 *  内联 -Command 在 cmd 下会被剥掉外层引号、非 ASCII 内容还会按 GBK 误解码，
 *  EncodedCommand 同时规避这两个问题（对含中文的输入文本尤其关键）。
 *  接受脚本行数组或单个字符串；用换行拼接而非分号，避免破坏 do/while、if 块的结构。 */
function runPwsh(scriptOrLines, timeoutMs = 20000) {
  const script = Array.isArray(scriptOrLines) ? scriptOrLines.join("\n") : String(scriptOrLines);
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  return new Promise(resolve => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => resolve({
        failed: !!err,
        code: err?.code ?? 0,
        out: String(stdout || ""),
        err: String(stderr || ""),
      }));
  });
}

/** 自研键盘注入器（C# 源码，Add-Type 内联编译）。
 *
 *  为什么不用 [System.Windows.Forms.SendKeys]：实测在同一台机器上它丢键极严重——
 *  输入 26 个字符只有 3 个到达目标，且 ASCII 全丢、组合键 ^a 完全无效。
 *  根因是 SendKeys 对 ASCII 走"虚拟键码 + 隐式修饰键"路径，依赖当时的键盘状态；
 *  这里改为**所有可见字符都走 KEYEVENTF_UNICODE 通道**，键值与组合键都自己显式按下/释放，
 *  不依赖任何隐含状态，中英文与特殊符号行为一致。
 *
 *  本类同时承载窗口/前台相关 API（见下方 DllImport）：两者放进同一编译单元，
 *  才能共用同一份 DLL 缓存——否则窗口那组每次调用都要重新编译一次。 */
const TYPER_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class AgentTyper {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] p, int size);

  // 窗口/前台相关 API 与键盘注入放进同一个编译单元：
  // 早先它们各自用 Add-Type -MemberDefinition 单独编译，导致每次 send_keys 都要重新编译一次（约 1 秒），
  // 而键盘注入那部分是有 DLL 缓存的——两者合并后才真正享受缓存。
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetLastActivePopup(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 2, KEYEVENTF_UNICODE = 4;
  const uint MOD_ALT = 1, MOD_CTRL = 2, MOD_SHIFT = 4;
  const ushort VK_SHIFT = 0x10, VK_CTRL = 0x11, VK_ALT = 0x12, VK_RETURN = 0x0D;

  static readonly Dictionary<string, ushort> NAMED = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
    {"ENTER",0x0D},{"RETURN",0x0D},{"TAB",0x09},{"ESC",0x1B},{"ESCAPE",0x1B},{"SPACE",0x20},
    {"BACKSPACE",0x08},{"BS",0x08},{"DELETE",0x2E},{"DEL",0x2E},{"INSERT",0x2D},{"INS",0x2D},
    {"UP",0x26},{"DOWN",0x28},{"LEFT",0x25},{"RIGHT",0x27},{"HOME",0x24},{"END",0x23},
    {"PGUP",0x21},{"PGDN",0x22},{"F1",0x70},{"F2",0x71},{"F3",0x72},{"F4",0x73},{"F5",0x74},{"F6",0x75},
    {"F7",0x76},{"F8",0x77},{"F9",0x78},{"F10",0x79},{"F11",0x7A},{"F12",0x7B}
  };

  static INPUT Mk(ushort vk, ushort scan, uint flags) {
    INPUT a = new INPUT();
    a.type = INPUT_KEYBOARD;
    a.U.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
    return a;
  }
  static void SendAll(INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
  static void TapVk(ushort vk) {
    // 按下与释放放进同一次 SendInput：分开两次调用时中间存在窗口期，实测会丢键
    INPUT[] a = new INPUT[2];
    a[0] = Mk(vk, 0, 0);
    a[1] = Mk(vk, 0, KEYEVENTF_KEYUP);
    SendAll(a);
  }
  static void TapChar(char c) {
    INPUT[] a = new INPUT[2];
    a[0] = Mk(0, c, KEYEVENTF_UNICODE);
    a[1] = Mk(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
    SendAll(a);
  }

  static void Combo(uint mods, ushort vk, uint delay) {
    // 整组事件必须放进**一次** SendInput：分成多次调用时 Windows 不会把修饰键状态保持到下一次调用，
    // 实测表现为 Ctrl+A 完全无效（而无修饰键的 BACKSPACE/ENTER 正常）。
    List<INPUT> ev = new List<INPUT>();
    List<ushort> held = new List<ushort>();
    if ((mods & MOD_CTRL) != 0) { ev.Add(Mk(VK_CTRL, 0, 0)); held.Add(VK_CTRL); }
    if ((mods & MOD_ALT) != 0) { ev.Add(Mk(VK_ALT, 0, 0)); held.Add(VK_ALT); }
    if ((mods & MOD_SHIFT) != 0) { ev.Add(Mk(VK_SHIFT, 0, 0)); held.Add(VK_SHIFT); }
    ev.Add(Mk(vk, 0, 0));
    ev.Add(Mk(vk, 0, KEYEVENTF_KEYUP));
    for (int i = held.Count - 1; i >= 0; i--) ev.Add(Mk(held[i], 0, KEYEVENTF_KEYUP));
    SendAll(ev.ToArray());
    if (delay > 0) System.Threading.Thread.Sleep((int)delay);
  }

  public static void TypeText(string s, uint delayMs) {
    if (s == null) return;
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') TapVk(VK_RETURN);
      else TapChar(c);
      if (delayMs > 0) System.Threading.Thread.Sleep((int)delayMs);
    }
  }

  public static void TypeKeys(string seq, uint delayMs) {
    if (seq == null) return;
    int i = 0;
    while (i < seq.Length) {
      if (seq[i] == '{') {
        int end = seq.IndexOf('}', i + 1);
        if (end > i) {
          string name = seq.Substring(i + 1, end - i - 1);
          ushort vk;
          if (NAMED.TryGetValue(name, out vk)) { TapVk(vk); }
          else { foreach (char ch in name) TapChar(ch); }
          i = end + 1;
          if (delayMs > 0) System.Threading.Thread.Sleep((int)delayMs);
          continue;
        }
      }
      uint mods = 0;
      int j = i;
      while (j < seq.Length && (seq[j] == '^' || seq[j] == '%' || seq[j] == '+')) {
        if (seq[j] == '^') mods |= MOD_CTRL;
        else if (seq[j] == '%') mods |= MOD_ALT;
        else mods |= MOD_SHIFT;
        j++;
      }
      if (j >= seq.Length) break;
      char k = seq[j];
      if (k == '{') { i = j; continue; }
      if (mods != 0) {
        ushort vk = VkOfChar(k);
        // VkOfChar 对中文等无对应虚拟键的字符返回 0。若照样发出去会造出 wVk=0 的无效按键事件，
        // 组合键静默失效且可能触发意外行为——此时退化为按字面输入该字符。
        if (vk != 0) { Combo(mods, vk, delayMs); }
        else { TapChar(k); if (delayMs > 0) System.Threading.Thread.Sleep((int)delayMs); }
      } else { TapChar(k); if (delayMs > 0) System.Threading.Thread.Sleep((int)delayMs); }
      i = j + 1;
    }
  }

  static ushort VkOfChar(char c) {
    if (c >= 'a' && c <= 'z') return (ushort)(0x41 + (c - 'a'));
    if (c >= 'A' && c <= 'Z') return (ushort)(0x41 + (c - 'A'));
    if (c >= '0' && c <= '9') return (ushort)(0x30 + (c - '0'));
    if (c == ' ') return 0x20;
    if (c == '\t' || c == '\n' || c == '\r') return VK_RETURN;
    if (c == (char)0x60) return 0xC0;
    switch (c) {
      case ';': return 0xBA;
      case '=': return 0xBB;
      case ',': return 0xBC;
      case '-': return 0xBD;
      case '.': return 0xBE;
      case '/': return 0xBF;
      case '[': return 0xDB;
      case '\\': return 0xDC;
      case ']': return 0xDD;
      case '\'': return 0xDE;
    }
    return 0;
  }
}
`;

/** 注入器 DLL 的缓存键：C# 源码一变，缓存文件名跟着变 */
const TYPER_HASH = createHash("sha1").update(TYPER_CS).digest("hex").slice(0, 10);

/** 从命令行里取出可执行程序名，用于定位 GUI 窗口。
 *  只取首个 token 的 basename 并去掉 .exe 后缀；含非安全字符时返回空串（宁可不匹配，也不拼进脚本）。 */
export function exeNameOf(command) {
  const c = String(command ?? "").trim().replace(/^start\s+("")?\s*/i, "").trim();
  // URL 不是可执行程序名，返回空串交给"最近创建的窗口进程"兜底去找浏览器
  if (isUrlLike(c)) return "";
  const quoted = c.match(/^"([^"]+)"/);
  const first = quoted ? quoted[1] : (c.split(/\s+/)[0] || "");
  if (!first) return "";
  const base = (first.replace(/\\/g, "/").split("/").pop() || "").replace(/\.exe$/i, "");
  return /^[\w.\-]+$/.test(base) ? base : "";
}

function parseWindowLine(out) {
  const line = String(out).split(/\r?\n/).find(l => l.startsWith("AGENT_WIN:"));
  if (!line || line === "AGENT_WIN:none") return null;
  const parts = line.slice("AGENT_WIN:".length).split("|");
  const pid = Number(parts[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, name: (parts[1] || "").trim(), title: parts.slice(2).join("|").trim() };
}

/** 等待并定位刚启动的 GUI 窗口，返回 { pid, name, title }。
 *
 *  两个必须做对的地方：
 *  1) **必须轮询**。spawn 是异步的，命令返回后窗口往往还没创建；只查一次必然扑空，
 *     于是模型拿不到窗口 PID，就只能退回"复制到剪贴板让用户自己粘贴"。
 *  2) **优先按程序名匹配**。GUI 程序常是单实例复用（已有实例时新进程秒退、窗口归属旧进程），
 *     按"最近创建的进程"过滤会完全落空。程序名匹配对两种情况都成立。
 *  非 Windows 平台直接返回 null。 */
export async function findGuiWindow(exeName, waitMs = 5000) {
  if (process.platform !== "win32") return null;
  const name = /^[\w.\-]+$/.test(String(exeName ?? "")) ? String(exeName) : "";
  const deadlineMs = Math.max(0, Math.min(Math.trunc(waitMs), 20000));
  try {
    const r = await runPwsh([
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
      `$deadline=(Get-Date).AddMilliseconds(${deadlineMs})`,
      "$p=$null",
      "do {",
      name
        ? `  $p=Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Sort-Object StartTime -Descending -ErrorAction SilentlyContinue | Select-Object -First 1`
        : "  $p=$null",
      "  if (-not $p) {",
      "    $since=(Get-Date).AddMilliseconds(-15000)",
      "    $ids=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CreationDate -and $_.CreationDate -gt $since } | Select-Object -ExpandProperty ProcessId",
      "    $p=Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1",
      "  }",
      "  if ($p) { break }",
      "  Start-Sleep -Milliseconds 300",
      "} while ((Get-Date) -lt $deadline)",
      "if ($p) { Write-Output ('AGENT_WIN:' + $p.Id + '|' + $p.ProcessName + '|' + $p.MainWindowTitle) } else { Write-Output 'AGENT_WIN:none' }",
    ], deadlineMs + 15000);
    return parseWindowLine(r.out);
  } catch { return null; }
}

/** 构造工具表：schema + handler + 元信息 */
export function buildTools(cfg, { skills, onPlan } = {}) {
  const tools = [];
  const add = (meta, schema, handler) => tools.push({ ...meta, schema, handler });

  add(
    { name: "read_file", mutating: false, readOnly: true, parallel: true },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "读取文本文件内容，可指定行范围，返回带行号的内容。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径" },
            start_line: { type: "integer", description: "起始行，从 1 开始" },
            end_line: { type: "integer", description: "结束行（含）" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    async (args) => {
      const abs = safeResolve(cfg.projectRoot, args.path);
      let st;
      try { st = fs.statSync(abs); } catch { return `错误：无法访问 ${abs}（文件不存在或权限不足）`; }
      if (st.isDirectory()) return `错误：${abs} 是目录，请改用 list_dir。`;

      // 大文件保护：先看大小再决定读多少，避免一次性把超大文件读进内存
      const MAX_BYTES = 8 * 1024 * 1024;
      let buf;
      let note = "";
      if (st.size > MAX_BYTES) {
        const fd = fs.openSync(abs, "r");
        try {
          const tmp = Buffer.allocUnsafe(MAX_BYTES);
          const n = fs.readSync(fd, tmp, 0, MAX_BYTES, 0);
          buf = tmp.subarray(0, n);
        } finally { fs.closeSync(fd); }
        note = `[文件共 ${(st.size / 1048576).toFixed(1)} MB，仅读取前 8 MB]\n`;
      } else {
        buf = fs.readFileSync(abs);
      }

      if (isBinary(buf)) return `[二进制文件，${st.size} 字节，未读取内容]`;
      const lines = buf.toString("utf8").split("\n");
      const start = Math.max(1, args.start_line || 1);
      const end = Math.min(lines.length, args.end_line || lines.length);
      const width = String(end).length;
      const out = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(width)}| ${l}`).join("\n");
      return truncate(note + (out || "(空文件)"), cfg.tools.maxOutputChars);
    }
  );

  add(
    { name: "write_file", mutating: true },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "写入文件（新建或整体覆盖）。已有文件覆盖前会请求授权。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径" },
            content: { type: "string", description: "完整文件内容" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    async (args) => {
      const abs = safeResolve(cfg.projectRoot, args.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(args.content ?? ""), "utf8");
      invalidateWalkCache();
      return `已写入 ${abs}（${Buffer.byteLength(String(args.content ?? ""), "utf8")} 字节）`;
    }
  );

  add(
    { name: "edit_file", mutating: true },
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "精确替换文件片段：old_string 替换为 new_string。old_string 须在文件中唯一（除非 replace_all）。覆盖前会请求授权。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径" },
            old_string: { type: "string", description: "被替换的原文，需精确匹配（含缩进）" },
            new_string: { type: "string", description: "替换后的新内容" },
            replace_all: { type: "boolean", description: "替换全部匹配，默认 false" },
          },
          required: ["path", "old_string", "new_string"],
          additionalProperties: false,
        },
      },
    },
    async (args) => {
      const abs = safeResolve(cfg.projectRoot, args.path);
      const oldStr = String(args.old_string ?? "");
      if (!oldStr) return "错误：old_string 不能为空。若需整体重写文件，请使用 write_file。";

      let original;
      try { original = fs.readFileSync(abs, "utf8"); } catch { return `错误：无法读取 ${abs}（文件不存在或权限不足）`; }

      const occurrences = original.split(oldStr).length - 1;
      if (occurrences === 0) return "错误：未找到匹配内容，请检查 old_string 是否与文件完全一致（含缩进与换行）。";
      if (occurrences > 1 && !args.replace_all) return `错误：匹配到 ${occurrences} 处，请提供更长的唯一上下文，或设置 replace_all=true。`;
      if (oldStr === String(args.new_string ?? "")) return "错误：old_string 与 new_string 相同，未做修改。";

      const updated = args.replace_all ? original.split(oldStr).join(String(args.new_string ?? "")) : original.replace(oldStr, String(args.new_string ?? ""));
      fs.writeFileSync(abs, updated, "utf8");
      invalidateWalkCache();
      return `已更新 ${abs}（替换 ${args.replace_all ? occurrences : 1} 处）`;
    }
  );

  add(
    { name: "list_dir", mutating: false, readOnly: true, parallel: true },
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "列出目录内容，可指定递归深度。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "目录路径，默认工作区根" },
            depth: { type: "integer", description: "递归深度，默认 1" },
          },
          additionalProperties: false,
        },
      },
    },
    async (args) => {
      const abs = safeResolve(cfg.projectRoot, args.path || ".");
      const depth = Math.max(1, Math.min(args.depth || 1, 6));
      const lines = [];
      const rec = (dir, d) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { lines.push(`[无法读取: ${e.message}]`); return; }
        for (const e of entries) {
          if (lines.length > 800) return;
          if (e.isDirectory() && SKIP_DIRS.has(e.name)) { lines.push(`${"  ".repeat(d - 1)}[D] ${e.name}/ (已跳过)`); continue; }
          lines.push(`${"  ".repeat(d - 1)}${e.isDirectory() ? "[D]" : "[F]"} ${e.name}${e.isDirectory() ? "/" : ""}`);
          if (e.isDirectory() && d < depth) rec(path.join(dir, e.name), d + 1);
        }
      };
      rec(abs, 1);
      return truncate(`${abs}\n` + lines.join("\n"), cfg.tools.maxOutputChars);
    }
  );

  add(
    { name: "find_files", mutating: false, readOnly: true, parallel: true },
    {
      type: "function",
      function: {
        name: "find_files",
        description: "按通配符在本机工作区查找文件，如 **/*.mjs、src/**/*.ts。自动跳过 node_modules/.git。只查本机文件。",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "通配符模式" },
            cwd: { type: "string", description: "搜索起始目录，默认工作区根" },
            limit: { type: "integer", description: "最多返回数量，默认 200" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
      },
    },
    async (args) => {
      const base = safeResolve(cfg.projectRoot, args.cwd || ".");
      const all = walkCached(base);
      const hit = all.filter(f => globMatch(args.pattern, path.relative(base, f).replace(/\\/g, "/")) || globMatch(args.pattern, path.basename(f)));
      const limit = Math.min(args.limit || 200, 2000);
      if (!hit.length) return `未找到匹配 ${args.pattern} 的文件（已扫描 ${all.length} 个文件）`;
      return truncate(hit.slice(0, limit).map(f => path.relative(base, f) || f).join("\n") + (hit.length > limit ? `\n…共 ${hit.length} 个` : ""), cfg.tools.maxOutputChars);
    }
  );

  add(
    { name: "search_text", mutating: false, readOnly: true, parallel: true },
    {
      type: "function",
      function: {
        name: "search_text",
        description: "在本机工作区文件内容里搜索关键词或正则，返回 文件:行号:内容。**只能搜本机文件，不能搜网页**（查网上内容用 fetch_url）。",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "搜索内容（默认按正则）" },
            glob: { type: "string", description: "限定文件通配符，如 **/*.js" },
            cwd: { type: "string", description: "本机搜索起始目录，不接受 URL" },
            case_sensitive: { type: "boolean", description: "区分大小写，默认 false" },
            literal: { type: "boolean", description: "按纯文本而非正则，默认 false" },
            max_results: { type: "integer", description: "最大结果数，默认 100" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
      },
    },
    async (args) => {
      const base = safeResolve(cfg.projectRoot, args.cwd || ".");
      let re;
      try {
        const src = args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : args.pattern;
        re = new RegExp(src, args.case_sensitive ? "" : "i");
      } catch (e) { return `正则无效: ${e.message}`; }
      const files = walkCached(base).filter(f => !args.glob || globMatch(args.glob, path.relative(base, f).replace(/\\/g, "/")));
      const max = Math.min(args.max_results || 100, 1000);
      const out = [];
      for (const f of files) {
        if (out.length >= max) break;
        let buf;
        try { buf = fs.readFileSync(f); } catch { continue; }
        if (isBinary(buf)) continue;
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length && out.length < max; i++) {
          if (re.test(lines[i])) out.push(`${path.relative(base, f)}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
        }
      }
      return out.length ? truncate(out.join("\n"), cfg.tools.maxOutputChars) : `未找到匹配 "${args.pattern}"（已扫描 ${files.length} 个文件）`;
    }
  );

  add(
    { name: "run_command", mutating: true },
    {
      type: "function",
      function: {
        name: "run_command",
        description:
          "在工作区执行 shell 命令并返回输出；危险命令会请求授权。" +
          "GUI 程序与常驻服务不会自行退出，必须设 wait=false 后台启动，否则会一直等到超时。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "要执行的命令" },
            cwd: { type: "string", description: "执行目录，默认工作区根" },
            timeout_ms: { type: "integer", description: "超时毫秒，默认取配置值" },
            wait: { type: "boolean", description: "是否等待结束；GUI 程序或常驻服务设 false，默认 true" },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    },
    async (args) => {
      const cwd = safeResolve(cfg.projectRoot, args.cwd || ".");
      const command = String(args.command ?? "");
      const gui = isGuiLike(command);
      const background = args.wait === false || gui;

      if (background) {
        const child = spawnDetached(command, cwd);
        const why = args.wait === false ? "按 wait=false 指定" : "检测到 GUI/常驻程序";
        const lines = [`已在后台启动（${why}）：${command}`];

        // GUI 程序：额外解析出真正的窗口进程。启动器（cmd.exe）自身没有窗口，
        // 把它的 PID 交给 send_keys 会直接失败，必须换成窗口进程的 PID。
        const win = gui ? await findGuiWindow(exeNameOf(command), 5000) : null;
        if (win) {
          lines.push(`窗口进程: ${win.name} (PID ${win.pid}) — 标题「${win.title}」`);
          lines.push(`如需向该窗口输入内容：send_keys(pid=${win.pid}, text="...")`);
        } else if (child.pid) {
          lines.push(process.platform === "win32"
            ? `启动器进程号: ${child.pid}（shell 包装进程，没有窗口）。若要向程序界面输入内容，请改用 send_keys 的 window 参数按标题匹配。`
            : `进程号: ${child.pid}`);
        } else {
          lines.push("进程号: 未知（已交由系统接管）");
        }
        lines.push("该程序不会阻塞本会话，无需等待它退出。");
        // 关闭方式要明确限定范围。之前只提示 taskkill /PID <启动器> /T，常常杀不掉真正的 GUI 进程，
        // 模型便会升级成 taskkill /F /IM <程序名> —— 那会连带杀掉用户自己打开的同类窗口。
        const closePid = win?.pid ?? child.pid;
        if (process.platform === "win32" && closePid) {
          lines.push(`如需关闭：优先 send_keys(pid=${closePid}, keys="%{F4}") 让它正常退出（走应用自身的关闭流程，不会丢未保存数据）；`);
          lines.push(`确需强制结束用 taskkill /PID ${closePid} /T /F（已限定到本次启动的进程树）。`);
          lines.push("不要用 taskkill /IM <程序名> 按名字全量强杀——那会一并杀掉用户自己打开的同类程序。");
        } else if (process.platform !== "win32") {
          lines.push("如需结束请用系统进程管理工具。");
        }
        return lines.join("\n");
      }

      const timeout = Math.min(args.timeout_ms || cfg.tools.commandTimeoutMs, 600000);
      // 用 exec 而非 execFile：exec 会给整条命令再包一层引号，避免 cmd 剥离引号导致参数丢失。
      // encoding 用 buffer 而不是 utf8：Windows 内置命令按 GBK 输出，需要自己判断编码后解码。
      return new Promise(resolve => {
        const child = exec(command, {
          cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell: true,
          encoding: "buffer",
          env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        },
          (err, stdoutBuf, stderrBuf) => {
            RUNNING_CHILDREN.delete(child);
            let out = decodeOutput(stdoutBuf);
            const errText = decodeOutput(stderrBuf);
            if (errText.trim()) out += (out.trim() ? "\n[stderr]\n" : "[stderr]\n") + errText;
            const code = err?.code ?? 0;
            const killed = !!err?.killed;
            const header = killed
              ? `[已终止：超过 ${timeout}ms 未结束。若该命令是 GUI 程序或常驻服务，请改用 wait=false 后台启动]`
              : `[退出码 ${code}]`;
            resolve(truncate(`${out.trim() ? out.trim() + "\n" : ""}${header}`, cfg.tools.maxOutputChars));
          });
        RUNNING_CHILDREN.add(child);
      });
    }
  );

  // GUI 输入：向已打开的窗口注入键盘输入（仅 Windows）。
  // 有了它，"打开记事本并输入 123" 才能真闭环，而不是退化成"复制到剪贴板，请用户自己粘贴"。
  if (process.platform === "win32") {
    add(
      { name: "send_keys", mutating: true },
      {
        type: "function",
        function: {
          name: "send_keys",
          description:
            "向 Windows 窗口发送键盘输入，驱动图形界面程序。必须指定 pid（推荐，取自 run_command 的「窗口进程」）或 window（标题关键词）。" +
            "text 按字面输入；按键与快捷键用 keys（{ENTER} {TAB} {ESC} ^s=Ctrl+S ^a=全选 %{F4}=Alt+F4）。两者可同时给，先 text 后 keys。" +
            "在保存对话框里填路径必须用反斜杠格式（C:\\dir\\file.txt）。",
          parameters: {
            type: "object",
            properties: {
              pid: { type: "integer", description: "目标窗口进程号，推荐" },
              window: { type: "string", description: "窗口标题关键词，未给 pid 时使用" },
              text: { type: "string", description: "要输入的字面文本，换行转为回车" },
              keys: { type: "string", description: "按键序列，如 {ENTER}、^s" },
              delay_ms: { type: "integer", description: "激活后等待毫秒数，默认 400" },
            },
            additionalProperties: false,
          },
        },
      },
      async (args) => {
        const rawPid = Number(args.pid);
        const pid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : null;
        const window = args.window ? String(args.window) : null;
        if (!pid && !window) {
          return "错误：必须指定 pid 或 window，否则无法确定输入目标。可先用 run_command 启动程序（返回「窗口进程」），或执行 tasklist /v 查询窗口标题。";
        }
        const text = args.text == null ? "" : String(args.text);
        const keys = args.keys == null ? "" : String(args.keys);
        if (!text && !keys) return "错误：text 与 keys 至少要提供一个。";

        const delay = Math.max(0, Math.min(Number(args.delay_ms) || 400, 10000));
        const q = s => `'${String(s).replace(/'/g, "''")}'`;

        const targetLine = pid
          ? `$target=Get-Process -Id ${pid} -ErrorAction SilentlyContinue`
          : `$kw=${q(window)}; $target=Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.IndexOf($kw,[System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1`;

        const r = await runPwsh([
          "$ErrorActionPreference='Stop'",
          "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
          "$cs=@'",
          TYPER_CS,
          "'@",
          // 编译结果缓存到临时目录，避免每次调用都重编译（首次约 1-2 秒）。
          // 文件名带源码哈希——否则改了 C# 代码仍会加载旧 DLL，改动静默不生效。
          `$dll=Join-Path $env:TEMP 'AgentCliTyper.${TYPER_HASH}.dll'`,
          "$fresh=$false",
          "if (Test-Path $dll) { try { Add-Type -Path $dll -ErrorAction Stop } catch { Add-Type -TypeDefinition $cs -Language CSharp; $fresh=$true } }",
          "else { try { Add-Type -TypeDefinition $cs -Language CSharp -OutputAssembly $dll -ErrorAction Stop | Out-Null; Add-Type -Path $dll; $fresh=$true } catch { Add-Type -TypeDefinition $cs -Language CSharp } }",
          // 源码哈希一变就会留下上一版 DLL；只在真的重新编译时清理，
          // 否则每次调用都要枚举一遍临时目录，反而拖慢缓存命中的常规路径。
          "if ($fresh) { Get-ChildItem -Path (Join-Path $env:TEMP 'AgentCliTyper.*.dll') -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne (Split-Path $dll -Leaf) } | Remove-Item -Force -ErrorAction SilentlyContinue }",
          // 前台锁定与键盘注入的 API 都已在上面那个编译单元里，无需再单独 Add-Type
          "$target=$null",
          targetLine,
          "if ($null -eq $target) { Write-Output 'AGENT_ERR:NOTFOUND'; exit 3 }",
          "$title=$target.MainWindowTitle",
          "if (-not $title) { Write-Output 'AGENT_ERR:NOWINDOW'; exit 5 }",
          "$h=$target.MainWindowHandle",
          "if ([AgentTyper]::IsIconic($h)) { [AgentTyper]::ShowWindow($h,9) | Out-Null }",
          // 优先以"当前弹出的对话框"为输入目标：主窗口开着「另存为」时，按键必须进对话框，
          // 发到主窗口只会把路径当成正文内容输入，看起来成功但什么也没保存。
          "function PickTarget {",
          "  $lp=[AgentTyper]::GetLastActivePopup($h)",
          "  if ($lp -ne [System.IntPtr]::Zero -and $lp -ne $h) { return $lp }",
          "  return $h",
          "}",
          "function IsReady {",
          "  $tw=PickTarget",
          "  $fg=[AgentTyper]::GetForegroundWindow()",
          "  if ($fg -eq $tw) { return $true }",
          "  $dd=0",
          "  [AgentTyper]::GetWindowThreadProcessId($fg,[ref]$dd) | Out-Null",
          "  if ($dd -eq $target.Id -and $tw -eq $h) { return $true }",
          "  return $false",
          "}",
          // 前台被别的程序占着时，用 AttachThreadInput 临时并入前台线程再抢，
          // 否则后台进程的 SetForegroundWindow 会被 Windows 前台锁定直接拒绝。
          // 抢前台会被系统"前台锁定"间歇性拒绝，单次尝试并不可靠，必须重试。
          "$attached=$false",
          "$tries=0",
          "while (-not (IsReady) -and $tries -lt 5) {",
          "  if (-not $attached) {",
          "    $d2=0",
          "    $ft=[AgentTyper]::GetWindowThreadProcessId([AgentTyper]::GetForegroundWindow(),[ref]$d2)",
          "    $ct=[AgentTyper]::GetCurrentThreadId()",
          "    $attached=[AgentTyper]::AttachThreadInput($ct,$ft,$true)",
          "  }",
          "  $tw=PickTarget",
          "  [AgentTyper]::BringWindowToTop($tw) | Out-Null",
          "  [AgentTyper]::SetForegroundWindow($tw) | Out-Null",
          "  Start-Sleep -Milliseconds 300",
          "  $tries++",
          "}",
          // 必须确认输入目标确实在前台：否则按键会打进无关窗口，可能触发意料之外的操作
          "if (-not (IsReady)) { Write-Output 'AGENT_ERR:ACTIVATE'; exit 4 }",
          `Start-Sleep -Milliseconds ${delay}`,
          // 输入前再确认一次：激活与真正注入之间若被别的程序抢走前台，按键会打错窗口
          "if (-not (IsReady)) { Write-Output 'AGENT_ERR:ACTIVATE'; exit 4 }",
          text ? `[AgentTyper]::TypeText(${q(text)}, 15)` : "",
          keys ? `[AgentTyper]::TypeKeys(${q(keys)}, 25)` : "",
          // 等事件真正分发到位再撤出：SendInput 是异步的，过早解除附属关系或退出进程会造成尾部丢字。
          // 实测 150ms 仍会丢末尾几个字符，放宽到 500ms。
          "Start-Sleep -Milliseconds 500",
          "if ($attached) { $ct2=[AgentTyper]::GetCurrentThreadId(); [AgentTyper]::AttachThreadInput($ct2,$ft,$false) | Out-Null }",
          "Write-Output ('AGENT_OK:' + $target.Id + '|' + $title)",
        ].filter(Boolean), 60000);

        const errLine = String(r.out).split(/\r?\n/).find(l => l.startsWith("AGENT_ERR:"));
        if (errLine === "AGENT_ERR:NOTFOUND") {
          return pid
            ? `未找到 PID ${pid} 的进程（可能已退出）。若刚用 run_command 启动，请改用返回信息里的「窗口进程」PID。`
            : `未找到标题包含「${window}」的窗口。可用 run_command 执行 tasklist /v 查看现有窗口标题。`;
        }
        if (errLine === "AGENT_ERR:NOWINDOW") return `PID ${pid} 的进程没有可见主窗口（可能是控制台程序，或窗口已最小化到托盘）。`;
        if (errLine === "AGENT_ERR:ACTIVATE") {
          return "无法把目标窗口切到前台（被 Windows 前台锁定拒绝，重试多次仍失败）。请用鼠标点一下该窗口，再让我重试一次即可继续。";
        }
        if (r.failed) {
          const detail = String(r.err).split(/\r?\n/).filter(Boolean).slice(0, 3).join(" ").slice(0, 300);
          return `输入失败：PowerShell 执行异常。${detail}`;
        }

        const okLine = String(r.out).split(/\r?\n/).find(l => l.startsWith("AGENT_OK:"));
        if (!okLine) return `输入结果未知。原始输出：${String(r.out).slice(0, 300)}`;
        const [okPid, ...rest] = okLine.slice("AGENT_OK:".length).split("|");
        const shown = text.length > 60 ? `${text.slice(0, 60)}…` : text;
        const parts = [];
        if (text) parts.push(`文本「${shown}」`);
        if (keys) parts.push(`按键序列 ${keys}`);
        return `已向窗口「${rest.join("|")}」(PID ${okPid}) 输入：${parts.join("，")}`;
      }
    );
  }

  if (cfg.tools.enableFetch) {
    add(
      { name: "fetch_url", mutating: false, readOnly: true, parallel: true },
      {
        type: "function",
        function: {
          name: "fetch_url",
          description:
            "抓取网页或接口并转为纯文本（仅 http/https）。HTML 转成带链接的文本（链接以 <URL> 保留，可继续跟进）；中文 URL 自动编码。" +
            "多数站点用默认 UA；个别站点（如 wttr.in）需传 user_agent=\"curl/8.4.0\" 才返回纯文本。",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "目标 URL，中文无需编码" },
              max_chars: { type: "integer", description: "返回最大字符数，默认 12000" },
              user_agent: { type: "string", description: "自定义 UA，可选" },
            },
            required: ["url"],
            additionalProperties: false,
          },
        },
      },
      async (args) => {
        let url = String(args.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return "错误：仅支持 http/https URL。";
        // URL 里的中文等非 ASCII 字符必须百分号编码，否则不少服务器直接 400/404。
        // encodeURI 只编码非 ASCII 与空格，保留 ? & # = 等结构字符，正合适。
        if (/[^\x21-\x7E]/.test(url)) url = encodeURI(url);
        const max = Math.min(args.max_chars || 12000, cfg.tools.maxOutputChars);
        const hint = "若目标信息不在这里，请**加大 max_chars** 重取同一地址——改小 max_chars 或重复抓取都不会产生不同内容。";

        const ua = args.user_agent ? String(args.user_agent) : "Mozilla/5.0 (compatible; AgentCLI/1.2)";
        const cacheKey = `${url}\u0000${ua}`;
        const hit = fetchCacheGet(cacheKey);

        let status, ctype, body, jumped, reused = "";
        if (hit) {
          ({ status, ctype, body, jumped } = hit);
          reused = `（本地址 ${Math.round((Date.now() - hit.ts) / 1000)} 秒内已抓取过，内容完全相同，无需再抓）\n`;
        } else {
          const resp = await fetch(url, { headers: { "User-Agent": ua }, signal: AbortSignal.timeout(45000), redirect: "follow" });
          status = resp.status;
          ctype = resp.headers.get("content-type") || "";
          // 响应体上限：避免拉取超大页面把内存和上下文一起打爆
          const MAX_BYTES = 5 * 1024 * 1024;
          const declared = Number(resp.headers.get("content-length") || 0);
          if (declared > MAX_BYTES) return `错误：响应过大（${(declared / 1048576).toFixed(1)} MB，上限 5 MB）。`;
          let text = await resp.text();
          if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES) + "\n…（响应体过大，已截断）";
          body = /json|xml|text\/plain|javascript/i.test(ctype) ? text : htmlToText(text, resp.url || url);
          // 跟随重定向后地址可能变化，回报出来便于判断是否被跳转到了别处
          jumped = resp.url && resp.url !== url ? `\n最终地址: ${resp.url}` : "";
          fetchCacheSet(cacheKey, { status, ctype, body, jumped });
        }
        return truncate(`[HTTP ${status} ${ctype}]${jumped}\n${reused}${body}`, max, hint);
      }
    );
  }

  if (skills) {
    add(
      { name: "list_skills", mutating: false, readOnly: true },
      {
        type: "function",
        function: {
          name: "list_skills",
          description: "列出本机所有技能及其用途说明。不确定该用哪个技能时先调用它。",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      async () => {
        const all = skills.list();
        if (!all.length) return "本机未安装任何技能。";
        return all.map(s => `- ${s.name}: ${s.description}`).join("\n");
      }
    );

    add(
      { name: "use_skill", mutating: false, readOnly: true },
      {
        type: "function",
        function: {
          name: "use_skill",
          description: "加载指定技能的完整操作指令，加载后严格按其中步骤执行。不清楚技能名时先用 list_skills 查看。",
          parameters: {
            type: "object",
            properties: { name: { type: "string", description: "技能名称" } },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      async (args) => {
        const r = skills.load(args.name);
        return r.content;
      }
    );
  }

  add(
    { name: "update_plan", mutating: false, readOnly: true },
    {
      type: "function",
      function: {
        name: "update_plan",
        description: "维护任务计划清单；多步任务先列步骤，完成后更新状态。",
        parameters: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              description: "完整步骤清单",
              items: {
                type: "object",
                properties: {
                  step: { type: "string" },
                  status: { type: "string", enum: ["pending", "in_progress", "done"] },
                },
                required: ["step", "status"],
              },
            },
          },
          required: ["steps"],
          additionalProperties: false,
        },
      },
    },
    async (args) => {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      onPlan?.(steps);
      const done = steps.filter(s => s.status === "done").length;
      return `计划已更新：${done}/${steps.length} 完成\n` + steps.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join("\n");
    }
  );

  return tools;
}

export function toSchemas(toolList) {
  return toolList.map(t => t.schema);
}

export function findTool(toolList, name) {
  return toolList.find(t => t.name === name) ?? null;
}

export { truncate, safeResolve, walk, isBinary };
