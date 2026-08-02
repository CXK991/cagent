// Session manager modal: list, switch, delete, rename conversations.

import { App, Modal, Notice, setIcon } from "obsidian";
import { t, type Key } from "./i18n";
import type AgentPlugin from "./main";

export class SessionManagerModal extends Modal {
  constructor(
    app: App,
    private plugin: AgentPlugin,
    private onSelect: (id: string) => void,
    private onNew: () => void
  ) {
    super(app);
  }

  private tr(key: Key): string {
    return t(this.plugin.settings.language, key);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("agent-session-modal");

    contentEl.createEl("h3", { text: this.tr("sessionManagerTitle") });

    // "New chat" button at the top.
    const newBtn = contentEl.createEl("button", { cls: "agent-session-new" });
    newBtn.setText(this.tr("newChat"));
    newBtn.addEventListener("click", () => {
      this.onNew();
      this.close();
    });

    const listEl = contentEl.createDiv({ cls: "agent-session-list" });
    const sessions = this.plugin.store.list();

    if (sessions.length === 0) {
      listEl.createDiv({ cls: "agent-session-empty", text: this.tr("noSessions") });
    }

    for (const s of sessions) {
      const row = listEl.createDiv({ cls: "agent-session-row" });

      const info = row.createDiv({ cls: "agent-session-info" });
      const titleDiv = info.createDiv({ cls: "agent-session-title", text: s.title });
      const date = new Date(s.updatedAt);
      info.createDiv({
        cls: "agent-session-date",
        text: date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      });

      // Click row = switch to this session.
      row.addEventListener("click", () => {
        this.onSelect(s.id);
        this.close();
      });

      // Rename (inline input).
      const renameBtn = row.createEl("button", { cls: "agent-session-btn", attr: { "aria-label": this.tr("renameSession") } });
      setIcon(renameBtn, "pencil");
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const newInput = document.createElement("input");
        newInput.className = "agent-session-rename-input";
        newInput.value = s.title;
        titleDiv.replaceWith(newInput);
        newInput.focus();
        newInput.select();
        const commit = (): void => {
          void this.plugin.store.rename(s.id, newInput.value).then(() => {
            new Notice(this.tr("sessionRenamed"));
            this.onOpen();
          });
        };
        newInput.addEventListener("blur", commit);
        newInput.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); newInput.blur(); }
          if (ev.key === "Escape") { newInput.value = s.title; newInput.blur(); }
        });
      });

      // Delete.
      const delBtn = row.createEl("button", { cls: "agent-session-btn agent-session-btn-danger", attr: { "aria-label": this.tr("deleteSession") } });
      setIcon(delBtn, "trash");
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.plugin.store.delete(s.id);
        new Notice(this.tr("sessionDeleted"));
        this.onOpen();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Simple yes/no confirmation modal. */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private message: string,
    private confirmLabel: string,
    private onConfirm: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });
    contentEl.createDiv({ cls: "agent-consent-desc", text: this.message });
    const btnRow = contentEl.createDiv({ cls: "agent-consent-buttons" });
    const ok = btnRow.createEl("button", { cls: "mod-cta", text: this.confirmLabel });
    const cancel = btnRow.createEl("button", { text: "Cancel" });
    ok.addEventListener("click", () => { this.onConfirm(); this.close(); });
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
