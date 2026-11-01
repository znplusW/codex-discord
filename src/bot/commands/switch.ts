import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, type ChatInputCommandInteraction, type ButtonInteraction } from "discord.js";
import { getProject, setChatMode } from "../../db/database.js";
import type { Project } from "../../db/types.js";
import { sessionManager } from "../../codex/session-manager.js";
import { withConversationLock } from "../conversation-lock.js";

export const data = new SlashCommandBuilder().setName("switch")
  .setDescription("切换子区会话模式或原版频道会话模式")
  .addStringOption((option) => option.setName("mode").setDescription("选择会话模式")
    .addChoices({ name: "子区会话模式：每条主频道消息新建会话", value: "threads" },
      { name: "频道会话模式：用 /sessions 切换当前会话", value: "channel" }));

async function showModeLocked(interaction: ChatInputCommandInteraction | ButtonInteraction, mode?: Project["chat_mode"]): Promise<void> {
  const current = getProject(interaction.channelId);
  if (current?.fixed_session) {
    await interaction.editReply({ content: "此频道固定对应一个 Codex 会话。直接聊天即可；切换会话请进入其他频道或使用 /sessions。", components: [] });
    return;
  }
  const root = current?.parent_channel_id ? getProject(current.parent_channel_id) : current;
  if (!root) {
    await interaction.editReply({ content: "请在已注册的频道或它的会话子区使用 `/switch`。", components: [] });
    return;
  }
  if (mode && mode !== root.chat_mode) {
    if (sessionManager.isActive(root.channel_id) || sessionManager.hasQueue(root.channel_id) || sessionManager.getQueueSize(root.channel_id) > 0) {
      await interaction.editReply({ content: "主频道当前任务仍在运行，请等它完成或使用 `/stop` 后再切换模式。", components: [] });
      return;
    }
    setChatMode(root.channel_id, mode);
  }
  const selected = mode ?? root.chat_mode;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("chat-mode:threads").setLabel("子区会话模式")
      .setStyle(selected === "threads" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(selected === "threads"),
    new ButtonBuilder().setCustomId("chat-mode:channel").setLabel("频道会话模式")
      .setStyle(selected === "channel" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(selected === "channel"),
  );
  await interaction.editReply({
    content: `频道：<#${root.channel_id}>\n当前模式：**${selected === "threads" ? "子区会话模式" : "频道会话模式"}**\n\n`
      + "**子区会话模式**：主频道每条新任务创建一个会话，在对应子区持续聊天。\n"
      + "**频道会话模式**：用 `/sessions` 选择当前会话，直接在主频道持续聊天。归档或删除后，下一条消息自动新建会话。\n\n"
      + "模式已保存；已有会话和子区会保留。",
    embeds: [], components: [row],
  });
}

export async function showMode(interaction: ChatInputCommandInteraction | ButtonInteraction, mode?: Project["chat_mode"]): Promise<void> {
  const project = getProject(interaction.channelId);
  await withConversationLock(project?.parent_channel_id ?? interaction.channelId, () => showModeLocked(interaction, mode));
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await showMode(interaction, interaction.options.getString("mode") as Project["chat_mode"] | undefined);
}
