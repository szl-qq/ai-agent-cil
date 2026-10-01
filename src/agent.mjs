// Agent 主循环：系统提示组装、工具调度、上下文压缩、计划渲染、用量统计
import os from "node:os";
import path from "node:path";
import { chat, estimateTokens } from "./llm.mjs";
import { toSchemas, findTool, truncate } from "./tools.mjs";
import * as ui from "./ui.mjs";

export function buildSystemPrompt({ cfg, skills }) {
  const parts = [
    "你是一个运行在用户本机终端中的高效 CLI Agent，通过调用工具完成任务。",
    "",
    "## 工作准则",
    "1. **先看再改**：改代码前先 read_file；结构不明先用 list_dir / find_files / search_text 探查。",
    "2. **少步高效**：多条只读探测合并成一次 run_command，不要碎步调用。",
    "3. **精确编辑**：优先 edit_file 定点替换，整文件重写才用 write_file。",
    "4. **多步先规划**：步骤 ≥3 时用 update_plan 列计划。",
    "5. **如实汇报**：工具报错就转述原始输出，不编造；做不到就说卡在哪一步。引用的数字必须是读到的原文里有的。",
    "6. **危险操作先说明**：删除/覆盖/关机类会触发授权，先讲意图再做，不要绕道实现。",
    "7. **不要阻塞会话**：GUI 程序与常驻服务必须用 run_command 的 `wait=false` 启动。",
    "8. **「打开」不是「抓取」**：用户说「打开 X 网站」就要用 `start <url>` 真的启动浏览器；只有说「查 / 看 / 获取内容」时才用 fetch_url。",
    "9. **GUI 输入**：run_command 启动（返回的「窗口进程」PID 即输入目标）→ send_keys 输入。关闭优先 `%{F4}`；强杀只能用 `taskkill /PID <进程> /T /F`，**禁止** `taskkill /IM`（会波及用户自己开的同类程序）。保存对话框等细节见 gui-automation 技能。",
    "10. **抓网页**：同一地址只抓一次（重复抓会被提示）；被截断时**加大 max_chars** 重取，不要改小；内容全是导航说明地址形态不对，改用其 API / RSS。细节见 web-research 技能。",
    "11. **不许把活推给用户**：禁止用「已复制到剪贴板，请你自己粘贴」这类方式代替执行。",
    "12. **回答语言**：与用户同语言（默认简体中文），结论先行。",
    "",
    "## 环境",
    `- 操作系统: ${os.type()} ${os.release()} (${process.platform})`,
    `- 工作区: ${cfg.projectRoot}`,
    `- 时间: ${new Date().toLocaleString("zh-CN")}`,
    `- shell: ${process.platform === "win32" ? "cmd.exe（Windows 命令语法，如 dir /b、type、findstr）" : "/bin/sh"}`,
  ];

  const catalog = skills?.catalog?.();
  if (catalog) parts.push("", catalog);

  parts.push(
    "",
    "## 权限模型（预期行为）",
    "普通读写与命令自动放行；删除/覆盖类操作与密钥、凭据、浏览器数据等隐私文件的访问会弹窗请求授权。这是设计如此，不要试图用其它命令变相绕过。"
  );
  return parts.join("\n");
}

export class Agent {
  /**
   * @param {object} deps { cfg, skills, permissions, session, tools, io, audit }
   * io: { printer, spinner, notice, toolCall, toolResult, diff, renderPlan, statusLine }
   */
  constructor(deps) {
    this.cfg = deps.cfg;
    this.skills = deps.skills;
    this.permissions = deps.permissions;
    this.session = deps.session;
    this.audit = deps.audit;
    this.io = deps.io;
    this.tools = deps.tools;
    this.schemas = toSchemas(this.tools);
    this.model = deps.cfg.models[0] ?? "auto";
    this.abortController = null;
    this.plan = [];
    this.lastUsage = { prompt: 0, completion: 0 };
  }

  get systemPrompt() { return buildSystemPrompt({ cfg: this.cfg, skills: this.skills }); }

  /** 确保会话首条为（最新的）系统提示 */
  syncSystemMessage() {
    const sys = { role: "system", content: this.systemPrompt };
    if (this.session.messages[0]?.role === "system") this.session.messages[0] = sys;
    else this.session.messages.unshift(sys);
  }

  /** 上下文压缩：超出阈值时用模型总结历史，仅保留最近若干轮 */
  async compactIfNeeded(force = false) {
    const limitTokens = Math.round(this.cfg.maxContextChars / 2.6);
    const used = estimateTokens(this.session.messages);
    if (!force && used < limitTokens) return false;
    const keep = Math.max(2, this.cfg.keepRecentTurns * 2);
    if (this.session.messages.length <= keep + 1) return false;

    // 保留段的起点必须前移到消息边界：tool 消息必须与它所属的 assistant(tool_calls) 同进同出，
    // 否则压缩后会留下「孤儿 tool 消息」，接口会直接报错。
    let keepIdx = this.session.messages.length - keep;
    while (keepIdx > 1 && this.session.messages[keepIdx]?.role === "tool") keepIdx--;

    const head = this.session.messages[0];
    const recent = this.session.messages.slice(keepIdx);
    const older = this.session.messages.slice(1, keepIdx);
    this.io.notice?.(`上下文约 ${used} tokens，正在压缩 ${older.length} 条历史消息...`);
    try {
      const dump = older.map(m => `[${m.role}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n");
      // 超长时保留首尾：头部通常含任务目标与初始约束，尾部离当前对话最近，中间部分舍弃
      const clipped = dump.length <= 120000
        ? dump
        : `${dump.slice(0, 20000)}\n\n…（中间省略 ${dump.length - 120000} 字符）…\n\n${dump.slice(-100000)}`;
      const { message } = await chat({
        cfg: { ...this.cfg, stream: false },
        messages: [
          { role: "system", content: "你是对话摘要器。把给定的历史对话压缩成结构化中文摘要，保留：用户目标、已确认的事实与结论、已创建/修改的文件路径、未完成的待办、关键命令与结果。不要遗漏文件路径。" },
          { role: "user", content: "历史对话：\n" + clipped },
        ],
        tools: [],
      });
      const summary = message.content || "(摘要为空)";
      this.session.messages = [
        head,
        { role: "user", content: `【此前对话摘要】\n${summary}` },
        { role: "assistant", content: "已了解此前上下文，请继续。" },
        ...recent,
      ];
      this.io.notice?.("上下文已压缩");
      return true;
    } catch (e) {
      this.io.notice?.(`压缩失败，跳过：${e.message.slice(0, 80)}`);
      return false;
    }
  }

  abort() { this.abortController?.abort(); }

  /** 执行一次用户请求（含工具循环） */
  async runTask(userText) {
    this.syncSystemMessage();
    this.session.messages.push({ role: "user", content: userText });
    await this.compactIfNeeded();

    const t0 = Date.now();
    let finalText = "";
    let steps = 0;

    let exhausted = true;

    for (let step = 0; step < this.cfg.maxSteps; step++) {
      steps++;
      const controller = new AbortController();
      this.abortController = controller;
      const printer = new ui.StreamPrinter();

      let result;
      try {
        result = await chat({
          cfg: this.cfg,
          messages: this.session.messages,
          tools: this.schemas,
          model: this.model,
          signal: controller.signal,
          onText: txt => { this.io.spinner?.stop(); printer.write(txt); },
          onReasoning: chars => {
            if (this.io.spinner?.timer) this.io.spinner.label = `推理中 ${chars} 字`;
            // 非 TTY（重定向/管道）下 spinner 不可见，退化为节流心跳，避免长时间无输出
            const now = Date.now();
            if (!this.io.spinner?.timer && now - (this._hbAt ?? 0) > 12000) {
              this._hbAt = now;
              this.io.progress?.(`模型推理中，已输出 ${chars} 字思维链（等待正文）`);
            }
          },
          onNotice: msg => { this.io.spinner?.stop(); this.io.notice?.(msg); this.io.spinner?.start("重试中"); },
        });
      } catch (e) {
        this.io.spinner?.stop();
        throw e;
      }
      this.io.spinner?.stop();
      printer.end();

      const { message, model, usage } = result;
      if (model !== this.model) {
        this.io.notice?.(`已切换到模型 ${model}`);
        this.model = model;
      }
      if (usage) {
        this.lastUsage = { prompt: usage.prompt_tokens ?? 0, completion: usage.completion_tokens ?? 0 };
        this.session.stats.promptTokens += this.lastUsage.prompt;
        this.session.stats.completionTokens += this.lastUsage.completion;
      }

      // 无工具调用 → 结束
      if (!message.tool_calls?.length) {
        this.session.messages.push({ role: "assistant", content: message.content ?? "" });
        finalText = message.content ?? "";
        exhausted = false;
        break;
      }

      // 有工具调用 → 委派给调度器（只读并行、写操作串行、结果按原顺序回写）
      this.session.messages.push({ role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls });
      if (message.content && message.content.trim()) finalText += message.content;

      await this.runToolCalls(message.tool_calls, controller.signal);

      this.session.stats.steps = steps;
      this.session.stats.turns += 1;

      // 每轮都检查一次上下文用量：工具输出是增长最快的一块，
      // 早先只在任务开始时检查一次，长任务会把上下文撑到阈值以上却始终不压缩。
      await this.compactIfNeeded();
    }
    this.abortController = null;

    if (exhausted) {
      this.io.notice?.(`已达单次任务上限 ${this.cfg.maxSteps} 步，任务可能尚未完成。可调大 --max-steps，或直接继续对话让它接着做。`);
    }

    const elapsed = Date.now() - t0;
    this.io.statusLine?.({
      model: this.model, steps, tokens: ui.formatTokens(estimateTokens(this.session.messages)),
      elapsedMs: elapsed, mode: this.cfg.permission.mode,
    });
    this.session.save();
    return { text: finalText.trim(), steps, elapsed, exhausted };
  }

  /** 执行一批工具调用：先串行做权限判定，再把连续只读调用并行执行，写操作保持串行，结果按原顺序回写 */
  async runToolCalls(calls, signal) {
    // ---- 1) 解析参数 + 权限判定（串行，保证授权提示顺序可读）----
    const plan = [];
    for (const call of calls) {
      const name = call.function?.name ?? "unknown";
      let args = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = {}; }

      const tool = findTool(this.tools, name);
      if (!tool) {
        this.io.toolResult?.(`未知工具 ${name}`, false);
        plan.push({ call, content: `未知工具 ${name}。可用工具：${this.tools.map(t => t.name).join(", ")}` });
        continue;
      }

      this.io.toolCall?.(name, args);

      const decision = await this.permissions.decide(name, args);
      if (!decision.allowed) {
        this.io.toolResult?.(`已拒绝：${decision.reason}`, false);
        plan.push({ call, content: `操作被用户拒绝（${decision.reason}）。不要重试同一操作，请改用安全方式，或向用户说明为何需要该操作。` });
        continue;
      }
      plan.push({ call, tool, name, args });
    }
    this.session.stats.asked = this.permissions.stats.asked;
    this.session.stats.denied = this.permissions.stats.denied;

    // ---- 2) 执行：连续的只读工具合并为并行批次；写操作逐个串行 ----
    const jobs = plan.filter(p => p.tool);
    const outputs = new Map();
    let i = 0;
    while (i < jobs.length) {
      if (signal?.aborted) break;
      const group = [jobs[i]];
      if (jobs[i].tool.parallel) {
        let j = i + 1;
        while (j < jobs.length && jobs[j].tool.parallel) { group.push(jobs[j]); j++; }
      }

      if (group.length > 1) {
        this.io.spinner?.start(`并行执行 ${group.length} 个读取操作`);
        const res = await Promise.all(group.map(job => this.execTool(job)));
        this.io.spinner?.stop();
        group.forEach((job, k) => {
          outputs.set(job.call.id, res[k]);
          this.io.toolResult?.(String(res[k].out), res[k].ok, ui.formatDuration(res[k].ms));
        });
      } else {
        const job = group[0];
        this.io.spinner?.start(`执行 ${job.name}`);
        const r = await this.execTool(job);
        this.io.spinner?.stop();
        outputs.set(job.call.id, r);
        this.io.toolResult?.(String(r.out), r.ok, ui.formatDuration(r.ms));
      }
      i += group.length;
    }

    // ---- 3) 按原始顺序回写 tool 消息：并行不改变顺序，tool_call_id 与调用一一对应 ----
    for (const item of plan) {
      const content = item.tool
        ? String(outputs.get(item.call.id)?.out ?? "(因中断未执行)")
        : item.content;
      this.session.messages.push({
        role: "tool",
        tool_call_id: item.call.id,
        content: truncate(content, this.cfg.tools.maxOutputChars),
      });
    }
  }

  /** 执行单个工具，统一捕获异常与计时 */
  async execTool(job) {
    const t0 = Date.now();
    try {
      const out = await job.tool.handler(job.args);
      return { ok: true, out, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, out: `工具执行失败：${e.message}`, ms: Date.now() - t0 };
    }
  }
}
