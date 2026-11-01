import { randomUUID } from "node:crypto";
import { getDb, getProject, getSession, registerProject, setConversationState, upsertSession } from "./database.js";

export type ManagedState = "active" | "archived" | "deleted";
export interface ConversationHub {
  guild_id: string; project_path: string; template_channel_id: string | null;
  assistant_session_id: string | null; initialized: number;
}
export interface ManagedConversation {
  guild_id: string; session_id: string; channel_id: string | null;
  title: string; project_path: string; state: ManagedState;
  sync_pending: number; last_error: string | null; missing_checks: number;
  pending_action: "archive" | "restore" | "delete" | null; delete_channel_requested: number;
  needs_history: number;
  origin: "new" | "import";
}
export function getHub(guildId: string): ConversationHub | undefined {
  return getDb().prepare("SELECT * FROM conversation_hubs WHERE guild_id=?").get(guildId) as ConversationHub | undefined;
}
export function createHub(guildId: string, projectPath: string, templateChannelId: string | null): ConversationHub {
  getDb().prepare("INSERT OR IGNORE INTO conversation_hubs (guild_id,project_path,template_channel_id) VALUES (?,?,?)")
    .run(guildId, projectPath, templateChannelId);
  return getHub(guildId)!;
}
export function setHubAssistant(guildId: string, sessionId: string): void {
  getDb().prepare("UPDATE conversation_hubs SET assistant_session_id=? WHERE guild_id=?").run(sessionId, guildId);
}
export function finishHubInitialization(guildId: string): void {
  getDb().prepare("UPDATE conversation_hubs SET initialized=1 WHERE guild_id=?").run(guildId);
}
export function getManagedConversation(guildId: string, sessionId: string): ManagedConversation | undefined {
  return getDb().prepare("SELECT * FROM managed_conversations WHERE guild_id=? AND session_id=?")
    .get(guildId, sessionId) as ManagedConversation | undefined;
}
export function getManagedChannel(channelId: string): ManagedConversation | undefined {
  return getDb().prepare("SELECT * FROM managed_conversations WHERE channel_id=?").get(channelId) as ManagedConversation | undefined;
}
export function listManagedConversations(guildId: string): ManagedConversation[] {
  return getDb().prepare("SELECT * FROM managed_conversations WHERE guild_id=? ORDER BY rowid").all(guildId) as ManagedConversation[];
}
export function saveManagedConversation(guildId: string, sessionId: string, title: string, projectPath: string, origin: ManagedConversation["origin"] = "import"): ManagedConversation {
  getDb().prepare("INSERT OR IGNORE INTO managed_conversations (guild_id,session_id,title,project_path,origin) VALUES (?,?,?,?,?)")
    .run(guildId, sessionId, title, projectPath, origin);
  return getManagedConversation(guildId, sessionId)!;
}
export function setManagedHistoryInitialized(guildId: string, sessionId: string): void {
  getDb().prepare("UPDATE managed_conversations SET needs_history=0 WHERE guild_id=? AND session_id=?").run(guildId, sessionId);
}
export function getCreationRequest(interactionId: string, guildId: string): string | undefined {
  return (getDb().prepare("SELECT session_id FROM conversation_create_requests WHERE interaction_id=? AND guild_id=?")
    .get(interactionId, guildId) as { session_id: string } | undefined)?.session_id;
}
export function saveCreationRequest(interactionId: string, guildId: string, sessionId: string): void {
  getDb().prepare("INSERT INTO conversation_create_requests (interaction_id,guild_id,session_id) VALUES (?,?,?)")
    .run(interactionId, guildId, sessionId);
}
export function bindManagedChannel(guildId: string, sessionId: string, channelId: string): void {
  const row = getManagedConversation(guildId, sessionId);
  if (!row) throw new Error("未找到会话创建记录。");
  getDb().transaction(() => {
    const current = getSession(channelId)?.session_id;
    if (current && current !== sessionId) throw new Error("这个频道已经绑定另一个会话。");
    if (row.channel_id && row.channel_id !== channelId) throw new Error("这个会话已有对应频道。");
    registerProject(channelId, row.project_path, guildId);
    getDb().prepare("UPDATE projects SET fixed_session=1,chat_mode='channel' WHERE channel_id=?").run(channelId);
    upsertSession(getSession(channelId)?.id ?? randomUUID(), channelId, sessionId, "idle");
    setConversationState(channelId, row.state);
    getDb().prepare("UPDATE managed_conversations SET channel_id=?,sync_pending=1 WHERE guild_id=? AND session_id=?")
      .run(channelId, guildId, sessionId);
  })();
}
/** Manual Discord deletion only detaches the presentation; it never deletes Codex. */
export function detachManagedChannel(channelId: string): void {
  getDb().prepare("UPDATE managed_conversations SET channel_id=NULL,sync_pending=0,needs_history=1 WHERE channel_id=?").run(channelId);
}
export function setManagedState(guildId: string, sessionId: string, state: ManagedState): void {
  const row = getManagedConversation(guildId, sessionId);
  getDb().prepare("UPDATE managed_conversations SET state=?,sync_pending=1,last_error=NULL,missing_checks=0 WHERE guild_id=? AND session_id=?")
    .run(state, guildId, sessionId);
  if (row?.channel_id && getProject(row.channel_id)) setConversationState(row.channel_id, state);
}
export function setManagedSyncResult(guildId: string, sessionId: string, error: string | null): void {
  getDb().prepare("UPDATE managed_conversations SET sync_pending=?,last_error=? WHERE guild_id=? AND session_id=?")
    .run(error ? 1 : 0, error, guildId, sessionId);
}
export function setManagedAction(guildId: string, sessionId: string, action: ManagedConversation["pending_action"], deleteChannel = false): void {
  getDb().prepare("UPDATE managed_conversations SET pending_action=?,delete_channel_requested=CASE WHEN ? IS NULL THEN delete_channel_requested ELSE ? END,sync_pending=1 WHERE guild_id=? AND session_id=?")
    .run(action, action, deleteChannel ? 1 : 0, guildId, sessionId);
}
export function recordMissingCheck(guildId: string, sessionId: string, missing: boolean): number {
  getDb().prepare("UPDATE managed_conversations SET missing_checks=CASE WHEN ? THEN missing_checks+1 ELSE 0 END WHERE guild_id=? AND session_id=?")
    .run(missing ? 1 : 0, guildId, sessionId);
  return getManagedConversation(guildId, sessionId)!.missing_checks;
}
export interface ConversationCategory { guild_id: string; kind: ManagedState; position: number; channel_id: string }
export function listConversationCategories(guildId: string, kind: ManagedState): ConversationCategory[] {
  return getDb().prepare("SELECT * FROM conversation_categories WHERE guild_id=? AND kind=? ORDER BY position")
    .all(guildId, kind) as ConversationCategory[];
}
export function saveConversationCategory(guildId: string, kind: ManagedState, position: number, channelId: string): void {
  getDb().prepare("INSERT OR REPLACE INTO conversation_categories (guild_id,kind,position,channel_id) VALUES (?,?,?,?)")
    .run(guildId, kind, position, channelId);
}
