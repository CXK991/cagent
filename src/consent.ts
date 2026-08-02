// Consent layer: asks the user before any mutating tool runs.
// - Per-tool "allow once / always allow (this session) / deny" choices.
// - Diff preview for content-replacing tools (overwrite_note, find_replace_in_note).
// - Session allow-list lives in memory only; restarting Obsidian resets it.

import { App, Modal, TFile, normalizePath } from "obsidian";
import { computeLineDiff, DiffLine } from "./diff";
import type { Tool } from "./tools";

type Decision = "allow-once" | "allow-always" | "deny";

export class ConsentManager {
  /** Tools the user chose to always allow for this session. */
  private sessionAllow = new Set<string>();

  constructor(
    private app: App,
    private isEnabled: () => boolean
  ) {}

  /** Forget all "always allow" choices (e.g. when the user wants a fresh session). */
  resetSession(): void {
    this.sessionAllow.clear();
  }

  /**
   * Returns true if the tool call may proceed. Read-only tools always pass.
   * When the user denies, the caller should feed the denial back to the model.
   */
  async confirm(tool: Tool, args: Record<string, unknown>): Promise<boolean> {
    if (!tool.mutates) return true;
    if (!this.isEnabled()) return true;
    const name = tool.definition.function.name;
    if (this.sessionAllow.has(name)) return true;

    const diff = await this.previewDiff(name, args);
    const decision = await openConsentModal(
      this.app,
      name,
      tool.definition.function.description,
      args,
      diff
    );
    if (decision === "allow-always") {
      this.sessionAllow.add(name);
      return true;
    }
    return decision === "allow-once";
  }

  /** Build a before/after diff for tools whose effect we can compute up front. */
  private async previewDiff(name: string, args: Record<string, unknown>): Promise<DiffLine[] | null> {
    try {
      if (name === "overwrite_note") {
        const before = await this.readCurrent(String(args.path ?? ""));
        if (before === null) return null;
        return computeLineDiff(before, String(args.content ?? ""));
      }
      if (name === "find_replace_in_note") {
        const before = await this.readCurrent(String(args.path ?? ""));
        if (before === null) return null;
        const find = String(args.find ?? "");
        if (!find || !before.includes(find)) return null;
        const after = args.all
          ? before.split(find).join(String(args.replace ?? ""))
          : before.replace(find, String(args.replace ?? ""));
        return computeLineDiff(before, after);
      }
    } catch {
      return null;
    }
    return null;
  }

  private async readCurrent(path: string): Promise<string | null> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? this.app.vault.read(f) : null;
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    let s = typeof v === "string" ? v : JSON.stringify(v);
    if (s.length > 200) s = s.slice(0, 200) + `… (${s.length} chars)`;
    parts.push(`${k}: ${s}`);
  }
  return parts.join("\n") || "(no arguments)";
}

function openConsentModal(
  app: App,
  toolName: string,
  description: string,
  args: Record<string, unknown>,
  diff: DiffLine[] | null
): Promise<Decision> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (modal: Modal, d: Decision) => {
      if (settled) return;
      settled = true;
      resolve(d);
      modal.close();
    };

    const modal = new (class extends Modal {
      onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass("agent-consent-modal");
        contentEl.createEl("h3", { text: `Allow "${toolName}"?` });
        contentEl.createEl("p", { cls: "agent-consent-desc", text: description });

        if (diff && diff.length > 0) {
          const pre = contentEl.createEl("pre", { cls: "agent-consent-diff" });
          for (const line of diff) {
            const prefix = line.type === "add" ? "+ " : line.type === "del" ? "- " : "  ";
            pre.createSpan({
              cls: line.type === "add" ? "agent-diff-add" : line.type === "del" ? "agent-diff-del" : "agent-diff-ctx",
              text: prefix + line.text + "\n",
            });
          }
        } else {
          const pre = contentEl.createEl("pre", { cls: "agent-consent-args" });
          pre.setText(summarizeArgs(args));
        }

        const row = contentEl.createDiv({ cls: "agent-consent-buttons" });
        const allowOnce = row.createEl("button", { cls: "mod-cta", text: "Allow once" });
        const allowAlways = row.createEl("button", { text: "Always allow (session)" });
        const deny = row.createEl("button", { cls: "mod-warning", text: "Deny" });
        allowOnce.addEventListener("click", () => finish(this, "allow-once"));
        allowAlways.addEventListener("click", () => finish(this, "allow-always"));
        deny.addEventListener("click", () => finish(this, "deny"));
      }

      onClose(): void {
        // Closing via Esc / click-outside counts as denial (fail-safe).
        finish(this, "deny");
        this.contentEl.empty();
      }
    })(app);

    modal.open();
  });
}
