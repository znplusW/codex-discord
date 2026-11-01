import type { Client, ButtonInteraction, ChatInputCommandInteraction } from "discord.js";
import { getManagedChannel, getManagedConversation, setManagedAction, setManagedState, setManagedSyncResult } from "../../db/channel-conversations.js";
import { sessionManager } from "../../codex/session-manager.js";
import { changeThreadLifecycle, type LifecycleAction } from "../../codex/thread-lifecycle.js";
import { applyManagedPresentation } from "../managed-sync.js";
import { withConversationLock } from "../conversation-lock.js";
import { isAllowedUser } from "../../security/guard.js";
import { describeLifecycleFailure, isWriterConflict } from "../../codex/lifecycle-errors.js";

export async function executeManagedLifecycle(client: Client, channelId: string, action: LifecycleAction, expectedSessionId: string, beforeChannelDeletion?: () => Promise<void>): Promise<void> {
  await withConversationLock(channelId, async () => {
    const row = getManagedChannel(channelId);
    if (!row || row.session_id !== expectedSessionId) throw new Error("频道与会话的对应关系已改变，请重新选择。");
    if (action === "restore" && row.state === "deleted") throw new Error("电脑端会话已删除，无法恢复。可用 /delete 清理频道。");
    if (sessionManager.isThreadActive(row.session_id) || sessionManager.hasQueue(channelId) || sessionManager.getQueueSize(channelId)) {
      throw new Error("会话仍有运行或排队任务。请先 /stop 或等待完成，并清空队列。");
    }
    setManagedAction(row.guild_id, row.session_id, action, action === "delete");
    try {
      await changeThreadLifecycle(row.session_id, action);
      setManagedState(row.guild_id, row.session_id, action === "restore" ? "active" : action === "archive" ? "archived" : "deleted");
      setManagedAction(row.guild_id, row.session_id, null);
      if (action === "delete") await beforeChannelDeletion?.();
      await applyManagedPresentation(client, getManagedConversation(row.guild_id, row.session_id)!);
    } catch (error) {
      const message = describeLifecycleFailure(error);
      setManagedSyncResult(row.guild_id, row.session_id, message);
      if (isWriterConflict(error)) throw new Error(message);
      throw new Error(`操作尚未全部完成：${message}。已记录待同步步骤，后台会重试。`);
    }
  });
}

export async function performManagedLifecycle(interaction: ChatInputCommandInteraction | ButtonInteraction, action: LifecycleAction, expectedSessionId?: string): Promise<void> {
  const row = getManagedChannel(interaction.channelId);
  if (!isAllowedUser(interaction.user.id) || !row || row.guild_id !== interaction.guildId) throw new Error("此频道没有可操作的会话。");
  await executeManagedLifecycle(interaction.client, interaction.channelId, action, expectedSessionId ?? row.session_id,
    () => interaction.editReply({ content: "电脑端删除已核验，正在移除对应频道。", embeds: [], components: [] }).then(() => {}));
  if (action !== "delete") await interaction.editReply({ content: action === "restore"
    ? "电脑端原会话已恢复，频道已移回 CodeX。可直接在这里继续聊天。"
    : "电脑端会话已归档并核验，频道已移至 CodeX-已归档。使用 /restore 可恢复。", embeds: [], components: [] });
}
