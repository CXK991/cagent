// Pure-JS agent loop: chat -> tool_calls -> execute Obsidian tools -> repeat
// until the model answers with plain text or max iterations is reached.

import { App } from "obsidian";
import { chatCompletion, ChatMessage } from "./openai";
import { buildObsidianTools, Tool } from "./tools";
import { ensureAgentWorkspace, loadMemory, listSkills } from "./memory";
import { validateArgs } from "./validate";
import type { ConsentManager } from "./consent";
import type { UndoManager } from "./undo";
import type { AgentSettings } from "./settings";

export interface AgentEvent {
  type: "tool_call" | "tool_result" | "assistant" | "thinking" | "error";
  name?: string;
  content: string;
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
- Use tools to gather facts before answering questions about the vault; do not guess note contents.
- Prefer small, safe edits: append, find_replace_in_note, frontmatter tools or selection/cursor edits over overwrite.
- When you modify files, tell the user exactly what you changed.
- Vault-relative paths always end with .md for notes.
- Your workspace is the AGENT/ folder: AGENT/memory.md is your long-term memory (always injected below; persist important facts with update_memory), AGENT/skills/ holds reusable skill files — when a listed skill matches the task, call read_skill to load and follow it.`;

export async function buildSystemPrompt(app: App): Promise<string> {
  await ensureAgentWorkspace(app);
  const [memory, skills] = await Promise.all([loadMemory(app), listSkills(app)]);
  const skillLines = skills.length
    ? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
    : "(no skills yet — .md files in AGENT/skills/ become skills)";
  return `${BASE_PROMPT}

<Long-term memory (AGENT/memory.md)>
${memory.trim() || "(empty)"}
</Long-term memory>

<Available skills (AGENT/skills/) — load one with read_skill when relevant>
${skillLines}
</Available skills>`;
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
    }), undo);
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
    const messages: ChatMessage[] = [
      { role: "system", content: await buildSystemPrompt(this.app) },
      ...history,
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

    for (let i = 0; i < maxIterations; i++) {
      const stopped = stopIfCancelled();
      if (stopped) return stopped;

      const result = await chatCompletion({
        baseUrl: this.settings.baseUrl,
        apiKey: this.settings.apiKey,
        model: this.settings.model,
        messages,
        tools: this.tools.map((t) => t.definition),
      });

      const msg = result.message;
      messages.push(msg);

      if (result.thinking) {
        onEvent({ type: "thinking", content: result.thinking });
      }

      if (msg.content) {
        onEvent({ type: "assistant", content: msg.content });
      }

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
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
