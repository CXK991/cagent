import { Notice, Platform, Plugin, WorkspaceLeaf } from "obsidian";
import { AgentSettings, AgentSettingTab, DEFAULT_SETTINGS, ensureProfiles } from "./settings";
import { AgentChatView, VIEW_TYPE_AGENT_CHAT } from "./chatView";
import { ensureAgentWorkspace } from "./memory";
import { ConsentManager } from "./consent";
import { UndoManager } from "./undo";
import { SessionStore } from "./sessions";
import { t } from "./i18n";

interface SplitNode {
  parent?: SplitNode;
  children?: SplitNode[];
}

export default class AgentPlugin extends Plugin {
  settings!: AgentSettings;
  consent!: ConsentManager;
  undo!: UndoManager;
  store!: SessionStore;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.consent = new ConsentManager(this.app, () => this.settings.requireConsent);
    this.undo = new UndoManager();
    this.store = new SessionStore(this.app);

    // Bootstrap the AGENT/ workspace (memory.md + skills/) in the vault root.
    this.app.workspace.onLayoutReady(() => {
      ensureAgentWorkspace(this.app).catch((e) => {
        console.error("[agent-tools] failed to create AGENT workspace", e);
        new Notice(`Agent Tools: failed to create AGENT folder: ${(e as Error).message}`);
      });
    });

    this.registerView(
      VIEW_TYPE_AGENT_CHAT,
      (leaf) => new AgentChatView(leaf, this)
    );

    this.addRibbonIcon("bot", t(this.settings.language, "openRibbon"), () => {
      void this.activateView(this.settings.openMode);
    });

    this.addCommand({
      id: "open-chat-sidebar",
      name: t(this.settings.language, "openSidebar"),
      callback: () => { void this.activateView("sidebar"); },
    });

    this.addCommand({
      id: "open-chat-tab",
      name: t(this.settings.language, "openTab"),
      callback: () => { void this.activateView("tab"); },
    });

    this.addCommand({
      id: "undo-last-change",
      name: t(this.settings.language, "undoLast"),
      callback: () => { void this.undo.undoLastWithNotice(this.app); },
    });

    this.addSettingTab(new AgentSettingTab(this.app, this));
  }

  async activateView(mode: "sidebar" | "tab" = "sidebar"): Promise<void> {
    const { workspace } = this.app;

    // On mobile, open as a full-screen tab by default — the side drawer
    // only covers half the screen. Users can opt out in settings.
    if (Platform.isMobile && this.settings.mobileFullscreen) {
      mode = "tab";
    }

    // Reuse an existing chat leaf that already lives in the requested area.
    const existing = workspace
      .getLeavesOfType(VIEW_TYPE_AGENT_CHAT)
      .find((leaf) => this.isLeafInArea(leaf, mode));

    let leaf: WorkspaceLeaf | null | undefined = existing;
    if (!leaf) {
      // The chat is already open in the wrong area (e.g. the mobile
      // half-screen drawer) — move it instead of opening a duplicate.
      const misplaced = workspace
        .getLeavesOfType(VIEW_TYPE_AGENT_CHAT)
        .find((l) => !this.isLeafInArea(l, mode));
      leaf =
        mode === "tab"
          ? workspace.getLeaf("tab")
          : workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_AGENT_CHAT, active: true });
        if (misplaced && misplaced !== leaf) misplaced.detach();
      }
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  /** Whether the leaf sits in the root (main tab area) vs. a side dock. */
  private isLeafInArea(leaf: WorkspaceLeaf, mode: "sidebar" | "tab"): boolean {
    const root = (this.app.workspace as unknown as { rootSplit?: SplitNode }).rootSplit;
    let node = leaf as unknown as SplitNode;
    // Walk up the split-tree parents until we hit a root-level child.
    while (node.parent) node = node.parent;
    const inRoot = root?.children?.includes(node) ?? true;
    return mode === "tab" ? inRoot : !inRoot;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Seed/migrate model profiles (old data has no profiles array).
    ensureProfiles(this.settings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
