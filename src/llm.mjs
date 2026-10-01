// LLM 客户端：SSE 流式解析 + tool_call 增量拼接 + 候选链降级 + 瞬时故障指数退避重试
const RETRYABLE = /(HTTP 429|HTTP 5\d\d|fetch failed|timeout|timed out|idle timeout|terminated|ECONNRESET|ECONNREFUSED|socket hang up|aborted by server)/i;

export class AbortedError extends Error {
  constructor() { super("已中断"); this.name = "AbortedError"; }
}

export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.round(chars / 2.6); // 中文占比较高，按 2.6 字符/token 粗估
}

function sleep(ms, signal) {
  return new Promise((res, rej) => {
    const timer = setTimeout(res, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(timer); rej(new AbortedError()); };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** 合并流式 tool_call 增量（按 index 组装 id/name/arguments） */
function mergeToolCallDelta(acc, deltas) {
  for (const d of deltas || []) {
    const idx = d.index ?? acc.length;
    if (!acc[idx]) acc[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
    const slot = acc[idx];
    if (d.id) slot.id = d.id;
    if (d.type) slot.type = d.type;
    if (d.function?.name) slot.function.name += d.function.name;
    if (d.function?.arguments) slot.function.arguments += d.function.arguments;
  }
}

/** 空闲看门狗：超过 ms 没有收到任何数据就中止请求；外部中断优先 */
function makeIdleWatchdog(ms, outerSignal) {
  const ctrl = new AbortController();
  let fired = false;
  let timer = null;
  const onOuter = () => ctrl.abort();
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort();
    else outerSignal.addEventListener("abort", onOuter, { once: true });
  }
  const bump = () => {
    clearTimeout(timer);
    if (ms > 0) timer = setTimeout(() => { fired = true; ctrl.abort(); }, ms);
  };
  bump();
  return {
    get signal() { return ctrl.signal; },
    bump,
    get fired() { return fired; },
    get outerAborted() { return !!outerSignal?.aborted; },
    dispose() { clearTimeout(timer); outerSignal?.removeEventListener("abort", onOuter); },
  };
}

/** 合并多个 signal：任一 abort 即 abort。优先用原生 AbortSignal.any，缺失时手动桥接，
 *  避免退化为只监听第一个 signal 而丢掉超时。 */
function combineSignals(signals) {
  const valid = signals.filter(Boolean);
  if (valid.length === 1) return valid[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(valid);
  const ctrl = new AbortController();
  for (const s of valid) {
    if (s.aborted) { ctrl.abort(s.reason); break; }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

/** 单次请求（流式或非流式），返回 { message, usage, finishReason } */
async function requestOnce({ cfg, messages, tools, model, signal, onText, onReasoning }) {
  const idle = makeIdleWatchdog(cfg.idleTimeoutMs ?? 0, signal);

  try {
    return await requestOnceInner({ cfg, messages, tools, model, idle, onText, onReasoning, timeoutMs: cfg.timeoutMs });
  } catch (e) {
    if (idle.outerAborted) {
      const err = new Error("用户中断");
      err.name = "AbortError";
      throw err;
    }
    if (idle.fired) throw new Error(`idle timeout: ${Math.round((cfg.idleTimeoutMs ?? 0) / 1000)}s 内未收到任何数据`);
    throw e;
  } finally {
    idle.dispose();
  }
}

async function requestOnceInner({ cfg, messages, tools, model, idle, onText, onReasoning, timeoutMs }) {
  const useTools = tools && tools.length ? tools : undefined;
  const body = {
    model,
    messages,
    temperature: cfg.temperature,
    ...(useTools ? { tools: useTools, tool_choice: "auto" } : {}),
    ...(cfg.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };

  // 组合信号：空闲看门狗 + 整体超时
  const signals = [idle.signal];
  if (timeoutMs > 0 && typeof AbortSignal.timeout === "function") signals.push(AbortSignal.timeout(timeoutMs));
  const requestSignal = combineSignals(signals);

  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: cfg.stream ? "text/event-stream" : "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: requestSignal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 400)}`);
  }

  if (!cfg.stream) {
    const data = await resp.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("响应缺少 choices");
    if (msg.content && onText) onText(msg.content);
    return { message: msg, usage: data.usage ?? null, finishReason: data.choices[0].finish_reason ?? null };
  }

  // ---- SSE 解析 ----
  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let content = "";
  const toolCalls = [];
  let usage = null;
  let finishReason = null;
  let role = "assistant";
  let reasoningChars = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    idle.bump();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.role) role = delta.role;
      // 部分推理模型会先输出 reasoning_content（思维链），只做进度提示，不并入正文
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        reasoningChars += delta.reasoning_content.length;
        if (onReasoning) onReasoning(reasoningChars);
      }
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        if (onText) onText(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) mergeToolCallDelta(toolCalls, delta.tool_calls);
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  const message = { role };
  if (content) message.content = content;
  const clean = toolCalls.filter(Boolean).map(tc => ({
    id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
    type: "function",
    function: { name: tc.function.name, arguments: tc.function.arguments || "{}" },
  }));
  if (clean.length) message.tool_calls = clean;
  if (!message.content && !clean.length) message.content = "";
  return { message, usage, finishReason };
}

/**
 * 带候选链与重试的对话调用。
 * @returns {Promise<{message:object, model:string, usage:object|null}>}
 */
export async function chat({ cfg, messages, tools, model: forcedModel, signal, onText, onNotice, onReasoning }) {
  const chain = forcedModel
    ? cfg.models.slice(Math.max(0, cfg.models.indexOf(forcedModel)))
    : cfg.models;
  const models = chain.length ? chain : ["auto"];
  let lastErr = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= Math.max(1, cfg.retries); attempt++) {
      if (signal?.aborted) throw new AbortedError();
      try {
        const { message, usage } = await requestOnce({ cfg, messages, tools, model, signal, onText, onReasoning });
        return { message, model, usage };
      } catch (e) {
        if (e.name === "AbortError" || e instanceof AbortedError) throw new AbortedError();
        lastErr = e;
        const transient = RETRYABLE.test(e.message);
        if (transient && attempt < cfg.retries) {
          const wait = Math.min(20000, 2500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 700);
          onNotice?.(`模型 ${model} 第 ${attempt} 次失败（${e.message.slice(0, 90)}），${(wait / 1000).toFixed(1)}s 后重试`);
          await sleep(wait, signal);
        } else {
          onNotice?.(`模型 ${model} 失败：${e.message.slice(0, 140)}${models.length > 1 ? "，切换下一个候选" : ""}`);
          break;
        }
      }
    }
  }
  throw lastErr ?? new Error("模型候选链全部失败");
}

/** 拉取网关可用模型列表 */
export async function listModels(cfg) {
  const resp = await fetch(`${cfg.baseUrl}/models`, {
    headers: { ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.data ?? []).map(m => m.id).sort();
}
