#!/usr/bin/env node
// 入口：参数处理、依赖装配、交互循环、中断处理
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { SkillRegistry } from "../src/skills.mjs";
import { buildTools, findTool, killRunningChildren } from "../src/tools.mjs";
import { PermissionEngine } from "../src/permissions.mjs";
import { Session, AuditLog } from "../src/session.mjs";
import { Agent } from "../src/agent.mjs";
import { handleCommand, HELP } from "../src/commands.mjs";
import * as ui from "../src/ui.mjs";
import { AbortedError } from "../src/llm.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 版本号单一数据源：直接读 package.json，避免与入口内硬编码值不同步
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version || "0.0.0"; }
  catch { return "0.0.0"; }
})();

function printHelp() {
  console.log(`${ui.t.bCyan("Agent CLI")} v${VERSION}

用法:
  agent [选项]            进入交互模式
  agent -p "任务"         单次执行后退出
  agent --list-sessions   列出历史会话
  agent --resume [名称]   恢复最近/指定会话

选项:
  --model <a,b>       模型候选链（逗号分隔），默认取配置
  --base-url <url>    OpenAI 兼容接口地址
  --api-key <key>     接口密钥（也可用 agent.key 或 AGENT_API_KEY）
  --max-steps <n>     单次任务最大工具循环数
  --retries <n>       每个模型的瞬时故障重试次数
  --timeout <ms>      单次请求超时
  --temperature <f>   采样温度
  --cwd <目录>        改变工作区根目录
  --dir <目录>        会话文件目录
  --session <名称>    指定会话名
  --yolo              全部放行，不做危险操作确认
  --strict            所有写操作都需确认
  --no-stream         关闭流式输出
  --no-color          关闭彩色输出
  --no-markdown       不渲染 Markdown，输出原始文本（便于重定向到日志）
  --verbose           输出详细日志
  -h, --help          帮助

交互模式内输入 /help 查看斜杠命令。`);
}

function buildIO(cfg, { verbose }) {
  return {
    spinner: new ui.Spinner("思考中"),
    notice: msg => (verbose ? ui.info(msg) : console.log(ui.t.gray(`· ${msg}`))),
    progress: msg => console.log(ui.t.gray(`· ${msg}`)),
    toolCall: (name, args) => ui.toolCall(name, args),
    toolResult: (out, ok, meta) => ui.toolResult(out, ok, meta),
    statusLine: info => console.log(ui.statusLine(info)),
  };
}

async function main() {
  const cfg = loadConfig();
  const cli = cfg.cli;
  if (cli.help) { printHelp(); return; }
  if (cli.version) { console.log(VERSION); return; }

  // ---- 技能目录：项目 skill/ > 程序 skill/ > 用户级 ~/.agent-cli/skills ----
  const skillDirs = [
    path.join(cfg.projectRoot, "skill"),
    path.join(cfg.projectRoot, "skills"),
    path.join(PKG_ROOT, "skill"),
    path.join(PKG_ROOT, "skills"),
    path.join(os.homedir(), ".agent-cli", "skills"),
  ].filter((d, i, arr) => fs.existsSync(d) && arr.indexOf(d) === i);
  const skills = new SkillRegistry(skillDirs);

  const audit = new AuditLog(cfg.auditFile);
  const io = buildIO(cfg, cli);

  // ---- 会话 ----
  let session;
  if (cli.listSessions) {
    const all = Session.list(cfg);
    ui.section(`历史会话（${all.length}）`, all.slice(0, 40).map(s => `- ${s.name}  ${s.msgs} 条 / ${s.turns} 轮  ${s.updatedAt.slice(0, 19).replace("T", " ")}`).join("\n") || "(无)");
    return;
  }
  if (cli.resume || cli.continue) {
    const flag = cli.resume || cli.continue;
    const name = typeof flag === "string" ? flag : Session.latest(cfg);
    if (name) {
      try { session = Session.load(cfg, name); ui.info(`已恢复会话 ${name}（${session.messages.length} 条消息）`); }
      catch { ui.warn(`会话 ${name} 不存在，已新建会话`); session = new Session(cfg, cli.session); }
    } else {
      ui.warn("没有可恢复的历史会话，已新建会话");
      session = new Session(cfg, cli.session);
    }
  } else {
    session = new Session(cfg, cli.session);
  }

  // ---- 权限与工具 ----
  const prompt = new ui.Prompt(cfg.historyFile);
  const permissions = new PermissionEngine(cfg, {
    confirm: q => prompt.confirm(q),
    notice: m => ui.info(m),
    audit: entry => audit.write(entry),
  });
  const tools = buildTools(cfg, { skills, onPlan: steps => renderPlan(steps) });
  const agent = new Agent({ cfg, skills, permissions, session, tools, io, audit });

  // Ctrl+C：中断当前请求并终止正在运行的子进程，而非退出进程
  process.on("SIGINT", () => {
    const killed = killRunningChildren();
    if (agent.abortController && !agent.abortController.signal.aborted) {
      agent.abort();
      console.log(`\n${ui.t.yellow(`已请求中断当前任务${killed ? `，并终止 ${killed} 个子进程` : ""}`)}`);
    } else if (killed) {
      console.log(`\n${ui.t.yellow(`已终止 ${killed} 个子进程`)}`);
    } else {
      ui.info("再按一次 Ctrl+C 退出（或输入 /exit）");
    }
  });

  // ---- 单次模式 ----
  if (cli.prompt !== undefined) {
    try {
      io.spinner.start();
      const r = await agent.runTask(cli.prompt);
      if (!r.text) console.log(ui.t.dim("(模型未返回文本内容)"));
      process.exitCode = 0;
    } catch (e) {
      io.spinner.stop();
      if (e instanceof AbortedError) ui.warn("任务已中断");
      else { ui.error(e.message); process.exitCode = 1; }
    } finally {
      prompt.close();
    }
    return;
  }

  // 也支持 agent "任务"（无 -p 的位置参数）
  if (cli._.length) {
    try {
      io.spinner.start();
      await agent.runTask(cli._.join(" "));
    } catch (e) {
      io.spinner.stop();
      ui.error(e.message);
      process.exitCode = 1;
    } finally { prompt.close(); }
    return;
  }

  // ---- 交互模式 ----
  console.log(ui.banner(cfg, VERSION));
  const skillCount = skills.list().length;
  ui.info(`已加载 ${tools.length} 个工具、${skillCount} 个技能${skillCount ? `（${skills.list().map(s => s.name).join(", ")}）` : "（skill 目录为空）"}`);
  console.log(ui.t.gray(`输入任务回车执行；/help 查看命令；Ctrl+C 中断当前任务。`));

  while (true) {
    const line = await prompt.ask();
    if (line === null) break;               // EOF / 关闭
    const text = line.trim();
    if (!text) continue;

    if (text.startsWith("/")) {
      const res = await handleCommand(text, { cfg, agent, session, skills, permissions });
      if (res.exit) break;
      continue;
    }

    try {
      io.spinner.start();
      const r = await agent.runTask(text);
      if (!r.text) console.log(ui.t.dim("(模型未返回文本内容)"));
    } catch (e) {
      io.spinner.stop();
      if (e instanceof AbortedError) ui.warn("任务已中断，可继续输入新任务");
      else ui.error(e.message);
    }
  }

  prompt.close();
  if (session.messages.length > 1) {
    ui.info(session.save() ? `会话已保存: ${session.file}` : "会话保存失败");
  }
  ui.info("再见");
}

function renderPlan(steps) {
  if (!Array.isArray(steps) || !steps.length) return;
  const icon = { done: ui.t.green("✓"), in_progress: ui.t.yellow("▸"), pending: ui.t.gray("○") };
  console.log(ui.t.gray("☰ 计划"));
  steps.slice(0, 12).forEach((s, i) => console.log(`  ${icon[s.status] ?? "○"} ${i + 1}. ${s.step}`));
}

main().catch(e => {
  ui.error(e?.stack ?? String(e));
  process.exit(1);
});
