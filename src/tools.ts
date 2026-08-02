// Wraps the Obsidian API as function-calling tools.
// Each tool = OpenAI tool schema + an executor against the live vault/workspace.

import { App, MarkdownView, TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import type { ToolDefinition } from "./openai";
import { appendMemory, loadMemory, listSkills, readSkill } from "./memory";
import type { UndoManager } from "./undo";

/** Rejects paths that escape the vault or touch Obsidian internals. */
export class PathError extends Error {}

function safeVaultPath(raw: unknown): string {
  const p = String(raw ?? "").trim();
  if (!p) throw new PathError("Path is empty");
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) {
    throw new PathError(`Absolute paths are not allowed: ${p}`);
  }
  const norm = normalizePath(p);
  const segs = norm.split("/");
  if (segs.some((s) => s === "..")) {
    throw new PathError(`Path traversal is not allowed: ${p}`);
  }
  if (segs[0] === ".obsidian") {
    throw new PathError("Refusing to access the .obsidian config folder");
  }
  return norm;
}

// ---------- YAML frontmatter helpers ----------
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface FrontmatterSplit {
  data: Record<string, unknown>;
  hasBlock: boolean;
  body: string;
}

function splitFrontmatter(content: string): FrontmatterSplit {
  const m = content.match(FM_RE);
  if (!m) return { data: {}, hasBlock: false, body: content };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]);
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    throw new Error("Existing YAML frontmatter is invalid and cannot be parsed");
  }
  return { data, hasBlock: true, body: content.slice(m[0].length) };
}

function joinFrontmatter(data: Record<string, unknown>, body: string): string {
  if (Object.keys(data).length === 0) return body;
  return `---\n${stringifyYaml(data).trimEnd()}\n---\n${body}`;
}

/** Parse a tool argument as YAML/JSON value: objects/arrays/numbers/bools pass
 * through, strings are tried as JSON then kept as plain strings. */
function coerceYamlValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s) return s;
  try { return JSON.parse(s); } catch { return v; }
}

/** Truncation behavior for tool results, driven by user settings. */
export interface TruncateConfig {
  enabled: boolean;
  maxLines: number;
}

export const DEFAULT_TRUNCATE: TruncateConfig = { enabled: true, maxLines: 200 };

/**
 * Line-based truncation applied BEFORE content ever reaches the LLM payload.
 * offset/limit are line numbers. When disabled, full content is returned.
 */
function truncateForModel(content: string, cfg: TruncateConfig, offset = 0, limit?: number) {
  if (!cfg.enabled) {
    return {
      content,
      offset: 0,
      returned_lines: content.split("\n").length,
      total_lines: content.split("\n").length,
      truncated: false,
    };
  }
  const lines = content.split("\n");
  const start = Math.max(0, Math.floor(offset));
  const cap = Math.max(1, cfg.maxLines);
  const take = Math.min(Math.max(1, Math.floor(limit ?? cap)), cap);
  const slice = lines.slice(start, start + take);
  const truncated = start + slice.length < lines.length;
  return {
    content: slice.join("\n"),
    offset: start,
    returned_lines: slice.length,
    total_lines: lines.length,
    truncated,
    hint: truncated
      ? `Content truncated before upload (showing lines ${start + 1}-${start + slice.length} of ${lines.length}). Call again with a larger offset to keep reading.`
      : undefined,
  };
}

/** Truncate arbitrary text for the model (used by chat @-file references). */
export function truncateText(content: string, cfg: TruncateConfig): string {
  return truncateForModel(content, cfg).content;
}

export interface Tool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  /** True for tools that modify the vault / workspace or run commands.
   * The consent layer asks the user before these execute. */
  mutates?: boolean;
}

/** Tools that change state and therefore require user consent. */
const MUTATING_TOOLS = new Set([
  "create_note",
  "append_to_note",
  "overwrite_note",
  "delete_file",
  "rename_file",
  "run_command",
  "update_memory",
  "replace_active_selection",
  "insert_at_cursor",
  "find_replace_in_note",
  "set_frontmatter_key",
  "update_frontmatter",
  "delete_frontmatter_keys",
  "replace_frontmatter",
]);

type JsonSchema = Record<string, unknown>;

function tool(
  name: string,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[],
  execute: (args: Record<string, unknown>) => Promise<unknown>
): Tool {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description,
        parameters: { type: "object", properties, required },
      },
    },
    execute,
  };
}

const str = (description: string): JsonSchema => ({ type: "string", description });

/** Minimal structural typing for the (undocumented) commands API. */
interface CommandEntry {
  id: string;
  name: string;
}
interface CommandsApi {
  commands?: Record<string, CommandEntry>;
  executeCommandById?: (id: string) => boolean;
}

function getCommandsApi(app: App): CommandsApi | undefined {
  return (app as unknown as { commands?: CommandsApi }).commands;
}

/** Build the full Obsidian-API toolset for the current app instance. */
export function buildObsidianTools(
  app: App,
  getTruncate: () => TruncateConfig = () => DEFAULT_TRUNCATE,
  undo?: UndoManager
): Tool[] {
  const vault = app.vault;

  const ok = (data: unknown) => ({ ok: true, data });
  const err = (message: string) => ({ ok: false, error: message });

  const mustGetFile = (path: string): TFile => {
    const p = safeVaultPath(path);
    const f = vault.getAbstractFileByPath(p);
    if (!(f instanceof TFile)) throw new Error(`File not found: ${p}`);
    return f;
  };

  const snapshot = (record: { tool: string; path: string; before: string | null; after: string | null; newPath?: string }) => {
    undo?.push(record);
  };

  const tools: Tool[] = [
    // ---------- Vault read ----------
    tool(
      "read_note",
      "Read the markdown content of a note. Long files are truncated to a configurable number of lines before upload; use offset/limit (in lines) to page through them.",
      {
        path: str("Vault-relative path, e.g. 'Folder/Note.md'"),
        offset: { type: "number", description: "Line number to start reading from, 0-based (default 0)" },
        limit: { type: "number", description: "Max lines to return (default and hard cap: the user's truncation setting)" },
      },
      ["path"],
      async ({ path, offset, limit }) => {
        try {
          const f = mustGetFile(String(path));
          const content = await vault.read(f);
          return ok(truncateForModel(content, getTruncate(), Number(offset) || 0, limit === undefined ? undefined : Number(limit)));
        } catch (e) { return err((e as Error).message); }
      }
    ),

    tool(
      "list_files",
      "List files and folders in the vault, optionally under a folder, optionally filtered by extension.",
      {
        folder: str("Folder to list, '' or '/' for vault root"),
        extension: str("Optional extension filter, e.g. 'md'"),
        recursive: { type: "boolean", description: "Recurse into subfolders (default true)" },
      },
      [],
      async ({ folder, extension, recursive }) => {
        const dir = folder && String(folder) !== "/" ? String(folder) : "";
        const out: string[] = [];
        const walk = (f: TFolder) => {
          for (const child of f.children) {
            if (child instanceof TFolder) {
              out.push(child.path + "/");
              if (recursive !== false) walk(child);
            } else if (child instanceof TFile && (!extension || child.extension === extension)) {
              out.push(child.path);
            }
          }
        };
        const root = dir ? vault.getAbstractFileByPath(normalizePath(dir)) : vault.getRoot();
        if (!(root instanceof TFolder)) return err(`Folder not found: ${dir}`);
        walk(root);
        return ok(out);
      }
    ),

    tool(
      "search_notes",
      "Full-text search across vault notes (case-insensitive substring match). Returns matching paths with line snippets.",
      {
        query: str("Text to search for"),
        max_results: { type: "number", description: "Max matches to return (default 20)" },
      },
      ["query"],
      async ({ query, max_results }) => {
        const q = String(query).toLowerCase();
        const max = Number(max_results) || 20;
        const results: Array<{ path: string; line: number; snippet: string }> = [];
        for (const f of vault.getMarkdownFiles()) {
          const content = await vault.read(f);
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(q)) {
              results.push({ path: f.path, line: i + 1, snippet: lines[i].slice(0, 200) });
              if (results.length >= max) return ok(results);
            }
          }
        }
        return ok(results);
      }
    ),

    // ---------- Vault write ----------
    tool(
      "create_note",
      "Create a new note with the given content. Fails if the note already exists (use append_to_note or overwrite_note instead).",
      {
        path: str("Vault-relative path of the new note, must end with .md"),
        content: str("Markdown content"),
      },
      ["path", "content"],
      async ({ path, content }) => {
        try {
          const p = safeVaultPath(path);
          if (vault.getAbstractFileByPath(p)) return err(`Already exists: ${p}`);
          const folder = p.split("/").slice(0, -1).join("/");
          if (folder && !vault.getAbstractFileByPath(folder)) {
            await vault.createFolder(folder);
          }
          await vault.create(p, String(content));
          snapshot({ tool: "create_note", path: p, before: null, after: String(content) });
          return ok(`Created ${p}`);
        } catch (e) { return err((e as Error).message); }
      }
    ),

    tool(
      "append_to_note",
      "Append markdown content to the end of an existing note.",
      {
        path: str("Vault-relative path"),
        content: str("Markdown content to append"),
      },
      ["path", "content"],
      async ({ path, content }) => {
        try {
          const f = mustGetFile(String(path));
          const before = await vault.read(f);
          await vault.append(f, String(content));
          snapshot({ tool: "append_to_note", path: f.path, before, after: before + String(content) });
          return ok(`Appended to ${f.path}`);
        } catch (e) { return err((e as Error).message); }
      }
    ),

    tool(
      "overwrite_note",
      "Replace the entire content of an existing note. Use with care.",
      {
        path: str("Vault-relative path"),
        content: str("New full markdown content"),
      },
      ["path", "content"],
      async ({ path, content }) => {
        try {
          const f = mustGetFile(String(path));
          const before = await vault.read(f);
          await vault.modify(f, String(content));
          snapshot({ tool: "overwrite_note", path: f.path, before, after: String(content) });
          return ok(`Overwrote ${f.path}`);
        } catch (e) { return err((e as Error).message); }
      }
    ),

    tool(
      "delete_file",
      "Delete a file (moves to system/app trash according to user settings).",
      { path: str("Vault-relative path") },
      ["path"],
      async ({ path }) => {
        try {
          const f = mustGetFile(String(path));
          const before = await vault.read(f);
          await app.fileManager.trashFile(f);
          snapshot({ tool: "delete_file", path: f.path, before, after: null });
          return ok(`Deleted ${f.path}`);
        } catch (e) { return err((e as Error).message); }
      }
    ),

    tool(
      "rename_file",
      "Rename or move a file to a new vault-relative path.",
      {
        path: str("Current vault-relative path"),
        new_path: str("New vault-relative path"),
      },
      ["path", "new_path"],
      async ({ path, new_path }) => {
        try {
          const f = mustGetFile(String(path));
          const orig = f.path;
          const dest = safeVaultPath(new_path);
          await vault.rename(f, dest);
          snapshot({ tool: "rename_file", path: orig, before: null, after: null, newPath: dest });
          return ok(`Moved to ${dest}`);
        } catch (e) { return err((e as Error).message); }
      }
    ),

    // ---------- Metadata ----------
    tool(
      "get_note_metadata",
      "Get cached metadata of a note: headings, tags, links, frontmatter.",
      { path: str("Vault-relative path") },
      ["path"],
      async ({ path }) => {
        try {
          const f = mustGetFile(String(path));
          const cache = app.metadataCache.getFileCache(f);
          return ok({
            headings: cache?.headings?.map((h) => ({ level: h.level, heading: h.heading })) ?? [],
            tags: cache?.tags?.map((t) => t.tag) ?? [],
            links: cache?.links?.map((l) => l.link) ?? [],
            frontmatter: cache?.frontmatter ?? null,
          });
        } catch (e) { return err((e as Error).message); }
      }
    ),

    tool(
      "get_backlinks",
      "Get notes that link TO the given note (backlinks).",
      { path: str("Vault-relative path") },
      ["path"],
      async ({ path }) => {
        const f = mustGetFile(String(path));
        const sources: string[] = [];
        const resolved = app.metadataCache.resolvedLinks;
        for (const [src, targets] of Object.entries(resolved)) {
          if (targets[f.path]) sources.push(src);
        }
        return ok(sources);
      }
    ),

    // ---------- Workspace ----------
    tool(
      "open_note",
      "Open a note in the active Obsidian pane.",
      { path: str("Vault-relative path") },
      ["path"],
      async ({ path }) => {
        try {
          const f = mustGetFile(String(path));
          await app.workspace.getLeaf(false).openFile(f);
          return ok(`Opened ${f.path}`);
        } catch (e) { return err((e as Error).message); }
      }
    ),

    tool(
      "get_active_note",
      "Get the path of the note currently open in the active editor (null if none).",
      {},
      [],
      async () => {
        const f = app.workspace.getActiveFile();
        return ok(f ? f.path : null);
      }
    ),

    tool(
      "run_command",
      "Execute an Obsidian command by its command id (e.g. 'app:open-vault', 'daily-notes'). Use list_commands to discover ids.",
      { command_id: str("The command id to execute") },
      ["command_id"],
      async ({ command_id }) => {
        const id = String(command_id);
        const commands = getCommandsApi(app);
        if (!commands?.commands?.[id]) return err(`Unknown command: ${id}`);
        const okExec = commands.executeCommandById ? commands.executeCommandById(id) : false;
        return okExec ? ok(`Executed ${id}`) : err(`Command could not run in current context: ${id}`);
      }
    ),

    tool(
      "list_commands",
      "List available Obsidian command ids and names.",
      { filter: str("Optional substring filter on id/name") },
      [],
      async ({ filter }) => {
        const commands = getCommandsApi(app)?.commands ?? {};
        const f = filter ? String(filter).toLowerCase() : "";
        const list = Object.values(commands)
          .map((c) => ({ id: c.id, name: c.name }))
          .filter((c) => !f || c.id.toLowerCase().includes(f) || c.name.toLowerCase().includes(f));
        return ok(list.slice(0, 100));
      }
    ),

    // ---------- Agent workspace (AGENT/ memory & skills) ----------
    tool(
      "read_memory",
      "Read the agent's long-term memory file (AGENT/memory.md).",
      {},
      [],
      async () => ok(await loadMemory(app))
    ),

    tool(
      "update_memory",
      "Persist an important fact, user preference, or vault convention to long-term memory (AGENT/memory.md). Use proactively when you learn something worth remembering across sessions.",
      {
        section: str("Memory section heading, e.g. 'User preferences'"),
        entry: str("One concise bullet of what to remember"),
      },
      ["section", "entry"],
      async ({ section, entry }) => {
        try {
          const before = await loadMemory(app);
          await appendMemory(app, String(section), String(entry));
          snapshot({ tool: "update_memory", path: "AGENT/memory.md", before, after: await loadMemory(app) });
          return ok("Memory updated");
        } catch (e) { return err((e as Error).message); }
      }
    ),

    tool(
      "list_skills",
      "List skills available in AGENT/skills/ with their descriptions.",
      {},
      [],
      async () => ok(await listSkills(app))
    ),

    tool(
      "read_skill",
      "Load the full instructions of a skill from AGENT/skills/ by name, then follow them.",
      { name: str("Skill name (file basename or frontmatter name)") },
      ["name"],
      async ({ name }) => {
        try {
          return ok(truncateForModel(await readSkill(app, String(name)), getTruncate()));
        } catch (e) { return err((e as Error).message); }
      }
    ),

    // ---------- Direct text interaction (live editor) ----------
    tool(
      "get_active_selection",
      "Get the currently selected text in the active editor (empty string if nothing is selected). Also returns the active note path and full editor text if the selection is empty.",
      {},
      [],
      async () => {
        const view = app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return err("No active markdown editor");
        const selection = view.editor.getSelection();
        if (selection) return ok({ path: view.file?.path ?? null, selection });
        return ok({
          path: view.file?.path ?? null,
          selection: "",
          editor_text: truncateForModel(view.editor.getValue(), getTruncate()),
          hint: "Nothing selected; editor_text contains the (possibly truncated) current buffer.",
        });
      }
    ),

    tool(
      "replace_active_selection",
      "Replace the currently selected text in the active editor with new text. Fails if nothing is selected.",
      { text: str("Replacement text") },
      ["text"],
      async ({ text }) => {
        const view = app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return err("No active markdown editor");
        if (!view.editor.somethingSelected()) return err("Nothing is selected in the active editor");
        view.editor.replaceSelection(String(text));
        return ok("Selection replaced");
      }
    ),

    tool(
      "insert_at_cursor",
      "Insert text at the cursor position in the active editor.",
      { text: str("Text to insert") },
      ["text"],
      async ({ text }) => {
        const view = app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return err("No active markdown editor");
        view.editor.replaceRange(String(text), view.editor.getCursor());
        return ok("Inserted at cursor");
      }
    ),

    tool(
      "find_replace_in_note",
      "Find and replace text inside a note without rewriting the whole file. Exact substring match; set all=true to replace every occurrence. Without all=true the match must be unique — include more surrounding context in 'find' if it is not.",
      {
        path: str("Vault-relative path"),
        find: str("Exact text to find. Must be unique unless all=true; include surrounding lines to disambiguate."),
        replace: str("Replacement text"),
        all: { type: "boolean", description: "Replace all occurrences (default false = requires a unique match)" },
      },
      ["path", "find", "replace"],
      async ({ path, find, replace, all }) => {
        try {
          const f = mustGetFile(String(path));
          const content = await vault.read(f);
          const needle = String(find);
          if (needle.length === 0) return err("find must be non-empty");
          const count = content.split(needle).length - 1;
          if (count === 0) return err("Text not found in note");
          if (!all && count > 1) {
            return err(`AmbiguousEditError: '${needle.slice(0, 60)}' matches ${count} times; set all=true to replace all, or include more surrounding context in 'find' to make it unique.`);
          }
          const replaced = all
            ? content.split(needle).join(String(replace))
            : content.replace(needle, String(replace));
          await vault.modify(f, replaced);
          snapshot({ tool: "find_replace_in_note", path: f.path, before: content, after: replaced });
          return ok(`Replaced ${all ? count : 1} occurrence(s) in ${f.path}`);
        } catch (e) { return err((e as Error).message); }
      }
    ),

    // ---------- YAML frontmatter (read/write the yaml block only) ----------
    tool(
      "get_frontmatter",
      "Read ONLY the YAML frontmatter of a note (parsed as an object). Returns has_frontmatter=false if the note has none. Does not load the note body.",
      { path: str("Vault-relative path") },
      ["path"],
      async ({ path }) => {
        try {
          const f = mustGetFile(String(path));
          const { data, hasBlock } = splitFrontmatter(await vault.read(f));
          return ok({ has_frontmatter: hasBlock, frontmatter: hasBlock ? data : null });
        } catch (e) { return err((e as Error).message); }
      }
    ),

    tool(
      "set_frontmatter_key",
      "Set a single YAML frontmatter key on a note, creating the frontmatter block if absent. Other keys and the note body are untouched.",
      {
        path: str("Vault-relative path"),
        key: str("Frontmatter key, e.g. 'tags' or 'status'"),
        value: str("Value. Plain string, or JSON for numbers/booleans/arrays/objects, e.g. '[\"a\",\"b\"]' or 'true'"),
      },
      ["path", "key", "value"],
      async ({ path, key, value }) => {
        try {
          const f = mustGetFile(String(path));
          const raw = await vault.read(f);
          const { data, body } = splitFrontmatter(raw);
          data[String(key)] = coerceYamlValue(value);
          const after = joinFrontmatter(data, body);
          await vault.modify(f, after);
          snapshot({ tool: "set_frontmatter_key", path: f.path, before: raw, after });
          return ok(`Set ${key} in ${f.path}`);
        } catch (e) { return err((e as Error).message); }
      }
    ),

    tool(
      "update_frontmatter",
      "Merge several properties into a note's YAML frontmatter (existing keys not mentioned are kept). Pass a JSON object.",
      {
        path: str("Vault-relative path"),
        properties: str("JSON object of properties to merge, e.g. '{\"status\":\"done\",\"rating\":5}'"),
      },
      ["path", "properties"],
      async ({ path, properties }) => {
        try {
          const f = mustGetFile(String(path));
          const parsed = coerceYamlValue(properties);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return err("properties must be a JSON object");
          }
          const raw = await vault.read(f);
          const { data, body } = splitFrontmatter(raw);
          Object.assign(data, parsed as Record<string, unknown>);
          const after = joinFrontmatter(data, body);
          await vault.modify(f, after);
          snapshot({ tool: "update_frontmatter", path: f.path, before: raw, after });
          return ok(`Updated frontmatter in ${f.path}: ${Object.keys(parsed as object).join(", ")}`);
        } catch (e) { return err((e as Error).message); }
      }
    ),

    tool(
      "delete_frontmatter_keys",
      "Delete one or more keys from a note's YAML frontmatter. If no keys remain, the whole frontmatter block is removed.",
      {
        path: str("Vault-relative path"),
        keys: str("JSON array of key names, e.g. '[\"draft\",\"old-field\"]'"),
      },
      ["path", "keys"],
      async ({ path, keys }) => {
        try {
          const f = mustGetFile(String(path));
          const parsed = coerceYamlValue(keys);
          if (!Array.isArray(parsed)) return err("keys must be a JSON array of strings");
          const raw = await vault.read(f);
          const { data, hasBlock, body } = splitFrontmatter(raw);
          if (!hasBlock) return err("Note has no frontmatter");
          const removed: string[] = [];
          for (const k of parsed) {
            if (String(k) in data) { delete data[String(k)]; removed.push(String(k)); }
          }
          if (removed.length > 0) {
            const after = joinFrontmatter(data, body);
            await vault.modify(f, after);
            snapshot({ tool: "delete_frontmatter_keys", path: f.path, before: raw, after });
          }
          return ok(removed.length ? `Deleted keys: ${removed.join(", ")}` : "No matching keys found");
        } catch (e) { return err((e as Error).message); }
      }
    ),

    tool(
      "replace_frontmatter",
      "Replace the ENTIRE YAML frontmatter of a note with the given YAML/JSON object (drops all existing keys). Prefer update_frontmatter for partial edits.",
      {
        path: str("Vault-relative path"),
        properties: str("JSON object (or YAML string) for the new frontmatter. Empty object removes the block."),
      },
      ["path", "properties"],
      async ({ path, properties }) => {
        try {
          const f = mustGetFile(String(path));
          const rawArgs = String(properties);
          let parsed: unknown;
          try { parsed = JSON.parse(rawArgs); } catch { parsed = parseYaml(rawArgs); }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return err("properties must be a JSON object or YAML mapping");
          }
          const raw = await vault.read(f);
          const { body } = splitFrontmatter(raw);
          const after = joinFrontmatter(parsed as Record<string, unknown>, body);
          await vault.modify(f, after);
          snapshot({ tool: "replace_frontmatter", path: f.path, before: raw, after });
          return ok(`Replaced frontmatter in ${f.path}`);
        } catch (e) { return err((e as Error).message); }
      }
    ),
  ];

  for (const t of tools) {
    if (MUTATING_TOOLS.has(t.definition.function.name)) t.mutates = true;
  }
  return tools;
}
