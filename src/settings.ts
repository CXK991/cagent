import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { ProfileManagerModal } from "./profileModal";
import { listModels, testConnection } from "./openai";
import { LANG_OPTIONS, t, type Key, type Lang } from "./i18n";
import type AgentPlugin from "./main";

/** One saved model configuration: endpoint + key + model, switchable from chat. */
export interface ModelProfile {
  id: string;
  /** Display name, e.g. "DeepSeek 原生" or "Coding Plan". */
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AgentSettings {
  /** Flat snapshot of the ACTIVE profile (kept in sync via syncActiveProfile),
   * so the agent can keep reading live fields with no changes. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** All saved model configurations. */
  profiles: ModelProfile[];
  /** Which profile is currently active. */
  activeProfileId: string;
  /** Quick provider preset; "custom" = manual baseUrl/model. (Legacy: preset UI
   * replaced by profiles, field kept for old data.) */
  providerPreset: string;
  /** UI language. */
  language: Lang;
  /** Vision model used to recognize images before they reach the text model. */
  visionEnabled: boolean;
  visionBaseUrl: string;
  visionApiKey: string;
  visionModel: string;
  /** Web search (Tavily) — enables the AI to search the internet. */
  searchEnabled: boolean;
  searchApiKey: string;
  /** Sampling temperature (0–2). */
  temperature: number;
  /** Max completion tokens. */
  maxTokens: number;
  /** Custom system prompt prepended to the default. Empty = default only. */
  systemPromptOverride: string;
  /** Whether the "thinking" panel is collapsed by default. */
  thinkingCollapsed: boolean;
  /** Whether tool-call activity is shown in chat. */
  showToolCalls: boolean;
  /** Drop past tool messages + tool_calls from what's sent to the API.
   * Saves tokens, cache-friendly; the model only needs the final text. */
  compactToolRounds: boolean;
  /** Sliding window: only the last N messages are sent. 0 = off.
   * NOTE: trades prompt-cache hit rate for token savings. */
  maxContextMessages: number;
  /** Auto-scroll to the newest message. */
  autoScroll: boolean;
  /** Custom avatar text (emoji or short text) for the user. */
  userAvatar: string;
  /** Custom avatar text (emoji or short text) for the AI. */
  aiAvatar: string;
  maxIterations: number;
  unlimitedIterations: boolean;
  openMode: "sidebar" | "tab";
  /** On phones, always open the chat as a full-screen tab (no half-screen drawer). */
  mobileFullscreen: boolean;
  /** Directory for AI-generated diagrams (SVG / excalidraw / notes). */
  diagramDir: string;
  /** Default format for block / signal-flow diagrams. */
  diagramFormat: "mermaid" | "excalidraw";
  /** Append the diagram note into the currently open note. */
  autoInsertDiagram: boolean;
  requireConsent: boolean;
  truncateEnabled: boolean;
  truncateMaxLines: number;
}

/** Quick provider presets: fill in baseUrl + a sensible default model. */
export const PROVIDER_PRESETS: Array<{
  id: string;
  label: string;
  baseUrl: string;
  model: string;
}> = [
  { id: "custom", label: "Custom", baseUrl: "", model: "" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "dashscope", label: "通义千问 (DashScope)", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
];

export const DEFAULT_SETTINGS: AgentSettings = {
  baseUrl: "",
  apiKey: "",
  model: "",
  profiles: [],
  activeProfileId: "",
  providerPreset: "custom",
  language: "zh",
  visionEnabled: false,
  visionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  visionApiKey: "",
  visionModel: "qwen-vl-max",
  searchEnabled: false,
  searchApiKey: "",
  temperature: 0.7,
  maxTokens: 8192,
  systemPromptOverride: "",
  thinkingCollapsed: true,
  showToolCalls: true,
  compactToolRounds: true,
  maxContextMessages: 0,
  autoScroll: true,
  userAvatar: "🧑",
  aiAvatar: "🤖",
  maxIterations: 10,
  unlimitedIterations: false,
  openMode: "sidebar",
  mobileFullscreen: true,
  diagramDir: "Cagent-Diagrams",
  diagramFormat: "mermaid",
  autoInsertDiagram: true,
  requireConsent: true,
  truncateEnabled: true,
  truncateMaxLines: 200,
};

let profileSeq = 0;
export function newProfileId(): string {
  profileSeq += 1;
  return `p-${Date.now()}-${profileSeq}`;
}

/** Copy the ACTIVE profile's fields into the flat baseUrl/apiKey/model so the
 * agent (which reads those live) keeps working unchanged. */
export function syncActiveProfile(s: AgentSettings): void {
  const p = s.profiles.find((x) => x.id === s.activeProfileId);
  if (p) {
    s.baseUrl = p.baseUrl;
    s.apiKey = p.apiKey;
    s.model = p.model;
  }
}

/** Seed/migrate profiles. Called after settings load: old data without a
 * profiles array gets one default profile built from the legacy flat fields. */
export function ensureProfiles(s: AgentSettings): void {
  if (!Array.isArray(s.profiles) || s.profiles.length === 0) {
    const seed: ModelProfile = {
      id: newProfileId(),
      name: "默认",
      baseUrl: s.baseUrl || PROVIDER_PRESETS[1].baseUrl,
      apiKey: s.apiKey || "",
      model: s.model || PROVIDER_PRESETS[1].model,
    };
    s.profiles = [seed];
    s.activeProfileId = seed.id;
  } else if (!s.profiles.some((x) => x.id === s.activeProfileId)) {
    s.activeProfileId = s.profiles[0].id;
  }
  syncActiveProfile(s);
}

export class AgentSettingTab extends PluginSettingTab {

  constructor(app: App, private plugin: AgentPlugin) {
    super(app, plugin);
  }

  /** Translate a key in the currently selected UI language. */
  private tr(key: Key, vars?: Record<string, string | number>): string {
    return t(this.plugin.settings.language, key, vars);
  }

  /** Section heading (Copilot-style grouping). */
  private section(containerEl: HTMLElement, title: string): void {
    containerEl.createEl("h3", { cls: "cagent-section-title", text: title });
  }

  /** Model configs live in a dedicated dialog so the settings page stays short. */
  private renderProfiles(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const active = s.profiles.find((x) => x.id === s.activeProfileId);
    const summary = active
      ? `${active.name || this.tr("unnamedProfile")} · ${active.model || "?"}`
      : this.tr("noProfiles");
    new Setting(containerEl)
      .setName(this.tr("secProfiles"))
      .setDesc(summary)
      .addButton((b) =>
        b.setButtonText(this.tr("manageProfiles")).setCta().onClick(() => {
          new ProfileManagerModal(this.app, this.plugin).open();
        })
      );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ---- General ----
    this.section(containerEl, this.tr("secGeneral"));

    new Setting(containerEl)
      .setName(this.tr("language"))
      .setDesc(this.tr("languageDesc"))
      .addDropdown((d) => {
        for (const opt of LANG_OPTIONS) d.addOption(opt.id, opt.label);
        d.setValue(this.plugin.settings.language).onChange(async (v) => {
          this.plugin.settings.language = v as Lang;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    // ---- Model profiles ----
    this.section(containerEl, this.tr("secProfiles"));
    this.renderProfiles(containerEl);

    // Model parameters (temperature / max tokens).
    const tempSetting = new Setting(containerEl)
      .setName(this.tr("temperature"))
      .setDesc(this.tr("temperatureDesc"))
      .addSlider((s) => {
        const valueEl = containerEl.createSpan({ cls: "agent-slider-value", text: this.plugin.settings.temperature.toFixed(1) });
        s.setLimits(0, 200, 5)
          .setValue(Math.round(this.plugin.settings.temperature * 100))
          .onChange(async (v) => {
            this.plugin.settings.temperature = v / 100;
            valueEl.setText((v / 100).toFixed(1));
            await this.plugin.saveSettings();
          });
        s.sliderEl.addClass("agent-slider");
      });

    new Setting(containerEl)
      .setName(this.tr("maxTokens"))
      .setDesc(this.tr("maxTokensDesc"))
      .addSlider((s) => {
        const valueEl = containerEl.createSpan({ cls: "agent-slider-value", text: String(this.plugin.settings.maxTokens) });
        s.setLimits(256, 16384, 256)
          .setValue(this.plugin.settings.maxTokens)
          .onChange(async (v) => {
            this.plugin.settings.maxTokens = v;
            valueEl.setText(String(v));
            await this.plugin.saveSettings();
          });
        s.sliderEl.addClass("agent-slider");
      });

    // Custom system prompt.
    new Setting(containerEl)
      .setName(this.tr("systemPrompt"))
      .setDesc(this.tr("systemPromptDesc"))
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.systemPromptOverride).onChange(async (v) => {
          this.plugin.settings.systemPromptOverride = v;
          await this.plugin.saveSettings();
        });
        ta.inputEl.rows = 4;
      });

    // ---- Vision model (image recognition) ----
    this.section(containerEl, this.tr("secVision"));
    new Setting(containerEl)
      .setName(this.tr("vision"))
      .setDesc(this.tr("visionDesc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.visionEnabled).onChange(async (v) => {
          this.plugin.settings.visionEnabled = v;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.visionEnabled) {
      new Setting(containerEl)
        .setName(this.tr("visionBaseUrl"))
        .setDesc(this.tr("visionBaseUrlDesc"))
        .addText((t) =>
          t.setValue(this.plugin.settings.visionBaseUrl).onChange(async (v) => {
            this.plugin.settings.visionBaseUrl = v.trim();
            await this.plugin.saveSettings();
          })
        );

      new Setting(containerEl)
        .setName(this.tr("visionApiKey"))
        .setDesc(this.tr("visionApiKeyDesc"))
        .addText((t) => {
          t.inputEl.type = "password";
          t.setValue(this.plugin.settings.visionApiKey).onChange(async (v) => {
            this.plugin.settings.visionApiKey = v.trim();
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName(this.tr("visionModel"))
        .setDesc(this.tr("visionModelDesc"))
        .addText((t) =>
          t.setValue(this.plugin.settings.visionModel).onChange(async (v) => {
            this.plugin.settings.visionModel = v.trim();
            await this.plugin.saveSettings();
          })
        );
    }

    // ---- Web search (Tavily) ----
    this.section(containerEl, this.tr("secSearch"));
    new Setting(containerEl)
      .setName(this.tr("search"))
      .setDesc(this.tr("searchDesc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.searchEnabled).onChange(async (v) => {
          this.plugin.settings.searchEnabled = v;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.searchEnabled) {
      new Setting(containerEl)
        .setName(this.tr("searchApiKey"))
        .setDesc(this.tr("searchApiKeyDesc"))
        .addText((t) => {
          t.inputEl.type = "password";
          t.setValue(this.plugin.settings.searchApiKey).onChange(async (v) => {
            this.plugin.settings.searchApiKey = v.trim();
            await this.plugin.saveSettings();
          });
        });
    }

    new Setting(containerEl)
      .setName(this.tr("openMode"))
      .setDesc(this.tr("openModeDesc"))
      .addDropdown((d) =>
        d
          .addOption("sidebar", this.tr("halfScreen"))
          .addOption("tab", this.tr("fullScreen"))
          .setValue(this.plugin.settings.openMode)
          .onChange(async (v) => {
            this.plugin.settings.openMode = v as "sidebar" | "tab";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(this.tr("mobileFullscreen"))
      .setDesc(this.tr("mobileFullscreenDesc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.mobileFullscreen).onChange(async (v) => {
          this.plugin.settings.mobileFullscreen = v;
          await this.plugin.saveSettings();
        })
      );

    // ---- Diagram tool ----
    this.section(containerEl, this.tr("secDiagram"));
    new Setting(containerEl)
      .setName(this.tr("diagramDir"))
      .setDesc(this.tr("diagramDirDesc"))
      .addText((txt) =>
        txt.setValue(this.plugin.settings.diagramDir).onChange(async (v) => {
          this.plugin.settings.diagramDir = v.trim() || "Cagent-Diagrams";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(this.tr("diagramFormat"))
      .setDesc(this.tr("diagramFormatDesc"))
      .addDropdown((d) =>
        d
          .addOption("mermaid", this.tr("formatMermaid"))
          .addOption("excalidraw", this.tr("formatExcalidraw"))
          .setValue(this.plugin.settings.diagramFormat)
          .onChange(async (v) => {
            this.plugin.settings.diagramFormat = v as "mermaid" | "excalidraw";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(this.tr("autoInsertDiagram"))
      .setDesc(this.tr("autoInsertDiagramDesc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.autoInsertDiagram).onChange(async (v) => {
          this.plugin.settings.autoInsertDiagram = v;
          await this.plugin.saveSettings();
        })
      );

    const sliderSetting = new Setting(containerEl)
      .setName(this.tr("maxIterations"))
      .setDesc(this.tr("maxIterationsDesc"))
      .addSlider((s) => {
        const valueEl = containerEl.createSpan({ cls: "agent-slider-value", text: String(this.plugin.settings.maxIterations) });
        s.setLimits(1, 30, 1)
          .setValue(this.plugin.settings.maxIterations)
          .onChange(async (v) => {
            this.plugin.settings.maxIterations = v;
            valueEl.setText(String(v));
            await this.plugin.saveSettings();
          });
        s.sliderEl.addClass("agent-slider");
      });

    new Setting(containerEl)
      .setName(this.tr("unlimited"))
      .setDesc(this.tr("unlimitedDesc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.unlimitedIterations).onChange(async (v) => {
          this.plugin.settings.unlimitedIterations = v;
          sliderSetting.setDisabled(v);
          await this.plugin.saveSettings();
        })
      );
    sliderSetting.setDisabled(this.plugin.settings.unlimitedIterations);

    new Setting(containerEl)
      .setName(this.tr("requireConsent"))
      .setDesc(this.tr("requireConsentDesc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.requireConsent).onChange(async (v) => {
          this.plugin.settings.requireConsent = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(this.tr("truncate"))
      .setDesc(this.tr("truncateDesc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.truncateEnabled).onChange(async (v) => {
          this.plugin.settings.truncateEnabled = v;
          linesSetting.setDisabled(!v);
          await this.plugin.saveSettings();
        })
      );

    const linesSetting = new Setting(containerEl)
      .setName(this.tr("maxLines"))
      .setDesc(this.tr("maxLinesDesc"))
      .addSlider((s) => {
        const valueEl = containerEl.createSpan({ cls: "agent-slider-value", text: String(this.plugin.settings.truncateMaxLines) });
        s.setLimits(10, 2000, 10)
          .setValue(this.plugin.settings.truncateMaxLines)
          .onChange(async (v) => {
            this.plugin.settings.truncateMaxLines = v;
            valueEl.setText(String(v));
            await this.plugin.saveSettings();
          });
        s.sliderEl.addClass("agent-slider");
      });
    linesSetting.setDisabled(!this.plugin.settings.truncateEnabled);

    // ---- Context management ----
    this.section(containerEl, this.tr("secContext"));

    new Setting(containerEl)
      .setName(this.tr("compactToolRounds"))
      .setDesc(this.tr("compactToolRoundsDesc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.compactToolRounds).onChange(async (v) => {
          this.plugin.settings.compactToolRounds = v;
          await this.plugin.saveSettings();
        })
      );

    const winValueEl = containerEl.createSpan({
      cls: "agent-slider-value",
      text: this.plugin.settings.maxContextMessages === 0
        ? this.tr("off")
        : String(this.plugin.settings.maxContextMessages),
    });
    new Setting(containerEl)
      .setName(this.tr("maxContext"))
      .setDesc(this.tr("maxContextDesc"))
      .addSlider((s) => {
        s.setLimits(0, 200, 10)
          .setValue(this.plugin.settings.maxContextMessages)
          .onChange(async (v) => {
            this.plugin.settings.maxContextMessages = v;
            winValueEl.setText(v === 0 ? this.tr("off") : String(v));
            await this.plugin.saveSettings();
          });
        s.sliderEl.addClass("agent-slider");
      });

    // ---- Chat display ----
    this.section(containerEl, this.tr("secChat"));

    new Setting(containerEl)
      .setName(this.tr("thinkingCollapsed"))
      .setDesc(this.tr("thinkingCollapsedDesc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.thinkingCollapsed).onChange(async (v) => {
          this.plugin.settings.thinkingCollapsed = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(this.tr("showToolCalls"))
      .setDesc(this.tr("showToolCallsDesc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.showToolCalls).onChange(async (v) => {
          this.plugin.settings.showToolCalls = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(this.tr("autoScroll"))
      .setDesc(this.tr("autoScrollDesc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.autoScroll).onChange(async (v) => {
          this.plugin.settings.autoScroll = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(this.tr("userAvatar"))
      .setDesc(this.tr("userAvatarDesc"))
      .addText((t) =>
        t.setValue(this.plugin.settings.userAvatar).onChange(async (v) => {
          this.plugin.settings.userAvatar = v.trim() || "🧑";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(this.tr("aiAvatar"))
      .setDesc(this.tr("aiAvatarDesc"))
      .addText((t) =>
        t.setValue(this.plugin.settings.aiAvatar).onChange(async (v) => {
          this.plugin.settings.aiAvatar = v.trim() || "🤖";
          await this.plugin.saveSettings();
        })
      );

    // ---- History ----
    this.section(containerEl, this.tr("secHistory"));
    new Setting(containerEl)
      .setName(this.tr("clearHistory"))
      .setDesc(this.tr("clearHistoryDesc"))
      .addButton((b) =>
        b.setButtonText(this.tr("clearHistory"))
          .setWarning()
          .onClick(async () => {
            await this.plugin.store.clearAll();
            new Notice(this.tr("historyCleared"));
          })
      );
  }
}
