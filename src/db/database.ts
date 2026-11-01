import Database from "better-sqlite3";
import path from "node:path";
import type { ModelPreferences, Project, Session, SessionStatus } from "./types.js";

const DB_PATH = path.join(process.cwd(), "data.db");

let db: Database.Database;

export function initDatabase(databasePath = DB_PATH): void {
  db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      channel_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      auto_approve INTEGER DEFAULT 0,
      parent_channel_id TEXT REFERENCES projects(channel_id) ON DELETE CASCADE,
      chat_mode TEXT NOT NULL DEFAULT 'threads',
      conversation_state TEXT NOT NULL DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      channel_id TEXT REFERENCES projects(channel_id) ON DELETE CASCADE,
      session_id TEXT,
      status TEXT DEFAULT 'offline',
      last_activity TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channel_model_preferences (
      channel_id TEXT PRIMARY KEY REFERENCES projects(channel_id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      reasoning_effort TEXT
    );

    CREATE TABLE IF NOT EXISTS conversation_history_messages (
      channel_id TEXT NOT NULL REFERENCES projects(channel_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      discord_message_id TEXT NOT NULL,
      PRIMARY KEY (channel_id, session_id, item_key)
    );
    CREATE TABLE IF NOT EXISTS conversation_history_pages (
      channel_id TEXT NOT NULL REFERENCES projects(channel_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      next_cursor TEXT,
      exhausted INTEGER NOT NULL DEFAULT 0,
      page_number INTEGER NOT NULL DEFAULT 0,
      pending_page TEXT,
      PRIMARY KEY (channel_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_hubs (
      guild_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      template_channel_id TEXT,
      assistant_session_id TEXT,
      initialized INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS conversation_categories (
      guild_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      position INTEGER NOT NULL,
      channel_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY (guild_id, kind, position)
    );
    CREATE TABLE IF NOT EXISTS managed_conversations (
      guild_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      channel_id TEXT UNIQUE,
      title TEXT NOT NULL,
      project_path TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      sync_pending INTEGER NOT NULL DEFAULT 1,
      last_error TEXT,
      missing_checks INTEGER NOT NULL DEFAULT 0,
      pending_action TEXT,
      delete_channel_requested INTEGER NOT NULL DEFAULT 0,
      needs_history INTEGER NOT NULL DEFAULT 1,
      origin TEXT NOT NULL DEFAULT 'import',
      PRIMARY KEY (guild_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_create_requests (
      interaction_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      session_id TEXT NOT NULL
    );
  `);

  // Upgrade existing installations without replacing their project/session rows.
  const columns = db.pragma("table_info(projects)") as { name: string }[];
  if (!columns.some((column) => column.name === "parent_channel_id")) {
    db.exec("ALTER TABLE projects ADD COLUMN parent_channel_id TEXT REFERENCES projects(channel_id) ON DELETE CASCADE");
  }
  if (!columns.some((column) => column.name === "chat_mode")) {
    db.exec("ALTER TABLE projects ADD COLUMN chat_mode TEXT NOT NULL DEFAULT 'threads'");
  }
  if (!columns.some((column) => column.name === "conversation_state")) {
    db.exec("ALTER TABLE projects ADD COLUMN conversation_state TEXT NOT NULL DEFAULT 'active'");
  }
  if (!columns.some((column) => column.name === "fixed_session")) {
    db.exec("ALTER TABLE projects ADD COLUMN fixed_session INTEGER NOT NULL DEFAULT 0");
  }
}

export function getDb(): Database.Database {
  return db;
}

// Project queries
export function registerProject(
  channelId: string,
  projectPath: string,
  guildId: string,
): void {
  const stmt = db.prepare(`
    INSERT INTO projects (channel_id, project_path, guild_id)
    VALUES (?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      project_path = excluded.project_path, guild_id = excluded.guild_id
  `);
  stmt.run(channelId, projectPath, guildId);
}

export function registerThreadProject(threadId: string, parentChannelId: string, originalProjectPath?: string): void {
  const parent = getProject(parentChannelId);
  if (!parent || parent.parent_channel_id || threadId === parentChannelId) {
    throw new Error("A conversation must belong to a registered project channel");
  }
  const existing = getProject(threadId);
  if (existing && existing.parent_channel_id !== parentChannelId) {
    throw new Error("This Discord thread is already bound to a different project");
  }
  if (existing && originalProjectPath && existing.project_path !== originalProjectPath) {
    throw new Error("This conversation is already bound to a different working directory");
  }
  db.prepare(`
    INSERT OR IGNORE INTO projects
      (channel_id, project_path, guild_id, auto_approve, parent_channel_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(threadId, originalProjectPath ?? parent.project_path, parent.guild_id, parent.auto_approve, parentChannelId);
  if (!existing) {
    db.prepare(`INSERT OR IGNORE INTO channel_model_preferences (channel_id, model, reasoning_effort)
      SELECT ?, model, reasoning_effort FROM channel_model_preferences WHERE channel_id = ?`)
      .run(threadId, parentChannelId);
  }
}

export function getChannelModelPreferences(channelId: string): ModelPreferences | undefined {
  return db.prepare("SELECT model, reasoning_effort AS reasoningEffort FROM channel_model_preferences WHERE channel_id = ?")
    .get(channelId) as ModelPreferences | undefined;
}

export function setChannelModelPreferences(channelId: string, preferences: ModelPreferences): void {
  db.prepare(`INSERT INTO channel_model_preferences (channel_id, model, reasoning_effort) VALUES (?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET model=excluded.model, reasoning_effort=excluded.reasoning_effort`)
    .run(channelId, preferences.model, preferences.reasoningEffort);
}

export function findSessionThread(parentChannelId: string, sessionId: string): string | undefined {
  const row = db.prepare(`
    SELECT p.channel_id FROM projects p JOIN sessions s ON s.channel_id = p.channel_id
    WHERE p.parent_channel_id = ? AND s.session_id = ? AND p.conversation_state = 'active'
    ORDER BY p.rowid DESC LIMIT 1
  `).get(parentChannelId, sessionId) as { channel_id: string } | undefined;
  return row?.channel_id;
}

export function hasSyncedHistoryMessage(channelId: string, sessionId: string, itemKey: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM conversation_history_messages WHERE channel_id=? AND session_id=? AND item_key=?")
    .get(channelId, sessionId, itemKey));
}

export function recordSyncedHistoryMessage(channelId: string, sessionId: string, itemKey: string, messageId: string): void {
  db.prepare("INSERT OR IGNORE INTO conversation_history_messages (channel_id, session_id, item_key, discord_message_id) VALUES (?, ?, ?, ?)")
    .run(channelId, sessionId, itemKey, messageId);
}

export interface ConversationHistoryState {
  channel_id: string;
  session_id: string;
  next_cursor: string | null;
  exhausted: number;
  page_number: number;
  pending_page: string | null;
}

export function getConversationHistoryState(channelId: string, sessionId: string): ConversationHistoryState | undefined {
  return db.prepare("SELECT * FROM conversation_history_pages WHERE channel_id=? AND session_id=?").get(channelId, sessionId) as ConversationHistoryState | undefined;
}

export function prepareConversationHistoryPage(channelId: string, sessionId: string, page: string): void {
  db.prepare(`INSERT INTO conversation_history_pages (channel_id, session_id, pending_page) VALUES (?, ?, ?)
    ON CONFLICT(channel_id, session_id) DO UPDATE SET pending_page=excluded.pending_page`).run(channelId, sessionId, page);
}

export function completeConversationHistoryPage(channelId: string, sessionId: string, nextCursor: string | null): void {
  db.prepare(`UPDATE conversation_history_pages SET next_cursor=?, exhausted=?, page_number=page_number+1, pending_page=NULL
    WHERE channel_id=? AND session_id=?`).run(nextCursor, nextCursor === null ? 1 : 0, channelId, sessionId);
}

export function unregisterProject(channelId: string): void {
  db.prepare("DELETE FROM sessions WHERE channel_id = ?").run(channelId);
  db.prepare("DELETE FROM projects WHERE channel_id = ?").run(channelId);
}

export function getProject(channelId: string): Project | undefined {
  return db
    .prepare("SELECT * FROM projects WHERE channel_id = ?")
    .get(channelId) as Project | undefined;
}

export function setChatMode(channelId: string, mode: Project["chat_mode"]): void {
  db.prepare("UPDATE projects SET chat_mode = ? WHERE channel_id = ? AND parent_channel_id IS NULL").run(mode, channelId);
}

export function setConversationState(channelId: string, state: Project["conversation_state"]): void {
  db.prepare("UPDATE projects SET conversation_state = ? WHERE channel_id = ?").run(state, channelId);
}

export function selectSession(channelId: string, sessionId: string | null): void {
  if (getProject(channelId)?.fixed_session && getSession(channelId)?.session_id !== sessionId) {
    throw new Error("此频道固定绑定一个 Codex 会话，请用 /sessions 打开另一个频道。");
  }
  const id = getSession(channelId)?.id ?? channelId;
  db.transaction(() => {
    db.prepare("DELETE FROM sessions WHERE channel_id = ?").run(channelId);
    upsertSession(id, channelId, sessionId, "idle");
  })();
}

export function getAllProjects(guildId: string): Project[] {
  return db
    .prepare("SELECT * FROM projects WHERE guild_id = ?")
    .all(guildId) as Project[];
}

export function setAutoApprove(
  channelId: string,
  autoApprove: boolean,
): void {
  db.prepare("UPDATE projects SET auto_approve = ? WHERE channel_id = ?").run(
    autoApprove ? 1 : 0,
    channelId,
  );
}

// Session queries
export function upsertSession(
  id: string,
  channelId: string,
  sessionId: string | null,
  status: SessionStatus,
): void {
  const current = getSession(channelId)?.session_id;
  if (getProject(channelId)?.fixed_session && current && current !== sessionId) {
    throw new Error("不能更改固定频道的会话绑定。");
  }
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sessions (id, channel_id, session_id, status, last_activity)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  stmt.run(id, channelId, sessionId, status);
}

export function getSession(channelId: string): Session | undefined {
  return db
    .prepare(
      "SELECT * FROM sessions WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(channelId) as Session | undefined;
}

export function updateSessionStatus(
  channelId: string,
  status: SessionStatus,
): void {
  db.prepare(
    "UPDATE sessions SET status = ?, last_activity = datetime('now') WHERE channel_id = ?",
  ).run(status, channelId);
}

export function getAllSessions(guildId: string): (Session & { project_path: string })[] {
  return db
    .prepare(`
      SELECT s.*, p.project_path FROM sessions s
      JOIN projects p ON s.channel_id = p.channel_id
      WHERE p.guild_id = ?
    `)
    .all(guildId) as (Session & { project_path: string })[];
}
