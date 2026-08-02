// Undo support: mutating vault tools record a snapshot before they run,
// so the last agent-caused change can be reverted with one command.
// Snapshots live in memory only (cleared on restart).

import { App, Notice, TFile, normalizePath } from "obsidian";

export interface ChangeRecord {
  /** Tool that made the change. */
  tool: string;
  /** Primary affected path. */
  path: string;
  /** Content before the change; null if the file did not exist (was created). */
  before: string | null;
  /** Content after the change; null if the file was deleted. */
  after: string | null;
  /** For rename: the new path (undo = rename back). */
  newPath?: string;
  timestamp: number;
}

const MAX_RECORDS = 50;

export class UndoManager {
  private records: ChangeRecord[] = [];

  push(record: Omit<ChangeRecord, "timestamp">): void {
    this.records.push({ ...record, timestamp: Date.now() });
    if (this.records.length > MAX_RECORDS) this.records.shift();
  }

  get size(): number {
    return this.records.length;
  }

  describeLast(): string | null {
    const r = this.records[this.records.length - 1];
    return r ? `${r.tool} → ${r.path}` : null;
  }

  /** Revert the most recent agent change. Returns a human-readable summary. */
  async undoLast(app: App): Promise<string> {
    const r = this.records.pop();
    if (!r) throw new Error("Nothing to undo.");

    if (r.tool === "rename_file" && r.newPath) {
      const f = app.vault.getAbstractFileByPath(normalizePath(r.newPath));
      if (!(f instanceof TFile)) throw new Error(`Cannot undo rename: ${r.newPath} no longer exists.`);
      await app.vault.rename(f, normalizePath(r.path));
      return `Renamed back to ${r.path}`;
    }

    if (r.before === null) {
      // File was created by the agent → trash it.
      const f = app.vault.getAbstractFileByPath(normalizePath(r.path));
      if (f instanceof TFile) await app.fileManager.trashFile(f);
      return `Removed created file ${r.path}`;
    }

    const existing = app.vault.getAbstractFileByPath(normalizePath(r.path));
    if (existing instanceof TFile) {
      // Modified in place → restore previous content.
      await app.vault.modify(existing, r.before);
      return `Restored previous content of ${r.path}`;
    }

    // File was deleted by the agent → recreate with old content.
    const folder = normalizePath(r.path).split("/").slice(0, -1).join("/");
    if (folder && !app.vault.getAbstractFileByPath(folder)) {
      await app.vault.createFolder(folder);
    }
    await app.vault.create(normalizePath(r.path), r.before);
    return `Restored deleted file ${r.path}`;
  }

  /** Undo with user feedback; safe to call from a command. */
  async undoLastWithNotice(app: App): Promise<void> {
    try {
      const summary = await this.undoLast(app);
      new Notice(`Agent undo: ${summary}`);
    } catch (e) {
      new Notice(`Agent undo failed: ${(e as Error).message}`);
    }
  }
}
