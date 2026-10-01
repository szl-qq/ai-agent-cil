// Skill 系统：扫描 skill/ 目录下的 SKILL.md，把 name+description 注入系统提示，模型通过 use_skill 工具加载全文指令
import fs from "node:fs";
import path from "node:path";

/** 极简 frontmatter 解析：仅支持 key: value 标量 */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[k] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

export class SkillRegistry {
  /** @param {string[]} dirs 候选 skill 目录（按优先级） */
  constructor(dirs) {
    this.dirs = dirs.filter(Boolean);
    this.skills = new Map();
    this.reload();
  }

  reload() {
    this.skills.clear();
    for (const dir of this.dirs) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const file = path.join(dir, e.name, "SKILL.md");
        if (!fs.existsSync(file)) continue;
        let raw;
        try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
        const { meta, body } = parseFrontmatter(raw);
        const name = (meta.name || e.name).trim();
        if (this.skills.has(name)) continue; // 高优先级目录先注册
        this.skills.set(name, {
          name,
          dir: e.name,
          description: (meta.description || "").trim() || "(无描述)",
          body: body.trim(),
          file,
        });
      }
    }
    return this.skills;
  }

  list() { return [...this.skills.values()]; }
  has(name) { return this.skills.has(name); }
  get(name) { return this.skills.get(String(name || "").trim()) ?? null; }

  /** 注入系统提示的技能清单。
   *  **只列技能名**：完整用途说明通过 list_skills / use_skill 按需获取。
   *  技能描述动辄上百字符，若每次请求都随系统提示发送，会在整个会话中反复计费，
   *  而绝大多数轮次根本用不到技能——所以这里只保留"有哪些技能"这一最小信息。 */
  catalog() {
    const all = this.list();
    if (!all.length) return "";
    return [
      "## 可用技能（Skills）",
      `本机装有：${all.map(s => s.name).join("、")}。任务与某个技能相关时，先用 list_skills 查看它们的用途，再用 use_skill 加载完整指令。`,
    ].join("\n");
  }

  /** 加载技能全文，作为工具结果回给模型 */
  load(name) {
    const s = this.get(name);
    if (!s) {
      const names = this.list().map(x => x.name).join(", ") || "(无)";
      return { ok: false, content: `技能 "${name}" 不存在。可用技能: ${names}` };
    }
    const assets = [];
    try {
      for (const f of fs.readdirSync(path.dirname(s.file))) {
        if (f !== "SKILL.md") assets.push(f);
      }
    } catch { /* 忽略 */ }
    const content = [
      `技能: ${s.name}`,
      `描述: ${s.description}`,
      `技能目录: ${path.dirname(s.file)}`,
      assets.length ? `附带文件: ${assets.join(", ")}（可用 read_file/run_command 读取执行，路径基于上方技能目录）` : "",
      "",
      "--- 技能指令开始 ---",
      s.body,
      "--- 技能指令结束 ---",
    ].filter(Boolean).join("\n");
    return { ok: true, content };
  }
}
