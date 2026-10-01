// 会话持久化与审计日志
import fs from "node:fs";
import path from "node:path";

export class Session {
  constructor(cfg, name = "") {
    this.cfg = cfg;
    this.dir = cfg.sessionDir;
    this.name = name || `session-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.messages = [];
    this.stats = { turns: 0, steps: 0, promptTokens: 0, completionTokens: 0, asked: 0, denied: 0 };
  }

  get file() { return path.join(this.dir, `${this.name}.json`); }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.updatedAt = new Date().toISOString();
      fs.writeFileSync(this.file, JSON.stringify({
        name: this.name, createdAt: this.createdAt, updatedAt: this.updatedAt,
        stats: this.stats, messages: this.messages,
      }, null, 2), "utf8");
      return true;
    } catch { return false; }
  }

  static load(cfg, name) {
    const file = path.join(cfg.sessionDir, `${name}.json`);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const s = new Session(cfg, data.name);
    s.createdAt = data.createdAt; s.updatedAt = data.updatedAt;
    s.messages = data.messages ?? [];
    s.stats = data.stats ?? s.stats;
    return s;
  }

  static list(cfg) {
    let files = [];
    try { files = fs.readdirSync(cfg.sessionDir).filter(f => f.endsWith(".json")); } catch { return []; }
    const out = [];
    for (const f of files) {
      const full = path.join(cfg.sessionDir, f);
      const item = { name: f.replace(/\.json$/, ""), msgs: 0, turns: 0, updatedAt: "", size: 0 };
      // 逐文件独立容错：早先用一整个 try 包住 map，任何一个会话文件损坏都会让列表整体返回空，
      // 表现成"所有历史会话突然都没了"。
      try {
        const st = fs.statSync(full);
        item.size = st.size;
        item.updatedAt = st.mtime.toISOString();
        // 超大文件不解析内容，只保留文件层面的信息（避免为列个表把整个会话读进内存）
        if (st.size <= 4 * 1024 * 1024) {
          const data = JSON.parse(fs.readFileSync(full, "utf8"));
          item.msgs = (data.messages ?? []).length;
          item.turns = data.stats?.turns ?? 0;
          if (data.updatedAt) item.updatedAt = data.updatedAt;
        }
      } catch { /* 跳过这个文件，继续列其它的 */ }
      out.push(item);
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /** 只按修改时间取最新的会话名：不解析任何文件内容。
   *  `--resume` 不带名称时会走这里，早先的实现要解析全部会话文件才能排序。 */
  static latest(cfg) {
    let files = [];
    try { files = fs.readdirSync(cfg.sessionDir).filter(f => f.endsWith(".json")); } catch { return null; }
    let best = null, bestTs = -1;
    for (const f of files) {
      try {
        const ts = fs.statSync(path.join(cfg.sessionDir, f)).mtimeMs;
        if (ts > bestTs) { bestTs = ts; best = f.replace(/\.json$/, ""); }
      } catch { /* 跳过 */ }
    }
    return best;
  }
}

export class AuditLog {
  constructor(file, maxBytes = 5 * 1024 * 1024) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.writes = 0;
  }
  /** 超过上限时轮转为 .1 备份，避免审计日志无限增长（每 200 次写入才 statSync 一次） */
  rotateIfNeeded() {
    if (this.writes++ % 200 !== 0) return;
    try {
      if (fs.statSync(this.file).size < this.maxBytes) return;
      try { fs.rmSync(`${this.file}.1`, { force: true }); } catch { /* 忽略 */ }
      fs.renameSync(this.file, `${this.file}.1`);
    } catch { /* 文件不存在等情况忽略 */ }
  }
  write(entry) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
    } catch { /* 审计失败不影响主流程 */ }
  }
  tail(n = 20) {
    try {
      const lines = fs.readFileSync(this.file, "utf8").trim().split("\n");
      return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }
}
