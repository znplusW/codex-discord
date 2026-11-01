import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  type ButtonInteraction, type ChatInputCommandInteraction, type ThreadChannel,
} from "discord.js";
import { getAllSessions, getProject, getSession, selectSession, setConversationState } from "../../db/database.js";
import type { Project } from "../../db/types.js";
import { sessionManager } from "../../codex/session-manager.js";
import { changeThreadLifecycle } from "../../codex/thread-lifecycle.js";
import { isAllowedUser } from "../../security/guard.js";
import { withConversationLock } from "../conversation-lock.js";
import { performManagedLifecycle } from "./managed-lifecycle.js";

type LifecycleInteraction = ChatInputCommandInteraction | ButtonInteraction;
type Action = "archive" | "delete" | "restore";
type Binding = { channelId: string; project: Project };

function currentTarget(interaction: LifecycleInteraction): { sessionId: string; project: Project } {
  const project = getProject(interaction.channelId);
  if (!interaction.guildId || !project || project.guild_id !== interaction.guildId) {
    throw new Error("请在已注册的频道或对应的会话子区使用此命令。");
  }
  if (project.parent_channel_id) {
    if (!interaction.channel?.isThread() || interaction.channel.parentId !== project.parent_channel_id) {
      throw new Error("当前子区与已保存的会话绑定不一致，未执行操作。");
    }
  } else if (project.chat_mode !== "channel") {
    throw new Error("当前是子区会话模式。请进入要操作的会话子区，再使用此命令。");
  }
  const sessionId = getSession(interaction.channelId)?.session_id;
  if (!sessionId) throw new Error("这里还没有当前会话。直接发送一条消息即可开始新会话。");
  return { sessionId, project };
}

function sessionBindings(guildId: string, sessionId: string): Binding[] {
  const channels = new Set(getAllSessions(guildId).filter((session) => session.session_id === sessionId).map((session) => session.channel_id));
  return [...channels].sort().flatMap((channelId) => {
    const project = getProject(channelId);
    return project && getSession(channelId)?.session_id === sessionId ? [{ channelId, project }] : [];
  });
}

async function withBindingLocks<T>(bindings: Binding[], action: () => Promise<T>, index = 0): Promise<T> {
  if (index === bindings.length) return action();
  return withConversationLock(bindings[index].channelId, () => withBindingLocks(bindings, action, index + 1));
}

function assertIdle(bindings: Binding[], sessionId: string): void {
  if (sessionManager.isThreadActive(sessionId) || bindings.some(({ channelId }) =>
    sessionManager.isActive(channelId) || sessionManager.hasQueue(channelId) || sessionManager.getQueueSize(channelId) > 0)) {
    throw new Error("该会话仍有运行中或排队的任务。请先等待完成，或使用 `/stop` 并清空队列后再操作。");
  }
}

async function fetchBoundThread(interaction: LifecycleInteraction, binding: Binding): Promise<ThreadChannel | null> {
  if (!binding.project.parent_channel_id) return null;
  let channel;
  try {
    channel = binding.channelId === interaction.channelId
      ? interaction.channel : await interaction.client.channels.fetch(binding.channelId);
  } catch (error) {
    if ((error as { code?: number }).code === 10003) return null;
    throw error;
  }
  if (!channel) return null;
  if (!channel.isThread() || channel.parentId !== binding.project.parent_channel_id || channel.guildId !== interaction.guildId) {
    throw new Error("关联子区的服务器或父频道与绑定不一致，未执行操作。");
  }
  return channel;
}

/** Core mutation is verified before bindings are changed. Discord failure leaves a tombstone. */
export async function performConversationLifecycle(
  interaction: LifecycleInteraction, action: Action, expectedSessionId?: string,
): Promise<void> {
  if (getProject(interaction.channelId)?.fixed_session) {
    await performManagedLifecycle(interaction, action, expectedSessionId);
    return;
  }
  if (!isAllowedUser(interaction.user.id)) throw new Error("你没有操作此机器人的权限。");
  const initial = currentTarget(interaction);
  const sessionId = expectedSessionId ?? initial.sessionId;
  if (sessionId !== initial.sessionId) throw new Error("当前会话已改变，这个确认按钮已失效。请重新输入 `/delete`。");
  const bindings = sessionBindings(interaction.guildId!, sessionId);
  await withBindingLocks(bindings, async () => {
    const current = currentTarget(interaction);
    if (current.sessionId !== sessionId) throw new Error("当前会话已改变，未执行操作。请重新输入命令。");
    const latestBindings = sessionBindings(interaction.guildId!, sessionId);
    if (latestBindings.some((binding) => !bindings.some((locked) => locked.channelId === binding.channelId))) {
      throw new Error("会话绑定刚刚发生变化，请重试此命令。");
    }
    assertIdle(latestBindings, sessionId);
    if (action === "restore" && (!current.project.parent_channel_id || current.project.conversation_state === "deleted")) {
      throw new Error("只有仍保留的会话子区可以恢复。频道模式下，请在桌面端恢复归档会话后用 `/sessions` 选择它。");
    }

    const threads = (await Promise.all(latestBindings.map((binding) => fetchBoundThread(interaction, binding))))
      .filter((thread): thread is ThreadChannel => thread !== null);
    const notifyInParent = action !== "restore" && Boolean(current.project.parent_channel_id);
    const notificationParent = notifyInParent && current.project.parent_channel_id
      ? interaction.channel?.isThread() && interaction.channel.parent
        ? interaction.channel.parent
        : await interaction.client.channels.fetch(current.project.parent_channel_id)
      : null;
    if (notifyInParent && !notificationParent?.isSendable()) {
      throw new Error("无法访问父频道以返回操作结果，请检查频道权限后重试。");
    }
    await changeThreadLifecycle(sessionId, action);

    for (const { channelId, project } of latestBindings) {
      if (project.parent_channel_id) {
        setConversationState(channelId, action === "restore" ? "active" : action === "archive" ? "archived" : "deleted");
      } else if (action !== "restore") {
        selectSession(channelId, null);
      }
    }

    if (notifyInParent) {
      await interaction.editReply({
        content: "Codex 会话及桌面列表状态已核验，正在同步 Discord 子区；结果将在主频道显示。",
        embeds: [], components: [],
      }).catch((error: unknown) => {
        console.warn("[conversation] Could not update progress response:", error instanceof Error ? error.message : error);
      });
    }

    const failures: string[] = [];
    for (const thread of threads) {
      try {
        if (action === "delete") await thread.delete("用户通过 /delete 删除对应 Codex 会话");
        else await thread.setArchived(action === "archive", "用户通过 /archive 管理对应 Codex 会话");
      } catch (error) {
        if (action === "delete" && (error as { code?: number }).code === 10003) continue;
        failures.push(`<#${thread.id}>`);
        console.error(`[conversation] Codex ${action} verified, Discord thread ${thread.id} update failed:`, error instanceof Error ? error.message : error);
      }
    }
    const verb = action === "archive" ? "归档" : action === "delete" ? "删除" : "恢复";
    const followup = current.project.parent_channel_id
      ? action === "restore" ? "可以在此子区继续对话。" : action === "archive" ? "对应子区已归档，历史记录保留。需要恢复时可使用 `/archive restore:True`。" : "对应的会话子区已移除。"
      : "当前会话绑定已清空。下一条普通消息会自动创建新会话。";
    const result = failures.length
      ? `Codex 会话及桌面列表已${verb}；Discord 子区同步未全部完成：${failures.join("、")}。${action === "restore" ? "请打开这些子区后继续对话。" : "这些子区已停止接受新任务，请检查机器人的子区管理权限。"}`
      : `✅ 会话已${verb}，桌面列表已核验。${followup}`;

    // Archived/deleted threads cannot reliably hold an interaction response.
    // Announce the verified result in the parent, scoped to this explicit command.
    if (notifyInParent && notificationParent?.isSendable()) {
      const label = action === "archive" ? `<#${interaction.channelId}>`
        : `「${interaction.channel?.isThread() ? interaction.channel.name : "Codex 会话"}」`;
      await notificationParent.send({ content: `${label}\n${result}`, allowedMentions: { parse: [] } });
    } else {
      await interaction.editReply({ content: result, embeds: [], components: [] });
    }
  });
}

export async function requestConversationDelete(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!isAllowedUser(interaction.user.id)) throw new Error("你没有操作此机器人的权限。");
    const { sessionId } = currentTarget(interaction);
    assertIdle(sessionBindings(interaction.guildId!, sessionId), sessionId);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`conversation-delete-confirm:${sessionId}:${interaction.user.id}`)
        .setLabel("永久删除会话").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`conversation-delete-cancel:${sessionId}:${interaction.user.id}`)
        .setLabel("取消").setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({
      content: getProject(interaction.channelId)?.fixed_session
        ? "确认永久删除电脑端当前会话及其子代理会话，并删除本 Discord 频道和全部频道消息？此操作无法撤销。"
        : "确认永久删除当前 Codex 会话及其子代理会话？桌面列表和对应 Discord 子区也会同步移除。此操作无法撤销。",
      components: [row],
    });
  } catch (error) {
    await reportLifecycleError(interaction, error);
  }
}

export async function handleConversationDeleteButton(interaction: ButtonInteraction): Promise<boolean> {
  const match = /^(conversation-delete-confirm|conversation-delete-cancel):([^:]+):([^:]+)$/.exec(interaction.customId);
  if (!match) return false;
  if (!isAllowedUser(interaction.user.id) || match[3] !== interaction.user.id) {
    await interaction.reply({ content: "只有发起此删除请求的授权用户可以操作这个按钮。", ephemeral: true });
    return true;
  }
  await interaction.deferUpdate();
  if (match[1] === "conversation-delete-cancel") {
    await interaction.editReply({ content: "已取消删除。", embeds: [], components: [] });
    return true;
  }
  try {
    await performConversationLifecycle(interaction, "delete", match[2]);
  } catch (error) {
    await reportLifecycleError(interaction, error);
  }
  return true;
}

export async function reportLifecycleError(interaction: LifecycleInteraction, error: unknown): Promise<void> {
  console.error("[conversation] Lifecycle operation did not complete:", error instanceof Error ? error.message : error);
  const content = `未完成操作：${error instanceof Error ? error.message : "无法核验会话状态，请稍后重试。"}`;
  try {
    await interaction.editReply({ content, embeds: [], components: [] });
  } catch (replyError) {
    const project = getProject(interaction.channelId);
    if (!project?.parent_channel_id) throw replyError;
    const parent = interaction.channel?.isThread() && interaction.channel.parent
      ? interaction.channel.parent : await interaction.client.channels.fetch(project.parent_channel_id);
    if (!parent?.isSendable()) throw replyError;
    await parent.send({ content: `<#${interaction.channelId}>\n${content}`, allowedMentions: { parse: [] } });
  }
}
