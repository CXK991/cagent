// Pure-JS agent loop: chat -> tool_calls -> execute Obsidian tools -> repeat
// until the model answers with plain text or max iterations is reached.

import { App } from "obsidian";
import { applySlidingWindow, chatCompletion, compactToolRounds, sanitizeMessages, ChatMessage } from "./openai";
import { buildObsidianTools, Tool } from "./tools";
import { ensureAgentWorkspace, loadMemory, listSkills } from "./memory";
import { validateArgs } from "./validate";
import type { ConsentManager } from "./consent";
import type { UndoManager } from "./undo";
import type { AgentSettings } from "./settings";

export interface AgentEvent {
  type: "tool_call" | "tool_result" | "assistant" | "thinking" | "error" | "usage";
  name?: string;
  content: string;
  /** Token/cache usage from the last completion (forwarded for the UI). */
  usage?: { cache_hit_tokens?: number; cache_miss_tokens?: number; prompt_tokens?: number };
}

export type AgentEventHandler = (e: AgentEvent) => void;

const TOOL_TIMEOUT_MS = 30_000;

/** Race a tool execution against a hard timeout (openagent-style). */
function runWithTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`ToolTimeout: '${name}' exceeded ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

const BASE_PROMPT = `You are an AI agent embedded in Obsidian. You can act on the user's vault through the provided tools (read/create/edit/search notes, metadata, backlinks, workspace commands, direct editor text interaction, YAML frontmatter operations).

Guidelines:
- Never reply with only an acknowledgment ("收到", "好的", "I will" etc.): if the user's request needs tools (search/read/create/edit/plot...), call them IMMEDIATELY in the same reply and keep working through the whole task. Only send the final text answer when the task is actually done.
- Use tools to gather facts before answering questions about the vault; do not guess note contents.
- Prefer small, safe edits: append, find_replace_in_note, frontmatter tools or selection/cursor edits over overwrite.
- When you modify files, tell the user exactly what you changed.
- Vault-relative paths always end with .md for notes.
- If a web_search tool is available, you can use it to look up information outside the vault (facts, problem solutions, references). Prefer searching the vault first when the answer may be in the user's notes.
- create_plot（画图工具）：给题目/概念配图。曲线图（bode/nyquist/root_locus/step）由插件根据传递函数精确计算并生成 SVG 嵌入笔记——不要自己手动画曲线。用法：
  1) 先从题目正确写出开环传递函数 G(s)（如 10/(s(s+1))、5*(s+2)/(s*(s+3)*(s^2+2s+2))），写在 tf 参数里；
  2) type 选 bode（伯德图）/ nyquist（奈奎斯特图）/ root_locus（根轨迹，可用 k_max 指定最大增益）/ step（单位阶跃响应，默认对单位反馈闭环 T=G/(1+G)，除非题目要求开环则传 closed=false）；
  3) 方框图/信号流图用 type=block / signal_flow：默认把 Mermaid 图体放在 diagram 参数（只写图体，如 A[输入] --> B[G1(s)] --> C((+)) --> D[G2(s)]）；若用户设置使用 Excalidraw，则传 Excalidraw JSON 字符串；
  4) title 用简短中文标题（会作为文件名和笔记标题），分析结论（转折频率、幅值/相位裕度、稳定性、超调量等）写在 note 参数；
  5) 默认把图与说明追加到当前打开的笔记（insert 省略或 current）；没有打开笔记时用 insert=new_note 建独立笔记（存到设置里的图表目录）。
- Your workspace is the AGENT/ folder: AGENT/memory.md is your long-term memory (always injected below; persist important facts with update_memory), AGENT/skills/ holds reusable skill files — when a listed skill matches the task, call read_skill to load and follow it.`;

export async function buildSystemPrompt(app: App, override?: string): Promise<string> {
  await ensureAgentWorkspace(app);
  const [memory, skills] = await Promise.all([loadMemory(app), listSkills(app)]);
  const skillLines = skills.length
    ? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
    : "(no skills yet — .md files in AGENT/skills/ become skills)";
  // A custom system prompt (set in the plugin settings) prepends the default,
  // so the user's instructions take precedence while memory/skills are kept.
  const base = override && override.trim().length > 0
    ? `${override.trim()}\n\n${BASE_PROMPT}`
    : BASE_PROMPT;
  // Inject the current date/time so the model knows "now" (LLMs don't know the clock).
  // NOTE: keep it at the END of the system prompt, after all static parts.
  // Prompt caches (DeepSeek context cache, etc.) match on a stable byte prefix;
  // a dynamic timestamp at the START would invalidate the whole prefix on every
  // request, dropping the cache-hit rate to ~0%. The static BASE_PROMPT (and
  // memory/skills, which change rarely) stays a cacheable prefix this way.
  const now = new Date();
  const nowStr = now.toLocaleString(undefined, {
    dateStyle: "full",
    timeStyle: "short",
    hour12: false,
  });
  return `${base}

<Long-term memory (AGENT/memory.md)>
${memory.trim() || "(empty)"}
</Long-term memory>

<Available skills (AGENT/skills/) — load one with read_skill when relevant>
${skillLines}
</Available skills>

<Current time>
${nowStr}
</Current time>`;
}

export class ObsidianAgent {
  private tools: Tool[];
  private toolMap: Map<string, Tool>;
  private cancelled = false;

  /** Request cancellation; the loop stops at the next safe point. */
  cancel(): void {
    this.cancelled = true;
  }

  constructor(
    private app: App,
    private settings: AgentSettings,
    private consent?: ConsentManager,
    undo?: UndoManager
  ) {
    this.tools = buildObsidianTools(app, () => ({
      enabled: this.settings.truncateEnabled !== false,
      maxLines: this.settings.truncateMaxLines > 0 ? this.settings.truncateMaxLines : 200,
    }), undo, () => (this.settings.searchEnabled ? this.settings.searchApiKey : ""), () => ({
      dir: this.settings.diagramDir,
      format: this.settings.diagramFormat,
      autoInsert: this.settings.autoInsertDiagram,
    }));
    this.toolMap = new Map(this.tools.map((t) => [t.definition.function.name, t]));
  }

  get toolNames(): string[] {
    return this.tools.map((t) => t.definition.function.name);
  }

  async run(
    history: ChatMessage[],
    userInput: string,
    onEvent: AgentEventHandler
  ): Promise<ChatMessage[]> {
    // Sanitize the history first: drop orphan tool messages and trim any
    // incomplete trailing tool round that would cause a provider 400.
    let cleanHistory = sanitizeMessages(history);
    // Compact past tool rounds (drop tool messages + tool_calls, keep text).
    // Saves tokens and keeps the cache prefix stable.
    if (this.settings.compactToolRounds !== false) {
      cleanHistory = compactToolRounds(cleanHistory);
    }
    // Optional sliding window: only the last N messages are sent.
    cleanHistory = applySlidingWindow(cleanHistory, this.settings.maxContextMessages ?? 0);

    const messages: ChatMessage[] = [
      { role: "system", content: await buildSystemPrompt(this.app, this.settings.systemPromptOverride) },
      ...cleanHistory,
      { role: "user", content: userInput },
    ];

    // Unlimited mode (超限模式): no cap — loop until the model stops calling tools.
    const unlimited = this.settings.unlimitedIterations === true;
    const maxIterations = unlimited ? Infinity : this.settings.maxIterations ?? 10;
    this.cancelled = false;

    const stopIfCancelled = (): ChatMessage[] | null => {
      if (!this.cancelled) return null;
      const stopMsg: ChatMessage = { role: "assistant", content: "Stopped by user." };
      messages.push(stopMsg);
      onEvent({ type: "assistant", content: stopMsg.content! });
      return messages.slice(1);
    };

    let truncatedRetries = 0;
    for (let i = 0; i < maxIterations; i++) {
      const stopped = stopIfCancelled();
      if (stopped) return stopped;

      const result = await chatCompletion({
        baseUrl: this.settings.baseUrl,
        apiKey: this.settings.apiKey,
        model: this.settings.model,
        messages,
        tools: this.tools.map((t) => t.definition),
        temperature: this.settings.temperature,
        maxTokens: this.settings.maxTokens,
      });

      const msg = result.message;
      messages.push(msg);

      // Forward cache/token usage so the UI can show the prompt-cache hit rate.
      if (result.usage) {
        onEvent({
          type: "usage",
          content: "",
          usage: {
            cache_hit_tokens: result.usage.cache_hit_tokens,
            cache_miss_tokens: result.usage.cache_miss_tokens,
            prompt_tokens: result.usage.prompt_tokens,
          },
        });
      }

      if (result.thinking) {
        onEvent({ type: "thinking", content: result.thinking });
      }

      if (msg.content) {
        onEvent({ type: "assistant", content: msg.content });
      }

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Provider hit max_tokens with a plain-text answer (no tool calls):
        // the reply is incomplete — keep the partial text in history and let
        // the model continue, so users don't get a one-line ack and nothing else.
        if (result.finishReason === "length" && truncatedRetries < 2) {
          truncatedRetries++;
          onEvent({ type: "thinking", content: "（回复被 max_tokens 截断，正在自动续写…）" });
          continue;
        }
        if (result.finishReason === "length") {
          const tip = "\n\n⚠️ 回复被 max_tokens 截断。请在设置 → 模型 中调大「最大输出 token」（建议 8192+）。";
          msg.content = (msg.content ?? "") + tip;
          onEvent({ type: "assistant", content: msg.content });
        }
        // Done — final assistant answer.
        return messages.slice(1); // strip system
      }

      // Execute requested tool calls.
      for (const call of msg.tool_calls) {
        const stoppedInner = stopIfCancelled();
        if (stoppedInner) return stoppedInner;

        const name = call.function.name;
        let args: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (e) {
          parseError = (e as Error).message;
        }

        onEvent({ type: "tool_call", name, content: JSON.stringify(args) });

        const tool = this.toolMap.get(name);
        let output: unknown;
        const argCheck = tool ? validateArgs(args, tool.definition.function.parameters) : null;
        if (parseError) {
          // Feed the failure back so the model can retry with valid JSON.
          output = { ok: false, error: `Invalid JSON arguments: ${parseError}` };
        } else if (!tool) {
          output = { ok: false, error: `Unknown tool: ${name}` };
        } else if (argCheck && !argCheck.ok) {
          // Schema-level argument errors go back to the model so it can fix them.
          output = { ok: false, error: `ToolArgError: ${argCheck.error}` };
        } else if (tool.mutates && this.consent && !(await this.consent.confirm(tool, args))) {
          output = { ok: false, error: "ConsentDenied: the user rejected this action. Do not retry it; ask the user how to proceed." };
        } else {
          try {
            output = await runWithTimeout(tool.execute(args), TOOL_TIMEOUT_MS, name);
          } catch (e) {
            output = { ok: false, error: (e as Error).message };
          }
        }

        const content = JSON.stringify(output);
        onEvent({ type: "tool_result", name, content });

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name,
          content,
        });
      }
    }

    const limitMsg: ChatMessage = {
      role: "assistant",
      content: `Stopped: reached the maximum of ${this.settings.maxIterations ?? 10} tool iterations.`,
    };
    messages.push(limitMsg);
    onEvent({ type: "assistant", content: limitMsg.content! });
    return messages.slice(1);
  }
}
