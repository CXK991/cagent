// Multi-session persistence: conversations are stored as JSON in the plugin
// folder and restored across restarts. Capped at 20 sessions / 200 messages each.

import { App } from "obsidian";
import type { ChatMessage } from "./openai";

export interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
}

const SESSIONS_PATH = ".obsidian/plugins/agent/sessions.json";
const MAX_SESSIONS = 20;
const MAX_MESSAGES = 200;

export class SessionStore {
  private sessions: ChatSession[] = [];

  constructor(private app: App) {}

  async load(): Promise<void> {
    try {
      if (await this.app.vault.adapter.exists(SESSIONS_PATH)) {
        const raw = await this.app.vault.adapter.read(SESSIONS_PATH);
        const parsed = JSON.parse(raw);
        this.sessions = Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      this.sessions = [];
    }
  }

  /** Most recently updated first. */
  list(): ChatSession[] {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): ChatSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /** Create or update a session from a message history. Returns the session id. */
  async save(messages: ChatMessage[], id?: string): Promise<string> {
    const now = Date.now();
    let session = id ? this.get(id) : undefined;
    const kept = messages.slice(-MAX_MESSAGES);
    if (!session) {
      session = {
        id: `s-${now}-${Math.random().toString(36).slice(2, 8)}`,
        title: deriveTitle(kept),
        updatedAt: now,
        messages: kept,
      };
      this.sessions.push(session);
    } else {
      session.messages = kept;
      session.updatedAt = now;
      if (session.title === "(new chat)") session.title = deriveTitle(kept);
    }
    // Evict oldest beyond the cap.
    this.sessions = this.list().slice(0, MAX_SESSIONS);
    await this.persist();
    return session.id;
  }

  private async persist(): Promise<void> {
    try {
      await this.app.vault.adapter.write(SESSIONS_PATH, JSON.stringify(this.sessions));
    } catch (e) {
      console.error("[agent] failed to persist sessions", e);
    }
  }
}

function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content);
  if (!firstUser || !firstUser.content) return "(new chat)";
  const clean = firstUser.content.split("\n")[0].trim();
  return clean.length > 40 ? clean.slice(0, 40) + "…" : clean;
}
