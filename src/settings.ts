import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { listModels } from "./openai";
import { LANG_OPTIONS, t, type Key, type Lang } from "./i18n";
import type AgentPlugin from "./main";

export interface AgentSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Quick provider preset; "custom" = manual baseUrl/model. */
  providerPreset: string;
  /** UI language. */
  language: Lang;
  /** Vision model used to recognize images before they reach the text model. */
  visionEnabled: boolean;
  visionBaseUrl: string;
  visionApiKey: string;
  visionModel: string;
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
  /** Auto-scroll to the newest message. */
  autoScroll: boolean;
  /** Custom avatar text (emoji or short text) for the user. */
  userAvatar: string;
  /** Custom avatar text (emoji or short text) for the AI. */
  aiAvatar: string;
  maxIterations: number;
  unlimitedIterations: boolean;
  openMode: "sidebar" | "tab";
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
  providerPreset: "custom",
  language: "zh",
  visionEnabled: false,
  visionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  visionApiKey: "",
  visionModel: "qwen-vl-max",
  temperature: 0.7,
  maxTokens: 4096,
  systemPromptOverride: "",
  thinkingCollapsed: true,
  showToolCalls: true,
  autoScroll: true,
  userAvatar: "🧑",
  aiAvatar: "🤖",
  maxIterations: 10,
  unlimitedIterations: false,
  openMode: "sidebar",
  requireConsent: true,
  truncateEnabled: true,
  truncateMaxLines: 200,
};

export class AgentSettingTab extends PluginSettingTab {
  private fetchedModels: string[] = [];
  private modelManual = false;
  private autoFetched = false;

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

  /** Model picker: dropdown populated from the endpoint's /models, with a
   * refresh button and a manual-input fallback (openagent-style). */
  private renderModelSetting(containerEl: HTMLElement): void {
    const current = this.plugin.settings.model;
    const setting = new Setting(containerEl)
      .setName(this.tr("model"))
      .setDesc(this.tr("modelDesc"));

    if (this.modelManual) {
      setting.addText((tf) =>
        tf.setPlaceholder(this.tr("modelPlaceholder"))
          .setValue(current)
          .onChange(async (v) => {
            this.plugin.settings.model = v.trim();
            await this.plugin.saveSettings();
          })
      );
    } else {
      setting.addDropdown((d) => {
        const options = this.fetchedModels.includes(current)
          ? this.fetchedModels
          : [current, ...this.fetchedModels];
        for (const m of options) d.addOption(m, m || this.tr("notSet"));
        d.setValue(current).onChange(async (v) => {
          this.plugin.settings.model = v;
          await this.plugin.saveSettings();
        });
      });
    }

    setting.addExtraButton((b) =>
      b.setIcon("rotate-cw")
        .setTooltip(this.tr("fetchModels"))
        .onClick(async () => {
          const { baseUrl, apiKey } = this.plugin.settings;
          if (!baseUrl) {
            new Notice(this.tr("setBaseUrlFirst"));
            return;
          }
          new Notice(this.tr("fetchingModels"));
          const models = await listModels(baseUrl, apiKey);
          if (models.length === 0) {
            new Notice(this.tr("noModelsReturned"));
            this.modelManual = true;
          } else {
            new Notice(this.tr("foundModels", { n: models.length }));
            this.fetchedModels = models;
            this.modelManual = false;
          }
          this.display();
        })
    );

    setting.addExtraButton((b) =>
      b.setIcon(this.modelManual ? "list" : "pencil")
        .setTooltip(this.modelManual ? this.tr("switchToDropdown") : this.tr("switchToManual"))
        .onClick(() => {
          this.modelManual = !this.modelManual;
          this.display();
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

    // ---- Main (text) model ----
    this.section(containerEl, this.tr("secTextModel"));

    // Provider preset: quickly fill baseUrl + model.
    new Setting(containerEl)
      .setName(this.tr("provider"))
      .setDesc(this.tr("providerDesc"))
      .addDropdown((d) => {
        for (const p of PROVIDER_PRESETS) d.addOption(p.id, p.label);
        d.setValue(this.plugin.settings.providerPreset).onChange(async (v) => {
          const preset = PROVIDER_PRESETS.find((p) => p.id === v);
          if (preset) {
            this.plugin.settings.providerPreset = preset.id;
            this.plugin.settings.baseUrl = preset.baseUrl;
            this.plugin.settings.model = preset.model;
            await this.plugin.saveSettings();
            this.display();
          }
        });
      });

    new Setting(containerEl)
      .setName(this.tr("baseUrl"))
      .setDesc(this.tr("baseUrlDesc"))
      .addText((t) =>
        t.setValue(this.plugin.settings.baseUrl).onChange(async (v) => {
          this.plugin.settings.baseUrl = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(this.tr("apiKey"))
      .setDesc(this.tr("apiKeyDesc"))
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.apiKey).onChange(async (v) => {
          this.plugin.settings.apiKey = v.trim();
          await this.plugin.saveSettings();
        });
      });

    this.renderModelSetting(containerEl);

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

    new Setting(containerEl)
      .setName(this.tr("openMode"))
      .setDesc(this.tr("openModeDesc"))
      .addDropdown((d) =>
        d
          .addOption("sidebar", this.tr("sidebar"))
          .addOption("tab", this.tr("tab"))
          .setValue(this.plugin.settings.openMode)
          .onChange(async (v) => {
            this.plugin.settings.openMode = v as "sidebar" | "tab";
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

    // Auto-fetch the model list once when the tab opens (if possible).
    if (!this.autoFetched && this.fetchedModels.length === 0 && this.plugin.settings.baseUrl) {
      this.autoFetched = true;
      void listModels(this.plugin.settings.baseUrl, this.plugin.settings.apiKey).then((models) => {
        if (models.length > 0 && !this.modelManual) {
          this.fetchedModels = models;
          this.display();
        }
      });
    }
  }
}
