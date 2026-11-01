import { ChannelType, PermissionFlagsBits, type Client, type Guild, type TextChannel, type CategoryChannel } from "discord.js";
import { codexAppServer } from "../codex/app-server-client.js";
import { getStoredThread } from "../codex/storage.js";
import { getAllProjects, getSession, getChannelModelPreferences, setChannelModelPreferences, getConversationHistoryState } from "../db/database.js";
import { bindManagedChannel, createHub, detachManagedChannel, finishHubInitialization, getCreationRequest, getHub, getManagedConversation, listConversationCategories, saveConversationCategory, saveCreationRequest, saveManagedConversation, setHubAssistant, setManagedHistoryInitialized, setManagedSyncResult, type ManagedConversation, type ManagedState } from "../db/channel-conversations.js";
import { getConfig } from "../utils/config.js";
import { withConversationLock } from "./conversation-lock.js";
import { syncConversationHistory } from "./conversation-history.js";

const categoryNames: Record<ManagedState, string> = { active: "CodeX", archived: "CodeX-已归档", deleted: "CodeX-已删除" };
export function channelName(title: string): string {
  return Array.from(title.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "-").replace(/[\u0000-\u001f\u007f/#@:`]/g, ""))
    .slice(0, 90).join("") || "codex-会话";
}
function privatePermissions(guild: Guild) {
  const visible = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory
    | PermissionFlagsBits.AttachFiles | PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.UseApplicationCommands;
  return [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...getConfig().ALLOWED_USER_IDS.map(id => ({ id, type: 1 as const, allow: [visible] })),
    { id: guild.client.user!.id, type: 1 as const, allow: [visible, PermissionFlagsBits.ManageChannels] },
  ];
}
async function fetchChannel(guild: Guild, id: string) {
  try { return await guild.channels.fetch(id); }
  catch (error) { if ((error as { code?: number }).code === 10003) return null; throw error; }
}
/** Category IDs are persisted. Same-name unrelated categories are never adopted. */
export async function categoryFor(guild: Guild, state: ManagedState, currentParentId?: string | null): Promise<CategoryChannel> {
  return withConversationLock(`category:${guild.id}:${state}`, () => categoryForLocked(guild, state, currentParentId));
}
async function categoryForLocked(guild: Guild, state: ManagedState, currentParentId?: string | null): Promise<CategoryChannel> {
  const stored = listConversationCategories(guild.id, state);
  for (const row of stored) {
    const category = await fetchChannel(guild, row.channel_id);
    if (category?.type !== ChannelType.GuildCategory) continue;
    if (category.id === currentParentId || category.children.cache.size < 50) return category;
  }
  const position = (stored.at(-1)?.position ?? 0) + 1;
  const category = await guild.channels.create({ name: `${categoryNames[state]}${position > 1 ? `-${position}` : ""}`,
    type: ChannelType.GuildCategory, permissionOverwrites: privatePermissions(guild), reason: "Codex 会话列表" });
  saveConversationCategory(guild.id, state, position, category.id);
  return category;
}

async function ensureChannel(guild: Guild, row: ManagedConversation): Promise<{ channel: TextChannel; reused: boolean }> {
  if (row.channel_id) {
    const channel = await fetchChannel(guild, row.channel_id);
    if (channel?.type === ChannelType.GuildText) {
      return { channel, reused: true };
    }
    if (channel) throw new Error("保存的会话频道类型已改变。");
    detachManagedChannel(row.channel_id);
  }
  const category = await categoryFor(guild, row.state);
  // A failed process may have created the channel before it saved the binding.
  const marker = `codex-discord:${row.session_id}`;
  const channels = await guild.channels.fetch();
  let channel = channels.find(c => c?.type === ChannelType.GuildText && c.topic?.startsWith(marker)) as TextChannel | undefined;
  if (!channel) {
    const base = channelName(row.title);
    const duplicate = channels.some(c => c?.type === ChannelType.GuildText && c.name === base);
    channel = await guild.channels.create({ name: duplicate ? `${base.slice(0, 81)}-${row.session_id.slice(0, 8)}` : base,
      type: ChannelType.GuildText, parent: category.id, permissionOverwrites: privatePermissions(guild),
      topic: `${marker}\n${row.title.slice(0, 200)}\n工作目录：${row.project_path.slice(0, 650)}`, reason: "一个频道对应一个 Codex 会话" });
  }
  bindManagedChannel(guild.id, row.session_id, channel.id);
  setManagedSyncResult(guild.id, row.session_id, null);
  return { channel, reused: false };
}

/** Callers hold the guild lock, so create/import retries cannot make two channels. */
async function createNamedLocked(guild: Guild, title: string, assistant = false, requestId?: string): Promise<TextChannel> {
  const hub = getHub(guild.id);
  if (!hub) throw new Error("CodeX 尚未初始化，请稍后重试。");
  const existing = requestId ? getCreationRequest(requestId, guild.id) : undefined;
  const thread = existing ? { id: existing } : await codexAppServer.startThread(hub.project_path, hub.template_channel_id ? getChannelModelPreferences(hub.template_channel_id) : undefined);
  const row = saveManagedConversation(guild.id, thread.id, title, hub.project_path, "new");
  if (requestId && !existing) saveCreationRequest(requestId, guild.id, thread.id);
  if (assistant) setHubAssistant(guild.id, thread.id); // Durable before naming/Discord requests.
  try {
    await codexAppServer.setThreadName(thread.id, title);
    await codexAppServer.initializeNamedThread(thread.id, title);
  }
  catch (error) { setManagedSyncResult(guild.id, thread.id, `会话已创建，命名待重试：${String(error)}`); throw error; }
  finally { await codexAppServer.releaseThread(thread.id); }
  const { notifyDesktopLifecycle } = await import("../codex/thread-lifecycle.js");
  await notifyDesktopLifecycle([thread.id], "restore");
  const { channel } = await ensureChannel(guild, getManagedConversation(guild.id, row.session_id)!);
  if (getManagedConversation(guild.id, thread.id)?.needs_history) {
    const state = getConversationHistoryState(channel.id, thread.id);
    if (!state?.page_number || state.pending_page) {
      const result = await syncConversationHistory(channel);
      if (!result.warning) setManagedHistoryInitialized(guild.id, thread.id);
    } else setManagedHistoryInitialized(guild.id, thread.id);
  }
  const prefs = hub.template_channel_id ? getChannelModelPreferences(hub.template_channel_id) : undefined;
  if (prefs) setChannelModelPreferences(channel.id, prefs);
  return channel;
}

export async function createNamedConversation(guild: Guild, rawTitle: string, requestId?: string): Promise<TextChannel> {
  const title = rawTitle.trim();
  if (!title || Array.from(title).length > 100) throw new Error("会话名请填写 1–100 个字符。");
  return withConversationLock(`hub:${guild.id}`, () => createNamedLocked(guild, title, false, requestId));
}

export async function openConversationChannel(guild: Guild, sessionId: string): Promise<{ channel: TextChannel; reused: boolean; warning?: string }> {
  return withConversationLock(`hub:${guild.id}`, async () => {
    const stored = getStoredThread(sessionId);
    if (!stored?.cwd || stored.archived) throw new Error("该会话已归档或不存在，请重新打开 /sessions。");
    const row = getManagedConversation(guild.id, sessionId) ?? saveManagedConversation(guild.id, sessionId, stored.title || "Codex 会话", stored.cwd);
    const result = await ensureChannel(guild, row);
    const historyState = getConversationHistoryState(result.channel.id, sessionId);
    if (row.needs_history && (!historyState?.page_number || historyState.pending_page)) {
      const history = await syncConversationHistory(result.channel);
      if (!history.warning) setManagedHistoryInitialized(guild.id, sessionId);
      return { ...result, warning: history.warning };
    }
    if (row.needs_history) setManagedHistoryInitialized(guild.id, sessionId);
    return result;
  });
}

/** Only unfinished create/import jobs are retried; manual removals set pending=0. */
export async function recoverPendingConversation(client: Client, row: ManagedConversation): Promise<void> {
  if (row.channel_id || !row.sync_pending || row.state !== "active") return;
  const guild = await client.guilds.fetch(row.guild_id);
  if (row.origin === "new") {
    await withConversationLock(`hub:${row.guild_id}`, async () => {
      const latest = getManagedConversation(row.guild_id, row.session_id);
      if (!latest || latest.channel_id || !latest.sync_pending) return;
      await codexAppServer.setThreadName(row.session_id, row.title);
      try { await codexAppServer.initializeNamedThread(row.session_id, row.title); }
      finally { await codexAppServer.releaseThread(row.session_id); }
      const { channel } = await ensureChannel(guild, latest);
      const result = await syncConversationHistory(channel);
      if (!result.warning) setManagedHistoryInitialized(row.guild_id, row.session_id);
    });
  } else await openConversationChannel(guild, row.session_id);
}

export async function initializeConversationHub(client: Client, guildId: string): Promise<void> {
  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();
  await withConversationLock(`hub:${guildId}`, async () => {
    const roots = getAllProjects(guildId).filter(p => !p.parent_channel_id && !p.fixed_session);
    const template = roots[0];
    let hub = getHub(guildId) ?? createHub(guildId, template?.project_path ?? getConfig().BASE_PROJECT_DIR, template?.channel_id ?? null);
    await categoryFor(guild, "active");
    if (!hub.initialized) {
      if (hub.assistant_session_id) {
        const row = getManagedConversation(guildId, hub.assistant_session_id);
        if (!row) throw new Error("助理初始化记录缺失，请核验后重试。");
        await codexAppServer.setThreadName(row.session_id, "助理");
        try { await codexAppServer.initializeNamedThread(row.session_id, "助理"); }
        finally { await codexAppServer.releaseThread(row.session_id); }
        const { channel } = await ensureChannel(guild, row);
        const history = getConversationHistoryState(channel.id, row.session_id);
        if (!history?.page_number || history.pending_page) await syncConversationHistory(channel);
      } else await createNamedLocked(guild, "助理", true);
      finishHubInitialization(guildId);
    }
  });
}

/** Keep old transcripts, but route subsequent use to the new, unique channel. */
export async function migrateLegacyConversations(client: Client, guildId: string): Promise<void> {
  const guild = await client.guilds.fetch(guildId);
  for (const project of getAllProjects(guildId).filter(p => !p.fixed_session)) {
    const sessionId = getSession(project.channel_id)?.session_id;
    if (!sessionId || project.conversation_state !== "active") continue;
    const stored = getStoredThread(sessionId);
    if (!stored || stored.archived) continue;
    const { sessionManager } = await import("../codex/session-manager.js");
    if (sessionManager.isThreadActive(sessionId)) continue;
    try {
      if (!getManagedConversation(guildId, sessionId)?.channel_id) {
        await sessionManager.exitSession(project.channel_id);
        await openConversationChannel(guild, sessionId);
      }
      const old = await fetchChannel(guild, project.channel_id);
      if (old?.isThread()) {
        if (!old.locked) await old.setLocked(true, "已迁移至 CodeX 会话频道");
        if (!old.archived) await old.setArchived(true, "已迁移至 CodeX 会话频道");
      }
    } catch (error) { console.warn(`[channels] Legacy migration pending ${project.channel_id}: ${String(error)}`); }
  }
}
