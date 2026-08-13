// Model-profile manager as a dedicated dialog ("sub-page"). Keeps the main
// settings tab short on mobile: the whole editor lives in this modal instead
// of stretching the settings page with one block per saved model.
import { App, Modal, Notice, Setting } from "obsidian";
import type AgentPlugin from "./main";
import { newProfileId, syncActiveProfile, type ModelProfile } from "./settings";
import { listModels, testConnection } from "./openai";
import { t, type Key } from "./i18n";

export class ProfileManagerModal extends Modal {
  constructor(app: App, private plugin: AgentPlugin) {
    super(app);
  }

  private tr(key: Key, vars?: Record<string, string | number>): string {
    return t(this.plugin.settings.language, key, vars);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("agent-profile-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const s = this.plugin.settings;

    contentEl.createEl("h3", { cls: "agent-profile-modal-title", text: this.tr("secProfiles") });
    contentEl.createDiv({ cls: "cagent-muted", text: this.tr("secProfilesDesc") });

    if (s.profiles.length === 0) {
      contentEl.createDiv({ cls: "cagent-muted", text: this.tr("noProfiles") });
    }
    for (const p of s.profiles) this.renderProfile(contentEl, p);

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText(this.tr("addProfileBtn")).setCta().onClick(async () => {
          s.profiles.push({ id: newProfileId(), name: "", baseUrl: "", apiKey: "", model: "" });
          await this.plugin.saveSettings();
          this.render();
        })
      );
  }

  /** One profile card: name + status row, then the editable fields. */
  private renderProfile(containerEl: HTMLElement, p: ModelProfile): void {
    const s = this.plugin.settings;
    const isActive = p.id === s.activeProfileId;

    const card = containerEl.createDiv({ cls: "agent-profile-card" });

    // Header row: name + active badge + actions.
    new Setting(card)
      .setName(p.name || this.tr("unnamedProfile"))
      .setDesc(isActive ? this.tr("activeNow") : "")
      .addExtraButton((b) =>
        b.setIcon("check-circle")
          .setTooltip(isActive ? this.tr("activeNow") : this.tr("setActive"))
          .onClick(async () => {
            if (!isActive) {
              s.activeProfileId = p.id;
              syncActiveProfile(s);
              await this.plugin.saveSettings();
              this.render();
            }
          })
      )
      .addExtraButton((b) =>
        b.setIcon("trash")
          .setTooltip(this.tr("deleteProfile"))
          .onClick(async () => {
            if (s.profiles.length <= 1) {
              new Notice(this.tr("cannotDeleteLast"));
              return;
            }
            s.profiles = s.profiles.filter((x) => x.id !== p.id);
            if (isActive) {
              s.activeProfileId = s.profiles[0].id;
              syncActiveProfile(s);
            }
            await this.plugin.saveSettings();
            this.render();
          })
      );

    new Setting(card)
      .setName(this.tr("profileName"))
      .addText((t) =>
        t.setPlaceholder(this.tr("profileNamePh"))
          .setValue(p.name)
          .onChange(async (v) => {
            p.name = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(card)
      .setName(this.tr("baseUrl"))
      .addText((t) =>
        t.setPlaceholder("https://api.deepseek.com/v1")
          .setValue(p.baseUrl)
          .onChange(async (v) => {
            p.baseUrl = v.trim();
            if (isActive) syncActiveProfile(s);
            await this.plugin.saveSettings();
          })
      );

    new Setting(card)
      .setName(this.tr("apiKey"))
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(p.apiKey).onChange(async (v) => {
          p.apiKey = v.trim();
          if (isActive) syncActiveProfile(s);
          await this.plugin.saveSettings();
        });
      })
      .addExtraButton((b) =>
        b.setIcon("puzzle")
          .setTooltip(this.tr("testConn"))
          .onClick(async () => {
            new Notice(this.tr("testingConn"));
            const r = await testConnection(p.baseUrl, p.apiKey, p.model);
            if (r.ok) new Notice(this.tr("testOk", { model: r.message }));
            else new Notice(this.tr("testFail") + " " + r.message);
          })
      );

    new Setting(card)
      .setName(this.tr("model"))
      .addText((t) =>
        t.setValue(p.model).onChange(async (v) => {
          p.model = v.trim();
          if (isActive) syncActiveProfile(s);
          await this.plugin.saveSettings();
        })
      )
      .addExtraButton((b) =>
        b.setIcon("rotate-cw")
          .setTooltip(this.tr("fetchModels"))
          .onClick(async () => {
            new Notice(this.tr("fetchingModels"));
            const models = await listModels(p.baseUrl, p.apiKey);
            if (models.length === 0) {
              new Notice(this.tr("noModelsReturned"));
              return;
            }
            p.model = models.includes(p.model) ? p.model : models[0];
            if (isActive) syncActiveProfile(s);
            await this.plugin.saveSettings();
            new Notice(this.tr("foundModels", { n: models.length }));
            this.render();
          })
      );
  }
}