import { ItemView, MarkdownRenderer, Menu, Notice, Platform, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import { ObsidianAgent } from "./agent";
import { truncateText } from "./tools";
import { SessionStore } from "./sessions";
import { visionDescribe, type ChatMessage } from "./openai";
import { t, type Key } from "./i18n";
import { syncActiveProfile } from "./settings";
import { SessionManagerModal, ConfirmModal } from "./sessionModal";
import type AgentPlugin from "./main";

/** Longest side for the downscaled image. */
const MAX_IMAGE_SIDE = 1280;

const MAX_FILE_REFS = 5;
const MAX_SUGGESTIONS = 8;

export const VIEW_TYPE_AGENT_CHAT = "agent-tools-chat";

export class AgentChatView extends ItemView {
  private agent: ObsidianAgent;
  private history: ChatMessage[] = [];
  private messagesEl!: HTMLElement;
  private usageEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private imageInput?: HTMLInputElement;
  private cameraInput?: HTMLInputElement;
  private busy = false;
  /** Latest completion's prompt-cache stats, for the footer display. */
  private lastUsage: { cache_hit_tokens?: number; cache_miss_tokens?: number } = {};

  // @ file-reference suggestions
  private suggestEl?: HTMLElement;
  private suggestFiles: TFile[] = [];
  private suggestIdx = 0;
  private suggestFrom = -1; // caret index of the active '@'

  // Session persistence
  private store: SessionStore;
  private sessionId?: string;
  private sessionSelect?: HTMLSelectElement;

  // Rendered bubbles (for in-chat search + highlighting).
  private bubbles: Array<{ el: HTMLElement; text: string }> = [];

  // In-chat search state.
  private searchRow?: HTMLElement;
  private searchInput?: HTMLInputElement;
  private searchCountEl?: HTMLElement;
  private searchMatches: HTMLElement[] = [];
  private searchIdx = -1;

  // Pending image attachments (sent as message bubbles, not pasted text).
  private pendingImages: Array<{ data: string; name: string }> = [];
  // Mobile: observes the soft-keyboard height so the header can hide and
  // the input stays visible (inspired by Copilot's mobile handling).
  private keyboardObserver?: MutationObserver;
  private previewRow?: HTMLElement;

  // Time grouping: only show a timestamp if it differs from the previous one
  // by more than this many ms.
  private lastShownTs = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: AgentPlugin) {
    super(leaf);
    this.agent = new ObsidianAgent(this.app, plugin.settings, plugin.consent, plugin.undo);
    this.store = plugin.store;
  }

  getViewType(): string { return VIEW_TYPE_AGENT_CHAT; }
  getDisplayText(): string { return t(this.plugin.settings.language, "chatTitle"); }
  getIcon(): string { return "bot"; }

  /** Translate a key in the current UI language. */
  private tr(key: Key, vars?: Record<string, string | number>): string {
    return t(this.plugin.settings.language, key, vars);
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("agent-chat-root");

    // Mobile: hide the header while the soft keyboard is open to reclaim
    // screen space. Obsidian sets --keyboard-height on <html> while typing.
    if (Platform.isMobile) {
      const docEl = this.app.workspace.containerEl.doc.documentElement;
      const applyKeyboardClass = () => {
        const h = parseFloat(docEl.style.getPropertyValue("--keyboard-height") || "0");
        root.toggleClass("keyboard-open", h > 0);
      };
      applyKeyboardClass();
      this.keyboardObserver = new MutationObserver(applyKeyboardClass);
      this.keyboardObserver.observe(docEl, {
        attributes: true,
        attributeFilter: ["style"],
      });
    }

    // Header: session picker + context usage (left) + actions (right).
    const header = root.createDiv({ cls: "agent-chat-header" });
    const left = header.createDiv({ cls: "agent-chat-header-left" });
    this.sessionSelect = left.createEl("select", { cls: "agent-chat-sessions" });
    this.sessionSelect.addEventListener("change", () => {
      const id = this.sessionSelect?.value;
      if (id && id !== this.sessionId) this.loadSession(id);
    });
    this.usageEl = left.createSpan({ cls: "agent-chat-usage", text: "context ≈ 0 tok" });

    const actions = header.createDiv({ cls: "agent-chat-header-actions" });

    // Model switcher: lists saved profiles; grayed out for those without a key.
    const modelBtn = actions.createEl("button", {
      cls: "agent-chat-icon-btn",
      attr: { "aria-label": this.tr("switchModel") },
    });
    setIcon(modelBtn, "bot");
    modelBtn.setAttr("title", this.currentProfileLabel());
    modelBtn.addEventListener("click", (ev) => this.showProfileMenu(modelBtn, ev));
    actions.prepend(modelBtn);

    // "More" menu: secondary actions tucked away so the header stays clean.
    const moreBtn = actions.createEl("button", {
      cls: "agent-chat-icon-btn",
      attr: { "aria-label": this.tr("moreActions") },
    });
    setIcon(moreBtn, "more-horizontal");
    moreBtn.addEventListener("click", (ev) => {
      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle(this.tr("newConversation"));
        item.setIcon("rotate-ccw");
        item.onClick(() => this.resetConversation());
      });
      menu.addItem((item) => {
        item.setTitle(this.tr("searchOpen"));
        item.setIcon("search");
        item.onClick(() => this.toggleSearch());
      });
      menu.addItem((item) => {
        item.setTitle(this.tr("sessionManagerTitle"));
        item.setIcon("list");
        item.onClick(() => {
          new SessionManagerModal(this.app, this.plugin, (id) => this.loadSession(id), () => this.resetConversation()).open();
        });
      });
      menu.addItem((item) => {
        item.setTitle(this.tr("exportSession"));
        item.setIcon("download");
        item.onClick(() => void this.exportSession());
      });
      menu.addItem((item) => {
        item.setTitle(this.tr("clearCurrent"));
        item.setIcon("trash");
        item.onClick(() => this.clearCurrentSession());
      });
      menu.showAtMouseEvent(ev);
    });

    // In-chat search bar (hidden by default).
    this.searchRow = root.createDiv({ cls: "agent-chat-search" });
    this.searchRow.style.display = "none";
    this.searchInput = this.searchRow.createEl("input", {
      cls: "agent-chat-search-input",
      attr: { placeholder: this.tr("searchPlaceholder"), type: "text" },
    });
    const prevBtn = this.searchRow.createEl("button", { cls: "agent-chat-icon-btn", attr: { "aria-label": "↑" } });
    setIcon(prevBtn, "chevron-up");
    prevBtn.addEventListener("click", () => this.gotoMatch(-1));
    const nextBtn = this.searchRow.createEl("button", { cls: "agent-chat-icon-btn", attr: { "aria-label": "↓" } });
    setIcon(nextBtn, "chevron-down");
    nextBtn.addEventListener("click", () => this.gotoMatch(1));
    this.searchCountEl = this.searchRow.createSpan({ cls: "agent-chat-search-count" });
    const closeBtn = this.searchRow.createEl("button", { cls: "agent-chat-icon-btn", attr: { "aria-label": "×" } });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.toggleSearch(false));
    this.searchInput.addEventListener("input", () => this.runSearch());
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.gotoMatch(e.shiftKey ? -1 : 1); }
      if (e.key === "Escape") this.toggleSearch(false);
    });

    this.messagesEl = root.createDiv({ cls: "agent-chat-messages" });



    // Pending-image preview row (thumbnails, removable).
    this.previewRow = root.createDiv({ cls: "agent-preview-row" });

    const inputRow = root.createDiv({ cls: "agent-chat-input-row" });
    this.inputEl = inputRow.createEl("textarea", {
      cls: "agent-chat-input",
      attr: { placeholder: this.tr("chatPlaceholder") },
    });

    // Camera (take photo) button — captures with the back camera on mobile.
    const camBtn = inputRow.createEl("button", {
      cls: "agent-chat-img",
      attr: { "aria-label": this.tr("takePhoto") },
    });
    setIcon(camBtn, "camera");
    camBtn.addEventListener("click", () => {
      if (!this.plugin.settings.visionEnabled) {
        new Notice(this.tr("visionNotEnabled"));
        return;
      }
      this.cameraInput?.click();
    });
    this.cameraInput = inputRow.createEl("input", {
      type: "file",
      attr: { accept: "image/*", capture: "environment", style: "display: none" },
    });
    this.cameraInput.addEventListener("change", () => {
      const file = this.cameraInput?.files?.[0];
      if (file) void this.addPendingImage(file);
    });

    // Image (photo library) button — always visible. If the vision model isn't
    // configured, clicking it shows a hint instead of opening the picker.
    const imgBtn = inputRow.createEl("button", {
      cls: "agent-chat-img",
      attr: { "aria-label": this.tr("addImage") },
    });
    setIcon(imgBtn, "image");
    imgBtn.addEventListener("click", () => {
      if (!this.plugin.settings.visionEnabled) {
        new Notice(this.tr("visionNotEnabled"));
        return;
      }
      this.imageInput?.click();
    });
    this.imageInput = inputRow.createEl("input", {
      type: "file",
      attr: { accept: "image/*", style: "display: none" },
    });
    this.imageInput.addEventListener("change", () => {
      const file = this.imageInput?.files?.[0];
      if (file) void this.addPendingImage(file);
    });

    // Always-visible "back to latest" button next to send (user request:
    // a floating button kept disappearing on mobile).
    const toBottomBtn = inputRow.createEl("button", {
      cls: "agent-chat-img agent-chat-to-bottom",
      attr: { "aria-label": this.tr("toLatest") },
    });
    setIcon(toBottomBtn, "down-to-line");
    toBottomBtn.addEventListener("click", () => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });

    this.sendBtn = inputRow.createEl("button", { cls: "agent-chat-send" });
    setIcon(this.sendBtn, "send");

    // Dropdown for @ file references, anchored above the input row.
    this.suggestEl = inputRow.createDiv({ cls: "agent-suggest" });
    this.suggestEl.style.display = "none";

    this.sendBtn.addEventListener("click", () => {
      if (this.busy) {
        // While running, the send button acts as a stop button.
        this.agent.cancel();
        new Notice(this.tr("agentStopping"));
      } else {
        void this.send();
      }
    });
    this.inputEl.addEventListener("input", () => {
      this.updateSuggestions();
      this.autoGrowInput();
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (this.suggestFiles.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.suggestIdx = (this.suggestIdx + 1) % this.suggestFiles.length;
          this.renderSuggestions();
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          this.suggestIdx = (this.suggestIdx - 1 + this.suggestFiles.length) % this.suggestFiles.length;
          this.renderSuggestions();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          this.pickSuggestion(this.suggestFiles[this.suggestIdx]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.closeSuggestions();
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });

    this.updateUsage();

    // Restore the most recent session, or show a welcome page if empty.
    await this.store.load();
    this.refreshSessionPicker();
    const recent = this.store.list()[0];
    if (recent && recent.messages.length > 0) {
      this.sessionId = recent.id;
      this.history = recent.messages;
      this.renderHistory();
      this.refreshSessionPicker();
      this.updateUsage();
      // Jump to the latest message after restoring history.
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    } else {
      this.renderWelcome();
    }
  }

  /** Centered welcome page shown when there are no messages yet. */
  private renderWelcome(): void {
    if (!this.messagesEl) return;
    this.messagesEl.empty();
    const welcome = this.messagesEl.createDiv({ cls: "agent-welcome" });

    const logo = welcome.createDiv({ cls: "agent-welcome-logo", text: this.plugin.settings.aiAvatar || "🤖" });
    welcome.createEl("h2", { cls: "agent-welcome-title", text: this.tr("welcomeTitle") });
    welcome.createEl("p", { cls: "agent-welcome-sub", text: this.tr("welcomeSub") });

    const tips = welcome.createDiv({ cls: "agent-welcome-tips" });
    const tipsList = [
      { icon: "camera", text: this.tr("welcomeTipPhoto") },
      { icon: "help-circle", text: this.tr("welcomeTipAsk") },
      { icon: "notebook-pen", text: this.tr("welcomeTipWrongQ") },
      { icon: "image", text: this.tr("welcomeTipAnalyze") },
    ];
    for (const tip of tipsList) {
      const item = tips.createDiv({ cls: "agent-welcome-tip" });
      item.createSpan({ cls: "agent-welcome-tip-icon" });
      const ic = item.querySelector(".agent-welcome-tip-icon");
      if (ic) setIcon(ic as HTMLElement, tip.icon);
      item.createSpan({ text: tip.text });
    }
  }

  /** Rebuild the session dropdown from the store. */
  private refreshSessionPicker(): void {
    const sel = this.sessionSelect;
    if (!sel) return;
    sel.empty();
    const currentOpt = sel.createEl("option", {
      text: this.sessionId ? this.store.get(this.sessionId)?.title ?? "current chat" : "(new chat)",
      value: this.sessionId ?? "",
    });
    currentOpt.selected = true;
    for (const s of this.store.list()) {
      if (s.id === this.sessionId) continue;
      sel.createEl("option", { text: s.title, value: s.id });
    }
  }

  /** Label for the model switcher button tooltip (active profile name + model). */
  private currentProfileLabel(): string {
    const p = this.plugin.settings.profiles.find((x) => x.id === this.plugin.settings.activeProfileId);
    if (!p) return this.tr("switchModel");
    return `${p.name || this.tr("unnamedProfile")}${p.model ? " · " + p.model : ""}`;
  }

  /** Popup menu listing saved profiles; grayed out when no API key is set. */
  private showProfileMenu(btn: HTMLElement, ev: MouseEvent): void {
    const s = this.plugin.settings;
    const menu = new Menu();
    for (const p of s.profiles) {
      const label = `${p.name || this.tr("unnamedProfile")}${p.model ? " · " + p.model : ""}`;
      menu.addItem((item) => {
        item.setTitle(label);
        if (p.id === s.activeProfileId) item.setChecked(true);
        if (!p.apiKey.trim()) item.setDisabled(true);
        item.onClick(async () => {
          if (p.id === s.activeProfileId) return;
          s.activeProfileId = p.id;
          syncActiveProfile(s);
          await this.plugin.saveSettings();
          btn.setAttr("title", this.currentProfileLabel());
          new Notice(this.tr("switchedTo", { name: p.name || this.tr("unnamedProfile") }));
        });
      });
    }
    menu.showAtMouseEvent(ev);
  }

  private loadSession(id: string): void {
    if (this.busy) return;
    const s = this.store.get(id);
    if (!s) return;
    this.sessionId = s.id;
    this.history = s.messages;
    this.renderHistory();
    this.updateUsage();
  }

  /** Re-render bubbles from a loaded history. */
  private renderHistory(): void {
    this.messagesEl.empty();
    this.bubbles = [];
    const showTools = this.plugin.settings.showToolCalls !== false;
    const collapsedThinking = this.plugin.settings.thinkingCollapsed !== false;
    // Consecutive tool messages share one collapsible panel per round.
    let toolPanel: { body: HTMLElement } | null = null;
    // Intermediate assistant rounds (rounds that called tools) accumulate in
    // ONE collapsible thinking/process panel; only rounds WITHOUT tool calls
    // are final answers and get a result bubble.
    let thinkingPanel: { body: HTMLElement } | null = null;
    for (const m of this.history) {
      if (m.role === "user" && (m.content || m.images)) {
        toolPanel = null;
        thinkingPanel = null;
        // Strip the injected referenced-files block for display.
        const display = m.content?.split("\n\n<referenced-files>")[0] ?? "";
        const shownText = m.prompt && m.prompt.trim().length > 0 ? m.prompt : display;
        if (m.images && m.images.length > 0) {
          this.addUserBubble(m.images.map((d) => ({ data: d, name: "image" })), shownText, m.ts ?? Date.now());
        } else {
          this.addBubble("agent-msg-user", shownText, { copyable: true, ts: m.ts });
        }
      } else if (m.role === "assistant") {
        const isProcessRound = !!m.tool_calls && m.tool_calls.length > 0;
        if (!isProcessRound) toolPanel = null;
        if (m.content || m.thinking) {
          if (isProcessRound) {
            // Process round: narration + reasoning go into the process panel.
            if (!thinkingPanel) {
              thinkingPanel = this.createPanel(this.tr("thinkingLabel"), collapsedThinking);
            }
            if (m.thinking) {
              thinkingPanel.body.createDiv({ cls: "agent-panel-thinking-line", text: m.thinking });
            }
            if (m.content) {
              thinkingPanel.body.createDiv({ cls: "agent-panel-thinking-line", text: m.content });
            }
          } else {
            // Final round: reasoning joins the process panel, the answer gets
            // the result bubble.
            if (m.thinking) {
              if (!thinkingPanel) {
                thinkingPanel = this.createPanel(this.tr("thinkingLabel"), collapsedThinking);
              }
              thinkingPanel.body.createDiv({ cls: "agent-panel-thinking-line", text: m.thinking });
            }
            if (m.content) {
              this.addBubble("agent-msg-assistant", m.content, { markdown: true, copyable: true, ts: m.ts });
            }
            // Keep the two-part structure everywhere: a collapsible thinking
            // box above every answer, with a placeholder when there's nothing.
            if (!thinkingPanel) {
              thinkingPanel = this.createPanel(this.tr("thinkingLabel"), collapsedThinking);
              thinkingPanel.body.createSpan({ cls: "agent-panel-thinking-placeholder", text: this.tr("thinkingEmpty") });
            }
            thinkingPanel = null;
          }
        } else if (!isProcessRound) {
          thinkingPanel = null;
        }
      } else if (m.role === "tool" && showTools) {
        if (!toolPanel) toolPanel = this.createPanel(this.tr("toolCallsLabel"), true);
        const short = m.content && m.content.length > 300 ? m.content.slice(0, 300) + "…" : m.content ?? "";
        const res = toolPanel.body.createDiv({ cls: "agent-panel-tool-result" });
        res.createSpan({ text: `⚙ ${m.name}: ${short}` });
      }
    }
  }

  /** Rough token estimate of what is actually SENT: chars / 4, mirroring the
   * compaction + sliding-window applied in agent.run. */
  private estimateContextTokens(): number {
    let chars = 4000; // system prompt + memory + tool schemas allowance
    const s = this.plugin.settings;
    let msgs = this.history;
    if (s.compactToolRounds !== false) {
      msgs = msgs.filter((m) => m.role !== "tool" && (m.role !== "assistant" || !!m.content?.trim()));
    }
    if ((s.maxContextMessages ?? 0) > 0 && msgs.length > s.maxContextMessages) {
      msgs = msgs.slice(-s.maxContextMessages);
    }
    for (const m of msgs) chars += m.content?.length ?? 0;
    return Math.round(chars / 4);
  }

  private updateUsage(): void {
    const tok = this.estimateContextTokens();
    let text = `context ≈ ${tok >= 1000 ? (tok / 1000).toFixed(1) + "k" : tok} tok`;
    const { cache_hit_tokens, cache_miss_tokens } = this.lastUsage;
    if (cache_hit_tokens !== undefined && cache_miss_tokens !== undefined) {
      const total = cache_hit_tokens + cache_miss_tokens;
      if (total > 0) {
        const pct = Math.round((cache_hit_tokens / total) * 100);
        text += ` · cache ${pct}%`;
      }
    }
    this.usageEl?.setText(text);
  }

  private resetConversation(): void {
    if (this.busy) return;
    this.history = [];
    this.sessionId = undefined;
    this.refreshSessionPicker();
    this.messagesEl.empty();
    this.bubbles = [];
    this.searchMatches = [];
    this.searchIdx = -1;
    if (this.searchInput) this.searchInput.value = "";
    if (this.searchCountEl) this.searchCountEl.setText("");
    this.renderWelcome();
    this.updateUsage();
  }

  /** Append a bubble. If `markdown` is true, renders text with Obsidian's
   * MarkdownRenderer (nice for AI answers); otherwise plain text.
   * Assistant messages get a bot avatar and a copy button. */
  private addBubble(
    cls: string,
    text: string,
    opts?: { markdown?: boolean; copyable?: boolean; ts?: number }
  ): HTMLElement {
    const el = this.messagesEl.createDiv({ cls: `agent-msg ${cls}` });
    const isAi = cls.includes("assistant");

    // Meta row: avatar + name + timestamp (Chatbox-style).
    const meta = el.createDiv({ cls: "agent-msg-meta" });
    const avatar = meta.createDiv({
      cls: `agent-msg-avatar ${isAi ? "is-ai" : "is-user"}`,
      text: isAi ? (this.plugin.settings.aiAvatar || "🤖") : (this.plugin.settings.userAvatar || "🧑"),
    });
    meta.createSpan({
      cls: "agent-msg-name",
      text: isAi ? this.tr("assistantLabel") : this.tr("userLabel"),
    });
    if (opts?.ts && Math.abs(opts.ts - this.lastShownTs) > 5 * 60 * 1000) {
      meta.createSpan({
        cls: "agent-msg-time",
        text: new Date(opts.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      });
      this.lastShownTs = opts.ts;
    }

    const content = el.createDiv({ cls: "agent-msg-content" });

    if (opts?.markdown) {
      MarkdownRenderer.render(this.app, text, content, "", this);
      this.addCodeCopyButtons(content);
    } else {
      content.createSpan({ text });
    }

    // Action bar below the bubble (copy button).
    if (opts?.copyable) {
      const bar = el.createDiv({ cls: "agent-msg-actions" });
      const copyBtn = bar.createEl("button", { cls: "agent-msg-action", attr: { "aria-label": this.tr("copy") } });
      setIcon(copyBtn, "copy");
      copyBtn.addEventListener("click", () => {
        void navigator.clipboard.writeText(text);
        setIcon(copyBtn, "check");
        copyBtn.addClass("copied");
        window.setTimeout(() => { setIcon(copyBtn, "copy"); copyBtn.removeClass("copied"); }, 1500);
      });
    }

    // Track for in-chat search.
    this.bubbles.push({ el, text });

    if (this.plugin.settings.autoScroll !== false) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
    return el;
  }

  /** Write a base64 image to the vault as a temp file and open it in the
   * built-in image viewer (zoomable, scrollable). */
  private async openImageViewer(data: string, name: string): Promise<void> {
    const tmpPath = normalizePath("Cagent-temp");
    let file: TFile | null = null;
    try {
      const folder = this.app.vault.getAbstractFileByPath(tmpPath);
      if (!folder) await this.app.vault.createFolder(tmpPath);

      // Decode base64 to ArrayBuffer (cross-platform, no Buffer dependency).
      const bin = atob(data);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);

      const fname = normalizePath(`${tmpPath}/view-${Date.now()}.jpg`);
      file = await this.app.vault.createBinary(fname, bytes.buffer);
    } catch (e) {
      new Notice(`${this.tr("visionError")}${(e as Error).message}`);
      return;
    }

    try {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file);
    } catch (e) {
      new Notice(`${this.tr("visionError")}${(e as Error).message}`);
    }
  }

  /** User message bubble: optional image thumbnails + original text. */
  private addUserBubble(images: Array<{ data: string; name: string }>, text: string, ts: number): HTMLElement {
    const el = this.messagesEl.createDiv({ cls: "agent-msg agent-msg-user" });

    // Meta row: avatar + name + timestamp.
    const meta = el.createDiv({ cls: "agent-msg-meta" });
    const avatar = meta.createDiv({ cls: "agent-msg-avatar is-user", text: this.plugin.settings.userAvatar || "🧑" });
    meta.createSpan({ cls: "agent-msg-name", text: this.tr("userLabel") });
    if (Math.abs(ts - this.lastShownTs) > 5 * 60 * 1000) {
      meta.createSpan({
        cls: "agent-msg-time",
        text: new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      });
      this.lastShownTs = ts;
    }

    const content = el.createDiv({ cls: "agent-msg-content" });
    for (const img of images) {
      const thumb = content.createEl("img", { cls: "agent-msg-img", attr: { alt: img.name, title: this.tr("viewImage") } });
      thumb.src = `data:image/jpeg;base64,${img.data}`;
      thumb.addEventListener("click", () => void this.openImageViewer(img.data, img.name));
    }
    if (text) content.createSpan({ text });

    // Action bar: copy button on user messages too.
    const bar = el.createDiv({ cls: "agent-msg-actions" });
    const copyBtn = bar.createEl("button", { cls: "agent-msg-action", attr: { "aria-label": this.tr("copy") } });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", () => {
      const toCopy = text || (images.map((i) => `[图片: ${i.name}]`).join("\n"));
      void navigator.clipboard.writeText(toCopy);
      setIcon(copyBtn, "check");
      copyBtn.addClass("copied");
      window.setTimeout(() => { setIcon(copyBtn, "copy"); copyBtn.removeClass("copied"); }, 1500);
    });

    this.bubbles.push({ el, text });
    if (this.plugin.settings.autoScroll !== false) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
    return el;
  }

  /** Add a copy button to every rendered <pre> code block. */
  private addCodeCopyButtons(container: HTMLElement): void {
    const pres = container.querySelectorAll("pre");
    pres.forEach((pre) => {
      pre.addClass("agent-codeblock");
      const btn = pre.createEl("button", { cls: "agent-code-copy", attr: { "aria-label": this.tr("copy") } });
      setIcon(btn, "copy");
      btn.addEventListener("click", () => {
        const code = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
        void navigator.clipboard.writeText(code.trim());
        setIcon(btn, "check");
        btn.addClass("copied");
        window.setTimeout(() => { setIcon(btn, "copy"); btn.removeClass("copied"); }, 1500);
      });
    });
  }

  /** Auto-grow the textarea with content up to its max-height. */
  private autoGrowInput(): void {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + "px";
  }

  /** Create a collapsible panel (for thinking / tool calls) with a header. */
  private createPanel(
    title: string,
    startCollapsed: boolean,
    onToggle?: (open: boolean) => void,
    before?: HTMLElement
  ): { el: HTMLElement; body: HTMLElement; setOpen: (open: boolean) => void } {
    const el = this.messagesEl.createDiv({ cls: "agent-panel" });
    if (before) this.messagesEl.insertBefore(el, before);
    const header = el.createDiv({ cls: "agent-panel-header" });
    const chevron = header.createDiv({ cls: "agent-panel-chevron" });
    setIcon(chevron, "chevron-right");
    header.createSpan({ cls: "agent-panel-title", text: title });
    let open = !startCollapsed;
    const body = el.createDiv({ cls: "agent-panel-body" });

    const apply = (): void => {
      el.toggleClass("is-open", open);
      body.style.display = open ? "block" : "none";
      chevron.empty();
      setIcon(chevron, open ? "chevron-down" : "chevron-right");
    };
    const setOpen = (v: boolean): void => { open = v; apply(); };
    apply();

    header.addEventListener("click", () => {
      setOpen(!open);
      onToggle?.(open);
      if (open) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });

    return { el, body, setOpen };
  }

  // ---------- In-chat search ----------

  private toggleSearch(force?: boolean): void {
    if (!this.searchRow) return;
    const show = force ?? this.searchRow.style.display === "none";
    this.searchRow.style.display = show ? "flex" : "none";
    if (show) this.searchInput?.focus();
    else this.clearSearch();
  }

  private clearSearch(): void {
    this.searchMatches = [];
    this.searchIdx = -1;
    this.bubbles.forEach((b) => b.el.removeClass("is-search-match"));
    if (this.searchCountEl) this.searchCountEl.setText("");
  }

  private runSearch(): void {
    const q = (this.searchInput?.value ?? "").trim().toLowerCase();
    // Reset previous highlights.
    this.searchMatches = [];
    this.searchIdx = -1;
    this.bubbles.forEach((b) => b.el.removeClass("is-search-match"));
    if (!q) {
      if (this.searchCountEl) this.searchCountEl.setText("");
      return;
    }
    this.searchMatches = this.bubbles
      .filter((b) => b.text.toLowerCase().includes(q))
      .map((b) => b.el);
    if (this.searchCountEl) {
      this.searchCountEl.setText(
        this.searchMatches.length > 0
          ? this.tr("searchMatches", { n: this.searchMatches.length })
          : this.tr("searchNone")
      );
    }
    if (this.searchMatches.length > 0) this.gotoMatch(0, true);
  }

  private gotoMatch(delta: number, forceFirst = false): void {
    if (this.searchMatches.length === 0) return;
    if (forceFirst) this.searchIdx = 0;
    else this.searchIdx = (this.searchIdx + delta + this.searchMatches.length) % this.searchMatches.length;
    const el = this.searchMatches[this.searchIdx];
    this.searchMatches.forEach((m, i) => m.toggleClass("is-search-match", i === this.searchIdx));
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // ---------- Export / clear ----------

  /** Export the current conversation to a Markdown file in the vault root. */
  private async exportSession(): Promise<void> {
    const history = this.history;
    const hasContent = history.some((m) => m.role !== "tool" && m.content);
    if (!hasContent) {
      new Notice(this.tr("noMessages"));
      return;
    }

    const lines: string[] = [`# ${this.tr("exportTitle")}`, ""];
    for (const m of history) {
      if (m.role === "user" && m.content) {
        const display = m.content.split("\n\n<referenced-files>")[0];
        lines.push(`## 👤 ${this.tr("userLabel")}`, "", display, "");
      } else if (m.role === "assistant" && m.content) {
        lines.push(`## 🤖 ${this.tr("assistantLabel")}`, "", m.content, "");
      }
    }

    const title = this.sessionId ? (this.store.get(this.sessionId)?.title ?? "session") : "session";
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const fname = `Cagent-${safeTitle}-${stamp}.md`;

    try {
      await this.app.vault.create(fname, lines.join("\n"));
      new Notice(this.tr("exportDone"));
    } catch (e) {
      new Notice(`${this.tr("exportFailed")}${(e as Error).message}`);
    }
  }

  /** Clear the current conversation (with confirmation) and delete its session. */
  private clearCurrentSession(): void {
    if (this.busy) return;
    new ConfirmModal(
      this.app,
      this.tr("clearConfirmTitle"),
      this.tr("clearConfirmMsg"),
      this.tr("clearCurrent"),
      () => {
        const id = this.sessionId;
        this.resetConversation();
        if (id) void this.store.delete(id);
      }
    ).open();
  }

  // ---------- @ file references ----------

  private updateSuggestions(): void {
    const caret = this.inputEl.selectionStart ?? 0;
    const upToCaret = this.inputEl.value.slice(0, caret);
    const at = upToCaret.lastIndexOf("@");
    if (at < 0 || upToCaret.slice(at).includes("\n")) { this.closeSuggestions(); return; }
    // '@' must start a token (beginning of text or after whitespace).
    if (at > 0 && !/\s/.test(upToCaret[at - 1])) { this.closeSuggestions(); return; }
    const query = upToCaret.slice(at + 1).toLowerCase();
    this.suggestFiles = this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.toLowerCase().includes(query))
      .sort((a, b) => a.path.length - b.path.length)
      .slice(0, MAX_SUGGESTIONS);
    this.suggestFrom = at;
    this.suggestIdx = 0;
    this.renderSuggestions();
  }

  private renderSuggestions(): void {
    const el = this.suggestEl;
    if (!el) return;
    el.empty();
    if (this.suggestFiles.length === 0) {
      el.style.display = "none";
      return;
    }
    this.suggestFiles.forEach((f, i) => {
      const item = el.createDiv({ cls: `agent-suggest-item${i === this.suggestIdx ? " is-active" : ""}` });
      item.setText(f.path);
      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep textarea focus
        this.pickSuggestion(f);
      });
    });
    el.style.display = "block";
  }

  private pickSuggestion(file: TFile): void {
    const caret = this.inputEl.selectionStart ?? 0;
    const before = this.inputEl.value.slice(0, this.suggestFrom);
    const after = this.inputEl.value.slice(caret);
    const inserted = `@${file.path} `;
    this.inputEl.value = before + inserted + after;
    const pos = (before + inserted).length;
    this.inputEl.setSelectionRange(pos, pos);
    this.closeSuggestions();
    this.inputEl.focus();
  }

  private closeSuggestions(): void {
    this.suggestFiles = [];
    this.suggestFrom = -1;
    if (this.suggestEl) this.suggestEl.style.display = "none";
  }

  /** Expand @path references in the message into file contents for the model. */
  private async buildPayload(text: string): Promise<string> {
    const refs = this.app.vault.getMarkdownFiles()
      .filter((f) => text.includes(`@${f.path}`))
      .slice(0, MAX_FILE_REFS);
    if (refs.length === 0) return text;
    const cfg = {
      enabled: this.plugin.settings.truncateEnabled !== false,
      maxLines: this.plugin.settings.truncateMaxLines > 0 ? this.plugin.settings.truncateMaxLines : 200,
    };
    const parts: string[] = [];
    for (const f of refs) {
      try {
        const content = truncateText(await this.app.vault.read(f), cfg);
        parts.push(`<file path="${f.path}">\n${content}\n</file>`);
      } catch {
        // Skip unreadable files silently.
      }
    }
    if (parts.length === 0) return text;
    return `${text}\n\n<referenced-files>\n${parts.join("\n\n")}\n</referenced-files>`;
  }

  /** Downscale/compress an image file to base64 (keeps quality, drops size). */
  private compressImage(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read image"));
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > height && width > MAX_IMAGE_SIDE) {
            height = Math.round(height * (MAX_IMAGE_SIDE / width));
            width = MAX_IMAGE_SIDE;
          } else if (height > MAX_IMAGE_SIDE) {
            width = Math.round(width * (MAX_IMAGE_SIDE / height));
            height = MAX_IMAGE_SIDE;
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) { reject(new Error("Canvas not supported")); return; }
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
        };
        img.onerror = () => reject(new Error("Image failed to decode"));
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    });
  }

  /** Queue an image for sending (compressed, shown as a thumbnail preview). */
  private async addPendingImage(file: File): Promise<void> {
    if (this.imageInput) this.imageInput.value = "";
    try {
      const data = await this.compressImage(file);
      this.pendingImages.push({ data, name: file.name || "image" });
      this.renderPreview();
    } catch (e) {
      new Notice(`${this.tr("visionError")}${(e as Error).message}`);
    }
  }

  private removePendingImage(idx: number): void {
    this.pendingImages.splice(idx, 1);
    this.renderPreview();
  }

  private renderPreview(): void {
    const row = this.previewRow;
    if (!row) return;
    row.empty();
    if (this.pendingImages.length === 0) return;
    this.pendingImages.forEach((img, i) => {
      const item = row.createDiv({ cls: "agent-preview-item" });
      const thumb = item.createEl("img", { cls: "agent-preview-thumb" });
      thumb.src = `data:image/jpeg;base64,${img.data}`;
      const del = item.createEl("button", { cls: "agent-preview-del", attr: { "aria-label": this.tr("removeImage") } });
      setIcon(del, "x");
      del.addEventListener("click", () => this.removePendingImage(i));
    });
  }

  /** Recognize the given images (background) and return per-image text. */
  private async recognizePending(images: Array<{ data: string; name: string }>): Promise<string[]> {
    const { visionEnabled, visionBaseUrl, visionApiKey, visionModel } = this.plugin.settings;
    if (images.length === 0) return [];
    if (!visionEnabled) {
      new Notice(this.tr("visionNotEnabled"));
      return [];
    }
    if (!visionApiKey) {
      new Notice(this.tr("visionNoKey"));
      return [];
    }
    const out: string[] = [];
    for (const img of images) {
      try {
        const text = await visionDescribe({
          baseUrl: visionBaseUrl,
          apiKey: visionApiKey,
          model: visionModel,
          images: [img.data],
        });
        out.push(text);
      } catch (e) {
        new Notice(`${this.tr("visionError")}${(e as Error).message}`);
        out.push("");
      }
    }
    return out;
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    const hasImages = this.pendingImages.length > 0;
    if ((!text && !hasImages) || this.busy) return;
    if (!this.plugin.settings.apiKey) {
      new Notice(this.tr("noApiKey"));
      return;
    }

    this.busy = true;
    this.sendBtn.disabled = false;
    setIcon(this.sendBtn, "square"); // stop icon while running
    this.sendBtn.setAttr("aria-label", this.tr("stop"));
    this.inputEl.value = "";
    this.closeSuggestions();

    const sentAt = Date.now();
    const sentImages = this.pendingImages.slice();
    const promptText = text;
    this.pendingImages = [];
    this.renderPreview();

    // Recognize attached images in the background, then combine with the text.
    const recognized = await this.recognizePending(sentImages);
    const recogBlock = recognized
      .filter((r) => r && r.trim().length > 0)
      .map((r) => `[图片识别内容]\n${r.trim()}`)
      .join("\n\n");
    const modelInput = [recogBlock, text].filter((p) => p && p.trim().length > 0).join("\n\n");

    // User bubble shows thumbnails + the original text.
    this.addUserBubble(sentImages, promptText, sentAt);

    const payload = await this.buildPayload(modelInput);

    // Persist this user message (recognition hidden from display, kept in content).
    this.history.push({
      role: "user",
      content: modelInput,
      prompt: promptText,
      images: sentImages.map((i) => i.data),
      ts: sentAt,
    });

    // Refresh agent in case settings changed.
    this.agent = new ObsidianAgent(this.app, this.plugin.settings, this.plugin.consent, this.plugin.undo);

    // Live assistant bubble: re-renders markdown as text streams in.
    const liveEl = this.messagesEl.createDiv({ cls: "agent-msg agent-msg-assistant agent-msg-live" });
    const liveMeta = liveEl.createDiv({ cls: "agent-msg-meta" });
    const liveAvatar = liveMeta.createDiv({ cls: "agent-msg-avatar is-ai", text: this.plugin.settings.aiAvatar || "🤖" });
    liveMeta.createSpan({ cls: "agent-msg-name", text: this.tr("assistantLabel") });
    const liveContent = liveEl.createDiv({ cls: "agent-msg-content" });
    const cursor = liveContent.createSpan({ cls: "agent-typing-cursor", text: "▊" });

    const renderLive = (md: string): void => {
      liveContent.empty();
      if (md) MarkdownRenderer.render(this.app, md, liveContent, "", this);
      liveContent.appendChild(cursor);
      if (this.plugin.settings.autoScroll !== false) {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      }
    };
    renderLive("");

    try {
      let lastAssistant = "";
      // Collapsible panels for thinking and tool calls (single-use per turn).
      // The thinking panel is created up front (collapsed) so every reply has
      // the two-part structure: a thinking box on top + the answer below.
      const showTools = this.plugin.settings.showToolCalls !== false;
      const collapsedThinking = this.plugin.settings.thinkingCollapsed !== false;
      const thinkingPanel = this.createPanel(this.tr("thinkingLabel"), collapsedThinking, undefined, liveEl);
      let hasThinking = false;
      const thinkingPlaceholder = thinkingPanel.body.createSpan({ cls: "agent-panel-thinking-placeholder", text: this.tr("thinkingPlaceholder") });
      let toolPanel: { body: HTMLElement } | null = null;

      this.history = await this.agent.run(this.history, payload, (e) => {
        if (e.type === "usage" && e.usage) {
          this.lastUsage = {
            cache_hit_tokens: e.usage.cache_hit_tokens,
            cache_miss_tokens: e.usage.cache_miss_tokens,
          };
          this.updateUsage();
          return;
        }
        if (e.type === "assistant") {
          lastAssistant = e.content;
          renderLive(e.content);
        } else if (e.type === "thinking") {
          hasThinking = true;
          thinkingPlaceholder?.remove();
          // Append, don't replace: reasoning + every intermediate narration
          // line stays visible in the one collapsible process panel.
          thinkingPanel.body.createDiv({ cls: "agent-panel-thinking-line", text: e.content });
        } else if (e.type === "tool_call") {
          if (!showTools) return;
          if (!toolPanel) {
            toolPanel = this.createPanel(this.tr("toolCallsLabel"), true, undefined, liveEl);
          }
          const line = toolPanel.body.createDiv({ cls: "agent-panel-tool" });
          const name = line.createSpan({ cls: "agent-panel-tool-name" });
          name.setText(`⚙ ${e.name}`);
          line.createSpan({ cls: "agent-panel-tool-args", text: e.content });
        } else if (e.type === "tool_result") {
          if (!showTools) return;
          if (!toolPanel) {
            toolPanel = this.createPanel(this.tr("toolCallsLabel"), true, undefined, liveEl);
          }
          const short = e.content.length > 300 ? e.content.slice(0, 300) + "…" : e.content;
          const res = toolPanel.body.createDiv({ cls: "agent-panel-tool-result" });
          res.createSpan({ text: `↳ ${short}` });
        }
      });
      if (!lastAssistant) renderLive(this.tr("noTextAnswer"));
      if (!hasThinking) {
        thinkingPanel.body.empty();
        thinkingPanel.body.createSpan({ cls: "agent-panel-thinking-placeholder", text: this.tr("thinkingEmpty") });
      }
      // Stamp timestamps on the newest messages if missing (persisted history).
      for (let i = this.history.length - 1; i >= 0; i--) {
        const m = this.history[i];
        if (m.ts !== undefined) break;
        if (m.role === "user" || m.role === "assistant") m.ts = sentAt;
      }
      // Convert the live bubble into a copyable static bubble.
      if (lastAssistant) {
        liveEl.remove();
        const lastTs = this.history.length > 0 ? this.history[this.history.length - 1].ts : sentAt;
        this.addBubble("agent-msg-assistant", lastAssistant, { markdown: true, copyable: true, ts: lastTs });
      }
      if (this.plugin.settings.autoScroll !== false) {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      }
      // Persist the conversation.
      this.sessionId = await this.store.save(this.history, this.sessionId);
      this.refreshSessionPicker();
    } catch (e) {
      renderLive(`Error: ${(e as Error).message}`);
      new Notice(`Agent error: ${(e as Error).message}`);
    } finally {
      this.busy = false;
      setIcon(this.sendBtn, "send");
      this.sendBtn.setAttr("aria-label", this.tr("send"));
      this.sendBtn.disabled = false;
    }
  }

  async onClose(): Promise<void> {
    this.keyboardObserver?.disconnect();
    this.keyboardObserver = undefined;
  }
}
