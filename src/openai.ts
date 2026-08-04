// Pure-JS OpenAI-compatible chat client (no dependencies, works with any
// OpenAI-style endpoint: OpenAI, DeepSeek, Moonshot, Ollama, LM Studio...)

import { requestUrl } from "obsidian";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Base64-encoded images attached to a user message (data URL without prefix). */
  images?: string[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Wall-clock timestamp (ms) used to display message times. */
  ts?: number;
  /** User's original text (as typed), for display when images are attached.
   * `content` then holds the full text sent to the model (incl. recognition). */
  prompt?: string;
}

/** A recognized image embedded in a chat message as an OpenAI content part. */
interface ImageContentPart {
  type: "image_url";
  image_url: { url: string };
}

/**
 * Strip "orphan" tool messages (a `role: "tool"` reply with no preceding
 * assistant message that requested that tool_call_id) and trim any incomplete
 * trailing tool round. Providers reject histories that end on an unmatched tool
 * message or where a tool reply has no corresponding tool_calls.
 */
export function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // Ids still expecting a tool reply from the last assistant(tool_calls) message.
  let pending: Set<string> | null = null;
  // Index of the last assistant(tool_calls) message pushed to `out`.
  let lastToolCallIdx = -1;

  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      pending = new Set(m.tool_calls.map((t) => t.id));
      lastToolCallIdx = out.length;
      out.push(m);
    } else if (m.role === "tool") {
      // Keep only if it replies to an outstanding tool call.
      if (pending && m.tool_call_id && pending.has(m.tool_call_id)) {
        out.push(m);
        pending.delete(m.tool_call_id);
        if (pending.size === 0) pending = null;
      }
      // else: orphan tool message → drop.
    } else {
      // user / plain assistant / system resets the tool round.
      pending = null;
      lastToolCallIdx = -1;
      out.push(m);
    }
  }

  // If the history ends mid-tool-round (last message is a tool reply, or an
  // assistant(tool_calls) that never got a reply), cut back to the last
  // completed turn to avoid a provider 400.
  const last = out[out.length - 1];
  if (last) {
    if (last.role === "tool" && lastToolCallIdx >= 0) {
      out.length = lastToolCallIdx;
    }
    const end = out[out.length - 1];
    if (end && end.role === "assistant" && end.tool_calls && end.tool_calls.length > 0) {
      // Assistant asked for tools but has no replies — drop the tool_calls so
      // the history is valid, keeping any plain text content.
      out[out.length - 1] = { ...end, tool_calls: undefined };
    }
  }

  return out;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ChatCompletionOptions {
  baseUrl: string;   // e.g. https://api.openai.com/v1
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Sampling temperature (0–2). Omit for provider default. */
  temperature?: number;
  /** Max completion tokens. Omit for provider default. */
  maxTokens?: number;
}

export interface ChatCompletionResult {
  message: ChatMessage;
  finishReason: string;
  /** Model reasoning (DeepSeek-R1 reasoning_content or <think> block), if any. */
  thinking?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** Prompt tokens served from cache (DeepSeek: prompt_cache_hit_tokens). */
    cache_hit_tokens?: number;
    /** Prompt tokens that missed the cache (DeepSeek: prompt_cache_miss_tokens). */
    cache_miss_tokens?: number;
  };
}

/** Classified errors so the UI can tell users what actually went wrong. */
export class AuthError extends Error {}
export class RateLimitError extends Error {}
export class NetworkError extends Error {}
export class ProviderError extends Error {}

// EOS tokens some local/open-source models leak into their output.
const EOS_TOKENS = ["<|endoftext|>", "<|eot_id|>", "<|im_end|>", "<eos>", "</s>"];

function stripEosTokens(text: string): string {
  let result = text;
  for (const token of EOS_TOKENS) result = result.split(token).join("");
  return result.trim();
}

/** Split reasoning out of a completion: prefer reasoning_content, else a leading <think> block. */
export function extractThinking(
  reasoningContent: unknown,
  rawText: string
): { text: string; thinking: string } {
  if (typeof reasoningContent === "string" && reasoningContent.trim().length > 0) {
    return { text: stripEosTokens(rawText), thinking: reasoningContent.trim() };
  }
  const m = rawText.match(/^<think>([\s\S]*?)<\/think>\s*/);
  if (m) {
    return { text: stripEosTokens(rawText.slice(m[0].length)), thinking: m[1].trim() };
  }
  return { text: stripEosTokens(rawText), thinking: "" };
}

function mapHttpError(status: number, detail: string): Error {
  const short = detail.slice(0, 200);
  if (status === 401 || status === 403) {
    return new AuthError(`Authentication failed (HTTP ${status}). Check your API key in settings.`);
  }
  if (status === 429) {
    return new RateLimitError("Rate limited (HTTP 429). Slow down or check your provider quota.");
  }
  if (status === 404) {
    return new ProviderError(`HTTP 404: endpoint not found — check the Base URL. ${short}`);
  }
  return new ProviderError(`LLM API error ${status}: ${short}`);
}

/**
 * One non-streaming chat completion round via an OpenAI-compatible API.
 * Uses Obsidian's requestUrl to avoid CORS restrictions.
 */
export async function chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const url = opts.baseUrl.replace(/\/+$/, "") + "/chat/completions";

  // Strip non-standard fields (ts, prompt, images) before sending. They are
  // display/UX-only; `images` in particular is huge base64 that the main text
  // model never consumes (images are pre-recognized into `content` text).
  // Sending them would inflate prompt tokens AND destabilize the byte prefix
  // that prompt caches (DeepSeek context cache, etc.) match on.
  const cleanMessages = opts.messages.map(({ ts, prompt, images, ...rest }) => rest);

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: cleanMessages,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

  let res;
  try {
    res = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e) {
    throw new NetworkError(`Network error talking to ${url}: ${(e as Error).message}`);
  }

  if (res.status >= 400) {
    let detail = "";
    try { detail = JSON.stringify(res.json); } catch { detail = res.text?.slice(0, 500) ?? ""; }
    throw mapHttpError(res.status, detail);
  }

  const data = res.json;
  const choice = data.choices?.[0];
  if (!choice) throw new ProviderError("LLM API returned no choices");

  const rawContent = typeof choice.message.content === "string" ? choice.message.content : "";
  const { text, thinking } = extractThinking(choice.message.reasoning_content, rawContent);

  // Extract cache-hit stats. DeepSeek reports prompt_cache_hit_tokens /
  // prompt_cache_miss_tokens; some OpenAI-compatible endpoints use
  // prompt_tokens_details.cached_tokens instead. Handle both.
  const usage = data.usage as
    | (Record<string, unknown> & {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      })
    | undefined;
  const details = usage?.prompt_tokens_details as { cached_tokens?: number } | undefined;
  const hit =
    (typeof usage?.prompt_cache_hit_tokens === "number" ? usage.prompt_cache_hit_tokens : undefined) ??
    (typeof details?.cached_tokens === "number" ? details.cached_tokens : undefined);
  const miss =
    typeof usage?.prompt_cache_miss_tokens === "number" ? usage.prompt_cache_miss_tokens : undefined;

  return {
    message: {
      role: "assistant",
      content: text.length > 0 ? text : null,
      tool_calls: choice.message.tool_calls,
    },
    finishReason: choice.finish_reason ?? "stop",
    thinking: thinking.length > 0 ? thinking : undefined,
    usage: {
      prompt_tokens: usage?.prompt_tokens,
      completion_tokens: usage?.completion_tokens,
      total_tokens: usage?.total_tokens,
      cache_hit_tokens: hit,
      cache_miss_tokens: miss,
    },
  };
}

/**
 * Fetch available model ids from an OpenAI-compatible `/models` endpoint.
 * Returns a sorted list; empty array on any failure (offline, auth, no endpoint).
 */
export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  try {
    const url = baseUrl.replace(/\/+$/, "") + "/models";
    const res = await requestUrl({
      url,
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      throw: false,
    });
    if (res.status >= 400) return [];
    const data = res.json;
    if (!data || !Array.isArray(data.data)) return [];
    const ids: string[] = [];
    for (const entry of data.data) {
      if (entry && typeof entry.id === "string" && entry.id.length > 0) ids.push(entry.id);
    }
    return ids.sort();
  } catch {
    return [];
  }
}

/** Build an OpenAI-style multimodal user content array with inline base64 images. */
export function buildMultimodalContent(
  text: string,
  images: string[]
): Array<string | ImageContentPart> {
  const parts: Array<string | ImageContentPart> = [text];
  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${img}` } });
  }
  return parts;
}

/**
 * Ask a vision model to transcribe/describe images as plain text.
 * Returns the model's text; throws typed errors on failure.
 * Used to let a non-multimodal text model (e.g. DeepSeek) "see" images first.
 */
export async function visionDescribe(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  images: string[]; // base64 (no data: prefix)
  prompt?: string;
}): Promise<string> {
  const url = opts.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const prompt = opts.prompt ?? "Please recognize and transcribe the content of this image (text, formulas, and any structure). Return only the transcribed content, no commentary.";

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      {
        role: "user",
        content: buildMultimodalContent(prompt, opts.images),
      },
    ],
  };

  let res;
  try {
    res = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e) {
    throw new NetworkError(`Network error talking to vision endpoint ${url}: ${(e as Error).message}`);
  }

  if (res.status >= 400) {
    let detail = "";
    try { detail = JSON.stringify(res.json); } catch { detail = res.text?.slice(0, 500) ?? ""; }
    throw mapHttpError(res.status, detail);
  }

  const data = res.json;
  const choice = data.choices?.[0];
  if (!choice) throw new ProviderError("Vision model returned no choices");

  const rawContent = typeof choice.message.content === "string" ? choice.message.content : "";
  const { text } = extractThinking(choice.message.reasoning_content, rawContent);
  if (!text) throw new ProviderError("Vision model returned empty content");
  return text;
}
