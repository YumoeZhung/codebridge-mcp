import fs from "node:fs/promises";
import path from "node:path";

export class SessionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.sessions = {};
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.sessions = JSON.parse(raw);
    } catch {
      this.sessions = {};
    }
    this.loaded = true;
  }

  async save() {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      this.filePath,
      JSON.stringify(this.sessions, null, 2),
      "utf8",
    );
  }

  async getSessionId(provider, workspace) {
    await this.load();
    const key = `${provider}::${workspace}`;
    return this.sessions[key]?.sessionId ?? null;
  }

  async setSessionId(provider, workspace, sessionId) {
    await this.load();
    const key = `${provider}::${workspace}`;
    this.sessions[key] = {
      sessionId,
      provider,
      workspace,
      updatedAt: new Date().toISOString(),
    };
    await this.save();
  }

  async listSessions() {
    await this.load();
    return Object.values(this.sessions);
  }
}
