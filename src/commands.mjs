// 斜杠命令
import { listModels, estimateTokens } from "./llm.mjs";
import { Session } from "./session.mjs";
import * as ui from "./ui.mjs";

export const HELP = `可用命令：
  /help                 显示本帮助
  /model <名称>         切换模型（支持 "a,b" 形式的候选链）
  /models [关键词]      列出网关可用模型
  /skills               列出已加载技能
  /skill <名称>         查看技能完整指令
  /tools                列出可用工具
  /permissions          查看权限模式与会话授权
  /yolo | /strict | /smart  切换权限模式
  /compact              立即压缩上下文
  /clear                清空当前会话上下文（保留系统提示）
  /session              查看当前会话信息
  /session save [名]    保存会话
  /session list         列出历史会话
  /session load <名>    载入会话
  /cost                 查看 token 用量统计
  /config               查看当前生效配置
  /reload               重新加载 skill 目录
  /exit                 退出`;

export async function handleCommand(line, ctx) {
  const [cmd, ...rest] = line.trim().slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  const { cfg, agent, session, skills } = ctx;

  switch (cmd) {
    case "help": case "?": ui.section(HELP); return { handled: true };
    case "exit": case "quit": case "q": return { handled: true, exit: true };

    case "model": {
      if (!arg) { ui.info(`当前模型链: ${cfg.models.join(" → ")}`); return { handled: true }; }
      const models = arg.split(",").map(s => s.trim()).filter(Boolean);
      cfg.models = models;
      agent.model = models[0];
      ui.success(`模型链已切换: ${models.join(" → ")}`);
      return { handled: true };
    }

    case "models": {
      try {
        const all = await listModels(cfg);
        const filtered = arg ? all.filter(m => m.toLowerCase().includes(arg.toLowerCase())) : all;
        ui.section(`网关可用模型（${filtered.length}/${all.length}）`, filtered.slice(0, 80).join("\n") + (filtered.length > 80 ? `\n…还有 ${filtered.length - 80} 个` : ""));
      } catch (e) { ui.error(`获取模型列表失败: ${e.message}`); }
      return { handled: true };
    }

    case "skills": {
      const all = skills.list();
      if (!all.length) { ui.warn(`skill 目录为空。可用目录：${skills.dirs.join(" , ")}`); return { handled: true }; }
      ui.section(`已加载技能（${all.length}）`, all.map(s => `- ${s.name}: ${s.description}`).join("\n"));
      return { handled: true };
    }

    case "skill": {
      const s = skills.get(arg);
      if (!s) { ui.error(`技能不存在: ${arg}`); return { handled: true }; }
      ui.section(`${s.name}  (${s.file})`, s.body.slice(0, 4000));
      return { handled: true };
    }

    case "tools": {
      ui.section(`可用工具（${agent.tools.length}）`, agent.tools.map(t => `- ${t.name}${t.mutating ? ui.t.magenta(" [写]") : ""}`).join("\n"));
      return { handled: true };
    }

    case "permissions": {
      const p = ctx.permissions;
      ui.section("权限", [
        `模式: ${p.mode}`,
        `已放行（会话级）: ${[...p.sessionGrants].join(", ") || "(无)"}`,
        `allow 规则: ${cfg.permission.allow.join(", ") || "(无)"}`,
        `deny 规则: ${cfg.permission.deny.join(", ") || "(无)"}`,
        `统计: 自动 ${p.stats.auto} / 询问 ${p.stats.asked} / 授权 ${p.stats.granted} / 拒绝 ${p.stats.denied}`,
      ].join("\n"));
      return { handled: true };
    }

    case "yolo": cfg.permission.mode = "yolo"; ctx.permissions.mode = "yolo"; ui.warn("权限模式: yolo（全部放行，危险操作不再确认）"); return { handled: true };
    case "strict": cfg.permission.mode = "strict"; ctx.permissions.mode = "strict"; ui.info("权限模式: strict（所有写操作都需确认）"); return { handled: true };
    case "smart": cfg.permission.mode = "smart"; ctx.permissions.mode = "smart"; ui.info("权限模式: smart（仅危险/隐私操作需确认）"); return { handled: true };

    case "compact": {
      const done = await agent.compactIfNeeded(true);
      ui.info(done ? "上下文已压缩" : "当前上下文无需压缩");
      return { handled: true };
    }

    case "clear": {
      agent.session.messages = agent.session.messages.slice(0, 1);
      ui.success("会话上下文已清空");
      return { handled: true };
    }

    case "session": {
      const [sub, name] = arg.split(/\s+/);
      if (!sub) {
        ui.section("当前会话", [
          `名称: ${session.name}`,
          `消息数: ${session.messages.length}`,
          `轮次: ${session.stats.turns}  步骤: ${session.stats.steps}`,
          `上下文约: ${estimateTokens(session.messages)} tokens`,
          `文件: ${session.file}`,
        ].join("\n"));
        return { handled: true };
      }
      if (sub === "save") {
        if (name) session.name = name;
        ui.info(session.save() ? `已保存: ${session.file}` : "保存失败");
        return { handled: true };
      }
      if (sub === "list") {
        const all = Session.list(cfg);
        ui.section(`历史会话（${all.length}）`, all.slice(0, 30).map(s => `- ${s.name}  ${s.msgs} 条 / ${s.turns} 轮  ${s.updatedAt.slice(0, 19).replace("T", " ")}`).join("\n") || "(无)");
        return { handled: true };
      }
      if (sub === "load") {
        if (!name) { ui.error("用法: /session load <名称>"); return { handled: true }; }
        try {
          const loaded = Session.load(cfg, name);
          agent.session = loaded;
          ui.success(`已载入会话 ${name}（${loaded.messages.length} 条消息）`);
        } catch (e) { ui.error(`载入失败: ${e.message}`); }
        return { handled: true };
      }
      ui.error(`未知子命令: ${sub}`);
      return { handled: true };
    }

    case "cost": {
      const st = session.stats;
      ui.section("Token 用量", [
        `本轮请求: 输入 ${agent.lastUsage.prompt} / 输出 ${agent.lastUsage.completion}`,
        `会话累计: 输入 ${st.promptTokens} / 输出 ${st.completionTokens}`,
        `估算上下文: ${estimateTokens(session.messages)} tokens`,
      ].join("\n"));
      return { handled: true };
    }

    case "config": {
      const { apiKey, cli, projectRoot, ...rest } = cfg;
      ui.section("生效配置", JSON.stringify({ ...rest, apiKey: apiKey ? "***已设置***" : "(未设置)" }, null, 2));
      return { handled: true };
    }

    case "reload": {
      skills.reload();
      agent.syncSystemMessage();
      ui.success(`技能已重新加载（${skills.list().length} 个）`);
      return { handled: true };
    }

    default:
      ui.error(`未知命令 /${cmd}，输入 /help 查看帮助`);
      return { handled: true };
  }
}
