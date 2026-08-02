// OpenClaw-style agent workspace: an AGENT/ folder at the vault root holding
// the agent's long-term memory and reusable skills.
//
//   AGENT/
//     memory.md        — long-term memory, injected into the system prompt
//     skills/
//       *.md           — skill files; YAML frontmatter `description` (or the
//                        first paragraph) is listed in the system prompt, the
//                        full body is loaded on demand via the read_skill tool

import { App, TFile, TFolder, normalizePath } from "obsidian";

export const AGENT_DIR = "AGENT";
export const MEMORY_PATH = "AGENT/memory.md";
export const SKILLS_DIR = "AGENT/skills";

const MEMORY_TEMPLATE = `# Agent Memory

Long-term facts the agent should remember across sessions.
The agent updates this file with the update_memory tool.

## User preferences

## Vault conventions

## Facts learned
`;

const EXAMPLE_SKILL = `---
name: example-skill
description: Example skill — describes a reusable procedure the agent can follow.
---

# Example Skill

Describe a reusable, step-by-step procedure here. When the system prompt lists
this skill's description, the agent can call read_skill("example-skill") to load
these full instructions and follow them.

Delete this file and add your own skills, e.g. "weekly-review.md".
`;

export async function ensureAgentWorkspace(app: App): Promise<void> {
  const vault = app.vault;
  if (!vault.getAbstractFileByPath(AGENT_DIR)) {
    await vault.createFolder(AGENT_DIR);
  }
  if (!vault.getAbstractFileByPath(MEMORY_PATH)) {
    await vault.create(MEMORY_PATH, MEMORY_TEMPLATE);
  }
  if (!vault.getAbstractFileByPath(SKILLS_DIR)) {
    await vault.createFolder(SKILLS_DIR);
    await vault.create(`${SKILLS_DIR}/example-skill.md`, EXAMPLE_SKILL);
  }
}

export async function loadMemory(app: App): Promise<string> {
  const f = app.vault.getAbstractFileByPath(MEMORY_PATH);
  if (f instanceof TFile) return app.vault.read(f);
  return "";
}

export async function appendMemory(app: App, section: string, entry: string): Promise<void> {
  const f = app.vault.getAbstractFileByPath(MEMORY_PATH);
  if (!(f instanceof TFile)) throw new Error("memory.md missing");
  const content = await app.vault.read(f);
  const heading = `## ${section}`;
  if (content.includes(heading)) {
    await app.vault.modify(f, content.replace(heading, `${heading}\n- ${entry}`));
  } else {
    await app.vault.modify(f, `${content.trimEnd()}\n\n${heading}\n- ${entry}\n`);
  }
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

export async function listSkills(app: App): Promise<SkillInfo[]> {
  const dir = app.vault.getAbstractFileByPath(SKILLS_DIR);
  if (!(dir instanceof TFolder)) return [];
  const skills: SkillInfo[] = [];
  for (const child of dir.children) {
    if (!(child instanceof TFile) || child.extension !== "md") continue;
    const cache = app.metadataCache.getFileCache(child);
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    let description = typeof fm?.description === "string" ? fm.description : "";
    if (!description) {
      const body = (await app.vault.read(child))
        .replace(/^---[\s\S]*?---/, "")
        .trim();
      description = body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
    }
    skills.push({
      name: (typeof fm?.name === "string" ? fm.name : child.basename),
      description: description.slice(0, 200),
      path: child.path,
    });
  }
  return skills;
}

export async function readSkill(app: App, name: string): Promise<string> {
  const skills = await listSkills(app);
  const q = name.toLowerCase();
  const hit = skills.find(
    (s) => s.name.toLowerCase() === q || s.path.toLowerCase() === normalizePath(name).toLowerCase()
  );
  if (!hit) throw new Error(`Skill not found: ${name}. Available: ${skills.map((s) => s.name).join(", ") || "(none)"}`);
  const f = app.vault.getAbstractFileByPath(hit.path);
  return f instanceof TFile ? app.vault.read(f) : "";
}
