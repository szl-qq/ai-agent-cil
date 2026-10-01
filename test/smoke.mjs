#!/usr/bin/env node
// 自检脚本：不依赖外部模型，验证技能、权限、工具、会话等核心逻辑
// 用法: node test/smoke.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import assert from "node:assert";

import { SkillRegistry } from "../src/skills.mjs";
import { PermissionEngine, globToRegex } from "../src/permissions.mjs";
import { buildTools, findTool, isGuiLike, killRunningChildren, RUNNING_CHILDREN, exeNameOf, decodeOutput, htmlToText, truncate } from "../src/tools.mjs";
import { Session, AuditLog } from "../src/session.mjs";
import { estimateTokens } from "../src/llm.mjs";
import { loadConfig } from "../src/config.mjs";
import { Agent } from "../src/agent.mjs";

const results = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); results.push(`  ✓ ${name}`); }
  catch (e) { failed++; results.push(`  ✗ ${name}\n      ${e.message}`); }
}

const root = process.cwd();
const cfg = {
  ...loadConfig(["--base-url", "http://127.0.0.1:9/v1"]),
  projectRoot: root,
  tools: { enableFetch: true, commandTimeoutMs: 20000, maxOutputChars: 5000 },
  permission: { mode: "smart", allow: [], deny: ["run_command:*format *"] },
};

// ---------- 技能 ----------
await test("技能注册表：发现、目录、加载、缺失兜底", () => {
  const reg = new SkillRegistry([path.join(root, "skill")]);
  const names = reg.list().map(s => s.name);
  assert.ok(names.includes("project-scan"), "未发现 project-scan");
  assert.ok(names.includes("system-report"), "未发现 system-report");
  assert.ok(names.includes("web-research"), "未发现 web-research");
  assert.ok(names.includes("gui-automation"), "未发现 gui-automation");
  const cat = reg.catalog();
  assert.ok(cat.includes("use_skill") && cat.includes("list_skills"), "catalog 未提示技能工具");
  // 系统提示每轮都要发送，因此只能带技能名，不能带技能描述
  assert.ok(!cat.includes("快速摸清一个陌生代码项目"), "catalog 混入了技能描述，会每轮占用上下文");
  const ok = reg.load("system-report");
  assert.ok(ok.ok && ok.content.includes("系统体检报告"), "技能正文加载失败");
  assert.ok(!reg.load("not-exist").ok, "缺失技能未返回失败态");
});

// ---------- 权限 ----------
await test("权限引擎：默认放行 / 危险拦截 / deny 规则优先", async () => {
  const engine = new PermissionEngine(cfg, { confirm: async () => "n", notice() {}, audit() {} });
  const allow = ["dir /b", "git status", "wmic cpu get name", "tasklist"];
  for (const c of allow) {
    const d = await engine.decide("run_command", { command: c });
    assert.ok(d.allowed, `应放行却拦截: ${c}`);
  }
  const block = ["del /q a.txt", "rd /s /q tmp", "shutdown /s", "taskkill /f /im x.exe", "reg delete HKCU\\X /f"];
  for (const c of block) {
    const d = await engine.decide("run_command", { command: c });
    assert.ok(!d.allowed, `应拦截却放行: ${c}`);
  }
  const denied = await engine.decide("run_command", { command: "format C:" });
  assert.ok(!denied.allowed && denied.reason.includes("deny"), "deny 规则未生效");
});

await test("权限引擎：隐私文件读取需授权、会话级授权生效", async () => {
  const engine = new PermissionEngine(cfg, { confirm: async () => "a", notice() {}, audit() {} });
  const first = await engine.decide("read_file", { path: "agent.key" });
  assert.ok(first.allowed, "同意后应放行");
  assert.ok(engine.sessionGrants.has("read_file"), "会话授权未记录");
  const engine2 = new PermissionEngine(cfg, { confirm: async () => "n", notice() {}, audit() {} });
  const ssh = await engine2.decide("read_file", { path: "C:\\Users\\x\\.ssh\\id_rsa" });
  assert.ok(!ssh.allowed, "隐私文件应拦截");
});

await test("权限引擎：strict 模式拦截普通写操作，yolo 全放行", async () => {
  const strict = new PermissionEngine({ ...cfg, permission: { ...cfg.permission, mode: "strict" } }, { confirm: async () => "n", notice() {}, audit() {} });
  assert.ok(!(await strict.decide("write_file", { path: "new-file.txt" })).allowed, "strict 未拦截写入");
  const yolo = new PermissionEngine({ ...cfg, permission: { ...cfg.permission, mode: "yolo" } }, { confirm: async () => "n", notice() {}, audit() {} });
  assert.ok((await yolo.decide("run_command", { command: "del /q a.txt" })).allowed, "yolo 未放行");
});

// ---------- 工具 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentcli-test-"));
const skillReg = new SkillRegistry([path.join(root, "skill")]);
const tools = buildTools({ ...cfg, projectRoot: tmp }, { skills: skillReg, onPlan: () => {} });
const call = (name, args) => findTool(tools, name).handler(args);

await test("read_file / write_file / edit_file 往返", async () => {
  const p = "demo.txt";
  const w = await call("write_file", { path: p, content: "line1\nline2\nline3\n" });
  assert.ok(w.includes("已写入"), "写入失败: " + w);
  const r = await call("read_file", { path: p });
  assert.ok(r.includes("2| line2"), "读取行号格式不符: " + r.split("\n")[1]);
  const e = await call("edit_file", { path: p, old_string: "line2", new_string: "LINE-TWO" });
  assert.ok(e.includes("已更新"), "编辑失败: " + e);
  assert.ok((await call("read_file", { path: p })).includes("LINE-TWO"), "编辑未生效");
  const dup = await call("edit_file", { path: p, old_string: "line", new_string: "x" });
  assert.ok(dup.includes("匹配到") || dup.includes("未找到"), "多匹配未拒绝: " + dup);
});

await test("list_dir / find_files / search_text", async () => {
  await call("write_file", { path: "sub/a.js", content: "const needle = 1;\n" });
  await call("write_file", { path: "sub/b.txt", content: "needle here\n" });
  const ls = await call("list_dir", { path: ".", depth: 2 });
  assert.ok(ls.includes("sub/") && ls.includes("demo.txt"), "目录列举不完整:\n" + ls);
  const found = await call("find_files", { pattern: "**/*.js" });
  assert.ok(found.includes("a.js"), "通配查找失败: " + found);
  const hits = await call("search_text", { pattern: "needle" });
  assert.ok(hits.split("\n").length >= 2, "内容检索结果不足: " + hits);
});

await test("run_command：普通命令返回输出与退出码", async () => {
  const out = await call("run_command", { command: 'node -e "console.log(process.platform)"' });
  assert.ok(out.includes(process.platform), "命令输出异常: " + out);
  assert.ok(out.includes("[退出码 0]"), "缺少退出码: " + out);
});

await test("run_command：wait=false 后台启动不阻塞，且命令确实被执行", async () => {
  const t0 = Date.now();
  const out = await call("run_command", { command: 'node -e "setTimeout(()=>{},15000)"', wait: false });
  const ms = Date.now() - t0;
  assert.ok(out.includes("已在后台启动"), "未走后台分支: " + out);
  assert.ok(ms < 3000, `后台启动耗时过长: ${ms}ms`);
  killRunningChildren();

  const marker = path.join(os.tmpdir(), `agentcli-bg-${Date.now()}.txt`);
  await call("run_command", { command: `node -e "require('fs').writeFileSync(process.argv[1],'bg-ok')" "${marker.replace(/\\/g, "/")}"`, wait: false });
  await new Promise(r => setTimeout(r, 1500));
  assert.ok(fs.existsSync(marker), "后台命令未真正执行（标记文件缺失）");
  fs.rmSync(marker, { force: true });
});

await test("run_command：GUI 程序自动判定为后台启动", () => {
  for (const c of ["notepad", "mspaint", "chrome https://example.com", "code .", 'start "" notepad']) {
    assert.ok(isGuiLike(c), `未识别为 GUI: ${c}`);
  }
  // shell 不能被误判：否则 powershell -Command "查信息" 会静默进后台、丢失输出
  for (const c of ["node -v", "dir /b", "git status", 'powershell -Command "dir"', "cmd /c echo hi", "pwsh -c 1"]) {
    assert.ok(!isGuiLike(c), `误判为 GUI: ${c}`);
  }
});

await test("run_command：超时终止并给出后台启动提示", async () => {
  const out = await call("run_command", { command: 'node -e "setTimeout(()=>{},20000)"', timeout_ms: 3000 });
  assert.ok(out.includes("已终止") && out.includes("wait=false"), "超时提示不明确: " + out);
});

await test("list_skills 按需返回技能用途（技能描述不进系统提示）", async () => {
  const out = await call("list_skills", {});
  assert.ok(out.includes("web-research") && out.includes("gui-automation"), "技能清单不完整: " + out.slice(0, 150));
  assert.ok(out.split("\n").length >= 4, "应逐个列出技能及其用途: " + out.slice(0, 150));
});

await test("use_skill 工具可加载技能正文", async () => {
  const out = await call("use_skill", { name: "project-scan" });
  assert.ok(out.includes("技能指令开始") && out.includes("项目结构扫描"), "技能加载异常: " + out.slice(0, 120));
});

await test("update_plan 回显计划状态", async () => {
  const out = await call("update_plan", { steps: [{ step: "a", status: "done" }, { step: "b", status: "pending" }] });
  assert.ok(out.includes("1/2 完成"), "计划统计错误: " + out);
});

// ---------- 会话 ----------
await test("会话保存 / 载入 / 列表", () => {
  const dir = path.join(tmp, ".agent-cli/sessions");
  const s = new Session({ sessionDir: dir }, "unit-test");
  s.messages.push({ role: "user", content: "hi" });
  s.stats.turns = 1;
  assert.ok(s.save(), "保存失败");
  const loaded = Session.load({ sessionDir: dir }, "unit-test");
  assert.strictEqual(loaded.messages.length, 1);
  assert.ok(Session.list({ sessionDir: dir }).some(x => x.name === "unit-test"), "列表缺项");
  assert.strictEqual(Session.latest({ sessionDir: dir }), "unit-test");
});

await test("审计日志写入与读取", () => {
  const file = path.join(tmp, ".agent-cli/audit.log");
  const log = new AuditLog(file);
  log.write({ tool: "run_command", args: { command: "del a" }, decision: "n", why: "删除文件" });
  const tail = log.tail(5);
  assert.strictEqual(tail.length, 1);
  assert.strictEqual(tail[0].decision, "n");
});

await test("会话列表：单个损坏文件不影响其它会话（回归修复）", () => {
  const dir = path.join(tmp, ".agent-cli/sessions2");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "good.json"), JSON.stringify({
    name: "good", updatedAt: "2026-01-01T00:00:00Z", stats: { turns: 3 }, messages: [{ role: "user", content: "hi" }],
  }));
  fs.writeFileSync(path.join(dir, "broken.json"), "{ 这不是合法的 JSON");
  const list = Session.list({ sessionDir: dir });
  assert.ok(list.some(x => x.name === "good"), "正常会话未列出: " + JSON.stringify(list));
  assert.ok(list.some(x => x.name === "broken"), "损坏会话的文件信息也应能列出");
  assert.ok(Session.latest({ sessionDir: dir }), "latest 应能返回某个会话名");
});

await test("参数解析：非法数值回退默认值而非静默失效（回归修复）", () => {
  assert.strictEqual(loadConfig(["--max-steps", "abc"]).maxSteps, 25, "非法 maxSteps 应回退默认");
  assert.strictEqual(loadConfig(["--max-steps", "5"]).maxSteps, 5, "合法值应生效");
  assert.strictEqual(loadConfig(["--temperature", "zzz"]).temperature, 0.3, "非法 temperature 应回退默认");
  assert.strictEqual(loadConfig(["--retries", "2"]).retries, 2, "合法 retries 应生效");
});

// ---------- 本次优化新增的回归用例 ----------

await test("glob：双星号模式可匹配根目录文件（回归修复）", async () => {
  await call("write_file", { path: "root-level.js", content: "// root\n" });
  const hit = await call("find_files", { pattern: "**/*.js" });
  assert.ok(hit.includes("root-level.js"), "根目录文件未被 **/*.js 匹配:\n" + hit);
  assert.ok(hit.includes("a.js"), "子目录文件未被匹配:\n" + hit);
});

await test("read_file：目录与缺失文件返回可读错误", async () => {
  const dir = await call("read_file", { path: "sub" });
  assert.ok(dir.includes("是目录"), "目录未给出提示: " + dir);
  const miss = await call("read_file", { path: "__no_such_file__.txt" });
  assert.ok(miss.includes("无法访问"), "缺失文件未给出提示: " + miss);
});

await test("edit_file：拒绝空 old_string 与无变化替换", async () => {
  const empty = await call("edit_file", { path: "demo.txt", old_string: "", new_string: "x" });
  assert.ok(empty.includes("不能为空"), "空 old_string 未被拒绝: " + empty);
  const same = await call("edit_file", { path: "demo.txt", old_string: "line1", new_string: "line1" });
  assert.ok(same.includes("相同"), "无变化替换未被拒绝: " + same);
});

await test("权限引擎：allow/deny 规则覆盖 glob 与 pattern 参数（回归修复）", async () => {
  const allowEngine = new PermissionEngine(
    { ...cfg, permission: { mode: "smart", allow: ["find_files:**/secret/*"], deny: [] } },
    { confirm: async () => "n", notice() {}, audit() {} }
  );
  assert.ok((await allowEngine.decide("find_files", { pattern: "**/secret/*" })).allowed, "allow 未匹配 pattern 参数");

  const denyEngine = new PermissionEngine(
    { ...cfg, permission: { mode: "smart", allow: [], deny: ["search_text:*password*"] } },
    { confirm: async () => "y", notice() {}, audit() {} }
  );
  assert.ok(!(await denyEngine.decide("search_text", { pattern: "*password*" })).allowed, "deny 未匹配 pattern 参数");
});

await test("参数解析：--resume / --continue 的值可选（回归修复）", () => {
  assert.strictEqual(loadConfig(["--resume"]).cli.resume, true);
  assert.strictEqual(loadConfig(["--resume", "my-session"]).cli.resume, "my-session");
  assert.strictEqual(loadConfig(["--continue"]).cli.continue, true);
  assert.strictEqual(loadConfig(["--continue", "abc"]).cli.continue, "abc");
  const plain = loadConfig(["-p", "任务"]);
  assert.strictEqual(plain.cli.prompt, "任务");
  assert.strictEqual(plain.cli.resume, undefined);
});

await test("审计日志：超过上限自动轮转", () => {
  const file = path.join(tmp, ".agent-cli/audit-rotate.log");
  const log = new AuditLog(file, 200);
  for (let i = 0; i < 260; i++) log.write({ tool: "x", args: { i }, decision: "y", why: "test" });
  assert.ok(fs.existsSync(`${file}.1`), "未生成轮转备份");
});

const makeAgent = (toolList, permissions) => new Agent({
  cfg: { ...cfg, models: ["auto"], maxSteps: 5 },
  skills: null,
  permissions,
  session: { messages: [], stats: {} },
  audit: {},
  io: { spinner: { start() {}, stop() {} }, toolCall() {}, toolResult() {} },
  tools: toolList,
});
const fakeTool = (name, ms, parallel) => ({
  name, parallel, schema: { type: "function", function: { name } },
  handler: async () => { await new Promise(r => setTimeout(r, ms)); return name; },
});

await test("agent：连续只读工具并行执行，写操作串行，结果按原顺序回写", async () => {
  const tools = [fakeTool("ro_a", 300, true), fakeTool("ro_b", 300, true), fakeTool("write_x", 200, false)];
  const agent = makeAgent(tools, { decide: async () => ({ allowed: true }), stats: {} });
  const calls = [
    { id: "c1", function: { name: "ro_a", arguments: "{}" } },
    { id: "c2", function: { name: "ro_b", arguments: "{}" } },
    { id: "c3", function: { name: "write_x", arguments: "{}" } },
  ];
  const t0 = Date.now();
  await agent.runToolCalls(calls, null);
  const ms = Date.now() - t0;
  // 只读段 300ms 并行 + 写段 200ms 串行 ≈ 500ms；若全部串行则为 800ms
  assert.ok(ms < 700, `只读工具未并行，耗时 ${ms}ms`);
  assert.deepStrictEqual(agent.session.messages.map(m => m.content), ["ro_a", "ro_b", "write_x"], "回写顺序被打乱");
  assert.deepStrictEqual(agent.session.messages.map(m => m.tool_call_id), ["c1", "c2", "c3"], "tool_call_id 未一一对应");
});

await test("agent：被拒绝的工具调用写回理由且不执行", async () => {
  let executed = false;
  const tools = [{ name: "danger", parallel: false, schema: { type: "function", function: { name: "danger" } }, handler: async () => { executed = true; return "should not run"; } }];
  const agent = makeAgent(tools, { decide: async () => ({ allowed: false, reason: "测试拒绝" }), stats: {} });
  await agent.runToolCalls([{ id: "d1", function: { name: "danger", arguments: "{}" } }], null);
  assert.ok(!executed, "被拒绝的工具仍被执行");
  assert.ok(agent.session.messages[0].content.includes("测试拒绝"), "拒绝理由未回写: " + agent.session.messages[0].content);
});

await test("权限引擎：send_keys 默认需授权（防止绕过命令授权）", async () => {
  const engine = new PermissionEngine(cfg, { confirm: async () => "n", notice() {}, audit() {} });
  const d = await engine.decide("send_keys", { pid: 4242, text: "echo hi" });
  assert.ok(!d.allowed, "send_keys 未要求授权，存在绕过命令授权的风险");

  const yolo = new PermissionEngine({ ...cfg, permission: { ...cfg.permission, mode: "yolo" } }, { confirm: async () => "n", notice() {}, audit() {} });
  assert.ok((await yolo.decide("send_keys", { pid: 4242, text: "x" })).allowed, "yolo 模式应放行 send_keys");
});

await test("send_keys：从命令行安全提取可执行程序名", () => {
  assert.strictEqual(exeNameOf("notepad"), "notepad");
  assert.strictEqual(exeNameOf("notepad file.txt"), "notepad");
  assert.strictEqual(exeNameOf("code ."), "code");
  assert.strictEqual(exeNameOf('start "" notepad'), "notepad");
  assert.strictEqual(exeNameOf('"C:\\Program Files\\App\\app.exe" -x'), "app");
  // 含引号、分号等非安全字符时必须返回空串：该值会被拼进 PowerShell 脚本
  assert.strictEqual(exeNameOf("bad'; Remove-Item C:\\ /r"), "");
  assert.strictEqual(exeNameOf(""), "");
});

if (process.platform === "win32") {
  await test("send_keys：缺少目标时明确报错，不盲目向活动窗口输入", async () => {
    const out = await call("send_keys", { text: "hi" });
    assert.ok(out.includes("必须指定"), "未校验目标窗口: " + out);
    const empty = await call("send_keys", { pid: 999999, text: "", keys: "" });
    assert.ok(empty.includes("至少"), "空输入未校验: " + empty);
  });
}

await test("run_command 输出解码：GBK 中文不再乱码（回归修复）", () => {
  // Windows 内置命令按 GBK 输出；固定按 UTF-8 解码会得到「�ɹ�:」这类乱码
  assert.strictEqual(decodeOutput(Buffer.from([0xb3, 0xc9, 0xb9, 0xa6])), "成功");
  assert.strictEqual(decodeOutput(Buffer.from("自动化测试", "utf8")), "自动化测试");
  assert.strictEqual(decodeOutput(Buffer.alloc(0)), "");
  assert.strictEqual(decodeOutput(null), "");
});

await test("GUI 识别：start <url> 判为 GUI，且不被当作可执行名（回归修复）", () => {
  assert.ok(isGuiLike("start https://www.baidu.com"), "start <url> 未识别为 GUI");
  assert.ok(isGuiLike("https://example.com"), "裸 URL 未识别为 GUI");
  assert.strictEqual(exeNameOf("start https://www.baidu.com"), "", "URL 不应被当作可执行程序名");
  assert.ok(!isGuiLike("node -v"), "普通命令被误判为 GUI");
});

await test("权限：taskkill 按程序名全量强杀需授权（回归修复）", async () => {
  const engine = new PermissionEngine(cfg, { confirm: async () => "n", notice() {}, audit() {} });
  assert.ok(!(await engine.decide("run_command", { command: "taskkill /F /IM firefox.exe" })).allowed, "taskkill /IM 未被拦截");
  assert.ok(!(await engine.decide("run_command", { command: "taskkill /PID 1234 /T /F" })).allowed, "taskkill /F 未被拦截");
  assert.ok((await engine.decide("run_command", { command: "tasklist" })).allowed, "普通进程查询被误拦");
});

await test("fetch_url：HTML 转文本保留链接并补全为绝对地址（回归修复）", () => {
  const html = '<div><a href="/a/b">条目一</a> <a href="https://x.com/c">条目二</a> <a href="#top">锚点</a> <a href="javascript:void(0)">脚本</a></div>';
  const out = htmlToText(html, "https://site.com/root/");
  assert.ok(out.includes("<https://site.com/a/b>"), "相对链接未补全: " + out);
  assert.ok(out.includes("<https://x.com/c>"), "绝对链接未保留: " + out);
  assert.ok(out.includes("条目一") && out.includes("条目二"), "链接文字丢失: " + out);
  assert.ok(out.includes("锚点") && !out.includes("#top"), "锚点应只留文字: " + out);
  assert.ok(!out.includes("javascript:"), "javascript: 链接应被丢弃: " + out);
  assert.ok(!/<div|<a\s/.test(out), "标签未清除: " + out);
});

await test("fetch_url：URL 中的中文自动百分号编码（回归修复）", () => {
  const raw = "https://www.baidu.com/s?wd=今天的天气";
  const expected = "https://www.baidu.com/s?wd=%E4%BB%8A%E5%A4%A9%E7%9A%84%E5%A4%A9%E6%B0%94";
  // 与 fetch_url 内部使用的同一条件与同一函数
  assert.ok(/[^\x21-\x7E]/.test(raw), "非 ASCII 检测失效");
  assert.strictEqual(encodeURI(raw), expected, "编码结果不符");
  assert.ok(!/[^\x21-\x7E]/.test(encodeURI(raw)), "编码后仍含非 ASCII");
  assert.ok(encodeURI(raw).includes("?"), "URL 结构字符不应被编码");
});

await test("fetch_url：剥离导航/页脚/侧栏，避免正文被挤出视野（回归修复）", () => {
  const html = `<body>
    <nav><a href="/a">菜单一</a><a href="/b">菜单二</a></nav>
    <main><p>正文数据：下载量 91105</p><a href="/c">条目</a></main>
    <aside><a href="/d">侧栏链接</a></aside>
    <footer><a href="/e">页脚链接</a></footer>
  </body>`;
  const out = htmlToText(html, "https://x.com/");
  assert.ok(out.includes("91105"), "正文数据丢失: " + out);
  assert.ok(out.includes("<https://x.com/c>"), "正文链接应保留: " + out);
  assert.ok(!out.includes("菜单一"), "nav 内容未剥离: " + out);
  assert.ok(!out.includes("侧栏链接"), "aside 内容未剥离: " + out);
  assert.ok(!out.includes("页脚链接"), "footer 内容未剥离: " + out);
});

await test("截断提示：明确告知后面还有多少字符（回归修复）", () => {
  const out = truncate("x".repeat(500), 100, "请加大 max_chars");
  assert.ok(out.includes("还有 400 字符未显示"), "未告知剩余字符数: " + out.slice(-90));
  assert.ok(out.includes("请加大 max_chars"), "缺少自定义提示语");
  assert.strictEqual(truncate("short", 100), "short", "未超限时不应改动");
});

// ---------- 其他 ----------
await test("token 估算与 glob 转换", () => {
  assert.ok(estimateTokens([{ role: "user", content: "x".repeat(260) }]) === 100);
  assert.ok(globToRegex("run_command:git status*").test("run_command:git status --short"));
  assert.ok(!globToRegex("run_command:git status*").test("run_command:git diff"));
});

// ---------- 收尾 ----------
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows 句柄未释放时忽略，系统会回收临时目录 */ }
process.stdout.write(`\nAgent CLI 自检\n${results.join("\n")}\n\n`);
if (failed) {
  process.stdout.write(`失败 ${failed} 项\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`全部 ${results.length} 项通过\n`);
}
void RUNNING_CHILDREN;
