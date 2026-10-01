// 权限引擎：默认放行；仅危险操作与隐私读取需要确认；支持配置化 allow/deny 与会话级授权
import fs from "node:fs";
import path from "node:path";

const RISKY_COMMAND = [
  { re: /(^|[&|]\s*)(del|erase)\s/i, why: "删除文件" },
  { re: /(^|[&|]\s*)(rd|rmdir|rm)\b/i, why: "删除目录/文件" },
  { re: /\b(remove-item|ri)\b/i, why: "删除文件" },
  { re: /\b(format|diskpart|cipher\s+\/w|vssadmin\s+delete|clear-recyclebin)\b/i, why: "磁盘/回收站级操作" },
  { re: /\breg\s+(delete|restore|backup|import)\b/i, why: "修改注册表" },
  { re: /\b(shutdown|logoff|restart-computer|stop-computer)\b/i, why: "关机/注销系统" },
  { re: /\btaskkill\b[^\n]*\/im\b/i, why: "按程序名强杀全部同类进程（会波及用户自己打开的窗口）" },
  { re: /\btaskkill\b[^\n]*\/f\b/i, why: "强制终止进程" },
  { re: /\b(stop-process|kill)\b[^\n]*-(force|9)\b/i, why: "强制终止进程" },
  { re: /\b(move|mv|ren|rename)\b[^\n]*\b(nul|n\/a|\/dev\/null)\b/i, why: "疑似销毁式移动" },
  { re: />\s*[^\s|]+\.(exe|dll|sys|bat|cmd|ps1)\b/i, why: "覆盖可执行文件" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)/i, why: "破坏性 git 操作" },
  { re: /\b(npm|pnpm|yarn)\s+(publish|unpublish)\b/i, why: "发包操作" },
  { re: /\bcurl\b[^\n]*\|\s*(sh|bash|node|python)\b/i, why: "远程脚本管道执行" },
];

const PRIVACY_TARGET = [
  { re: /(^|[\\/])agent\.key$|(^|[\\/])\.env(\.|$)/i, why: "含密钥的文件" },
  { re: /[\\/]\.ssh[\\/]|[\\/]\.gnupg[\\/]|id_rsa|id_ed25519|\.git-credentials|\.npmrc|\.netrc|\.aws[\\/]credentials/i, why: "SSH/凭据文件" },
  { re: /cookies(\.sqlite)?$|login\s?data$|web\s?data$|key4\.db$|logins\.json$/i, why: "浏览器登录凭据" },
  { re: /appdata[\\/].*?(chrome|firefox|edge|chromium|brave)/i, why: "浏览器用户数据" },
  { re: /wallet|keystore|metamask|\.pem$|\.pfx$|\.p12$/i, why: "密钥/钱包数据" },
  { re: /system32[\\/]config|[\\/]sam$|hklm\\sam/i, why: "系统凭据库" },
  { re: /\b(get-credential|credentialmanager|dpapi|keychain)\b/i, why: "系统凭据读取" },
  { re: /(^|[\\/])\.workbuddy[\\/]|(^|[\\/])\.claude[\\/]|(^|[\\/])\.codebuddy[\\/]/i, why: "AI 工具配置与凭据目录" },
];

export function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

/** 提取工具调用的"操作目标"，用于 allow/deny 规则匹配与风险分类。
 *  覆盖所有带路径/命令/模式语义的参数，避免 find_files、search_text 等工具的规则失配。 */
export function targetOf(args) {
  const a = args ?? {};
  const v = a.command ?? a.path ?? a.glob ?? a.pattern ?? a.cwd ?? a.url ?? a.window ?? a.name ?? "";
  return String(v);
}

export class PermissionEngine {
  /**
   * @param {object} cfg 配置
   * @param {{confirm:(q:string)=>Promise<string>, notice:(s:string)=>void, audit:(entry:object)=>void}} hooks
   */
  constructor(cfg, hooks = {}) {
    this.cfg = cfg;
    this.mode = cfg.permission.mode;         // smart | strict | yolo
    this.allow = (cfg.permission.allow || []).map(globToRegex);
    this.deny = (cfg.permission.deny || []).map(globToRegex);
    this.hooks = hooks;
    this.sessionGrants = new Set();          // 本会话已授权的工具名
    this.stats = { asked: 0, granted: 0, denied: 0, auto: 0 };
  }

  /** 判定风险等级：safe | confirm，附理由 */
  classify(tool, args) {
    const target = targetOf(args);
    if (tool === "run_command") {
      for (const { re, why } of RISKY_COMMAND) if (re.test(target)) return { level: "confirm", why };
      for (const { re, why } of PRIVACY_TARGET) if (re.test(target)) return { level: "confirm", why };
      return { level: "safe", why: "" };
    }
    if (tool === "read_file" || tool === "list_dir" || tool === "search_text" || tool === "find_files") {
      for (const { re, why } of PRIVACY_TARGET) if (re.test(target)) return { level: "confirm", why };
      return { level: "safe", why: "" };
    }
    if (tool === "write_file" || tool === "edit_file") {
      for (const { re, why } of PRIVACY_TARGET) if (re.test(target)) return { level: "confirm", why };
      try {
        if (fs.existsSync(path.resolve(this.cfg.projectRoot, target))) {
          return { level: "confirm", why: "覆盖已存在文件" };
        }
      } catch { /* 忽略 */ }
      return { level: "safe", why: "" };
    }
    if (tool === "fetch_url") return { level: "safe", why: "" };
    // 向 GUI 注入键盘输入等于给了一条绕过命令授权的通道（例如往终端窗口里打删除命令），
    // 因此默认归为需确认；确认一次后可正常连续使用，或在配置 allow 里放行。
    if (tool === "send_keys") {
      return { level: "confirm", why: "向图形界面窗口注入键盘输入" };
    }
    return { level: "safe", why: "" };
  }

  /** 决策：允许 / 拒绝 / 询问 */
  async decide(tool, args) {
    const key = `${tool}:${targetOf(args).slice(0, 200)}`;
    for (const re of this.deny) {
      if (re.test(key) || re.test(tool)) {
        this.stats.denied++;
        this.hooks.audit?.({ tool, args, decision: "deny", why: "命中 deny 规则" });
        return { allowed: false, reason: "命中配置的 deny 规则" };
      }
    }
    for (const re of this.allow) {
      if (re.test(key) || re.test(tool)) {
        this.stats.auto++;
        this.hooks.audit?.({ tool, args, decision: "allow", why: "命中 allow 规则" });
        return { allowed: true };
      }
    }

    if (this.mode === "yolo") { this.stats.auto++; return { allowed: true }; }
    if (this.sessionGrants.has(tool)) { this.stats.auto++; return { allowed: true }; }

    const risk = this.classify(tool, args);
    const needsAsk =
      risk.level === "confirm" ||
      (this.mode === "strict" && ["write_file", "edit_file", "run_command"].includes(tool));
    if (!needsAsk) { this.stats.auto++; return { allowed: true }; }

    this.stats.asked++;
    const why = risk.why || "严格模式：写操作";
    const answer = await this.hooks.confirm?.(`${why} — 需要授权：${tool} ${summarize(args)}`);
    this.hooks.audit?.({ tool, args, decision: answer, why });

    if (answer === "a") {
      this.sessionGrants.add(tool);
      this.stats.granted++;
      this.hooks.notice?.(`本会话内已放行所有 ${tool} 操作`);
      return { allowed: true };
    }
    if (answer === "y" || answer === "yes") { this.stats.granted++; return { allowed: true }; }
    this.stats.denied++;
    return { allowed: false, reason: "用户拒绝了该操作" };
  }
}

function summarize(args) {
  const s = JSON.stringify(args ?? {});
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
}
