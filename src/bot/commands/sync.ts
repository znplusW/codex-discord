import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isAllowedUser } from "../../security/guard.js";
import { syncConversationHistory } from "../conversation-history.js";
import { getProject } from "../../db/database.js";
import { ChannelType, type TextChannel } from "discord.js";

export const data = new SlashCommandBuilder().setName("sync").setDescription("同步 Codex 会话内容")
  .addSubcommand(command => command.setName("history").setDescription("再加载更早的 20 轮会话消息"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.editReply({ content: "你没有操作此机器人的权限。" });
    return;
  }
  const channel = interaction.channel;
  if (!channel || (!channel.isThread() && !(channel.type === ChannelType.GuildText && getProject(channel.id)?.fixed_session))) {
    await interaction.editReply({ content: "请进入要同步的会话频道或子区，再使用 `/sync history`。" });
    return;
  }
  try {
    const result = await syncConversationHistory(channel as TextChannel | import("discord.js").ThreadChannel);
    await interaction.editReply({ content: result.warning ?? (result.rounds
      ? `已加载 ${result.rounds} 轮历史（${result.synced} 段消息）。${result.exhausted ? "已经到达会话最早的记录。" : "再次执行 `/sync history` 可继续加载更早的 20 轮。"}`
      : "已经到达会话最早的记录，没有更早的历史可同步。"), allowedMentions: { parse: [] } });
  } catch (error) {
    await interaction.editReply({ content: `无法同步历史：${error instanceof Error ? error.message : "请稍后重试。"}`, allowedMentions: { parse: [] } });
  }
}
