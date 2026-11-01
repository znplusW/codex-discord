import { ChannelType, type Client } from "discord.js";
import { codexAppServer } from "../codex/app-server-client.js";
import { inspectConversationState } from "../codex/conversation-state.js";
import { sessionManager } from "../codex/session-manager.js";
import { changeThreadLifecycle } from "../codex/thread-lifecycle.js";
import { describeLifecycleFailure } from "../codex/lifecycle-errors.js";
import { getProject, unregisterProject } from "../db/database.js";
import { detachManagedChannel, getManagedChannel, getManagedConversation, listManagedConversations, recordMissingCheck, setManagedAction, setManagedState, setManagedSyncResult, type ManagedConversation, type ManagedState } from "../db/channel-conversations.js";
import { categoryFor, recoverPendingConversation } from "./conversation-channels.js";
import { withConversationLock } from "./conversation-lock.js";

async function checkedState(row: ManagedConversation): Promise<ManagedState> {
  if (row.state === "deleted" && !row.pending_action) return "deleted";
  let state: Awaited<ReturnType<typeof inspectConversationState>>;
  try { state = await inspectConversationState(row.session_id); }
  catch (error) { recordMissingCheck(row.guild_id, row.session_id, false); throw error; }
  if (state !== "missing") {
    recordMissingCheck(row.guild_id, row.session_id, false);
    return state;
  }
  if (recordMissingCheck(row.guild_id, row.session_id, true) < 2) {
    throw new Error("电脑端暂未找到此会话，正在再次核验；当前不提交新任务。");
  }
  return "deleted";
}

/** Called while the sending channel is reserved, including automatic queue dispatch. */
export async function assertManagedConversationActive(channelId: string): Promise<void> {
  const row = getManagedChannel(channelId);
  if (!row) return;
  try {
    const state = await checkedState(row);
    if (state !== row.state) setManagedState(row.guild_id, row.session_id, state);
    if (state !== "active") throw new Error(state === "archived"
      ? "电脑端会话已归档。请使用 /restore 恢复后继续。"
      : "电脑端会话已删除。历史会保留，请用 /sessions 新建其他会话。");
    if (row.pending_action || (row.sync_pending && row.last_error)) throw new Error("此会话正在同步状态，请稍后重试。");
  } catch (error) {
    setManagedSyncResult(row.guild_id, row.session_id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** The caller holds the channel lock; desired state is durable before Discord I/O. */
export async function applyManagedPresentation(client: Client, row: ManagedConversation): Promise<void> {
  if (!row.channel_id) return;
  const channel = await client.channels.fetch(row.channel_id).catch((error: unknown) => {
    if ((error as { code?: number }).code === 10003) return null;
    throw error;
  });
  if (!channel) {
    await sessionManager.exitSession(row.channel_id);
    detachManagedChannel(row.channel_id);
    if (getProject(row.channel_id)) unregisterProject(row.channel_id);
    return;
  }
  if (channel.type !== ChannelType.GuildText || channel.guildId !== row.guild_id) throw new Error("会话频道类型或服务器不一致。");
  if (row.state !== "active") await sessionManager.exitSession(row.channel_id);
  if (row.state === "deleted" && row.delete_channel_requested) {
    await channel.delete("用户确认删除 Codex 会话及频道");
    detachManagedChannel(row.channel_id);
    unregisterProject(row.channel_id);
    return;
  }
  const category = await categoryFor(channel.guild, row.state, channel.parentId);
  // Every managed channel already has the private owner/bot overwrites. Keep
  // them while moving; rewriting overwrites would require ManageRoles as well.
  if (channel.parentId !== category.id) await channel.setParent(category.id, { lockPermissions: false, reason: "同步电脑端 Codex 会话状态" });
  const baseTopic = (channel.topic ?? `codex-discord:${row.session_id}`).split("\n状态：")[0];
  const stateText = row.state === "active" ? "可继续对话" : row.state === "archived" ? "已归档；使用 /restore 恢复" : "电脑端会话已删除；仅保留历史，可用 /delete 清理频道";
  const topic = `${baseTopic}\n状态：${stateText}`.slice(0, 1024);
  if (channel.topic !== topic) await channel.setTopic(topic, "同步 Codex 会话状态");
  setManagedSyncResult(row.guild_id, row.session_id, null);
}

export async function reconcileManagedConversation(client: Client, snapshot: ManagedConversation): Promise<void> {
  if (!snapshot.channel_id) {
    try { await recoverPendingConversation(client, snapshot); }
    catch (error) { setManagedSyncResult(snapshot.guild_id, snapshot.session_id, String(error)); }
    return;
  }
  await withConversationLock(snapshot.channel_id ?? `managed:${snapshot.guild_id}:${snapshot.session_id}`, async () => {
    let row = getManagedConversation(snapshot.guild_id, snapshot.session_id);
    if (!row?.channel_id) return;
    try {
      if (row.pending_action) {
        // A persisted request must obey the same busy guard as a fresh command.
        if (sessionManager.isThreadActive(row.session_id) || sessionManager.hasQueue(row.channel_id) || sessionManager.getQueueSize(row.channel_id)) {
          throw new Error("会话仍有运行或排队任务，等待完成后再续办已确认的操作。");
        }
        await changeThreadLifecycle(row.session_id, row.pending_action);
        setManagedState(row.guild_id, row.session_id, row.pending_action === "restore" ? "active" : row.pending_action === "archive" ? "archived" : "deleted");
        setManagedAction(row.guild_id, row.session_id, null);
      } else {
        const state = await checkedState(row);
        if (state !== row.state) setManagedState(row.guild_id, row.session_id, state);
      }
      row = getManagedConversation(row.guild_id, row.session_id)!;
      await applyManagedPresentation(client, row);
    } catch (error) {
      const message = describeLifecycleFailure(error);
      if (row.last_error !== message) console.warn(`[channels] State sync pending ${row.session_id}: ${message}`);
      setManagedSyncResult(row.guild_id, row.session_id, message);
    }
  });
}

export function startManagedSync(client: Client, guildId: string): () => void {
  let running = false;
  const sync = async () => {
    if (running) return;
    running = true;
    try { for (const row of listManagedConversations(guildId)) await reconcileManagedConversation(client, row); }
    catch (error) { console.warn("[channels] Reconciliation failed:", error instanceof Error ? error.message : String(error)); }
    finally { running = false; }
  };
  const listener = (message: { method: string }) => {
    if (["thread/archived", "thread/unarchived", "thread/deleted"].includes(message.method)) void sync();
  };
  codexAppServer.on("notification", listener);
  const timer = setInterval(() => void sync(), 10_000);
  timer.unref();
  void sync();
  return () => { clearInterval(timer); codexAppServer.off("notification", listener); };
}
