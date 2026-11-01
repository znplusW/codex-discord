import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { getAllProjects, getSession } from "../../db/database.js";
import { getHub, getManagedChannel } from "../../db/channel-conversations.js";
import { L } from "../../utils/i18n.js";

const STATUS_EMOJI: Record<string, string> = {
  online: "🟢",
  waiting: "🟡",
  idle: "⚪",
  offline: "🔴",
};

export const data = new SlashCommandBuilder()
  .setName("status")
  .setDescription("查看当前会话及 CodeX 频道状态");

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = interaction.guildId!;
  const projects = getAllProjects(guildId).filter(p => !getHub(guildId) || p.fixed_session);

  if (projects.length === 0) {
    await interaction.editReply({
      content: "暂无会话频道，请用 /sessions 新建或打开会话。",
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(L("Codex Sessions", "Codex 세션"))
    .setColor(0x10b981)
    .setTimestamp();

  // Always include this channel first; reserve room for the footer and stop
  // before Discord's 6,000-character budget across the whole embed.
  const ordered = [
    ...projects.filter(p => p.channel_id === interaction.channelId),
    ...projects.filter(p => p.channel_id !== interaction.channelId).slice(-25),
  ];
  let shown = 0;
  for (const project of ordered) {
    const session = getSession(project.channel_id);
    const status = session?.status ?? "offline";
    const emoji = STATUS_EMOJI[status] ?? "🔴";
    const lastActivity = session?.last_activity ?? "never";
    const managed = getManagedChannel(project.channel_id);

    const field = {
      name: `${emoji} <#${project.channel_id}>`,
      value: [
        `\`${project.project_path.slice(0, 300)}\``,
        `${L("Status", "상태")}: **${status}**`,
        `会话状态：${project.conversation_state}${managed?.last_error ? " · 尚未完成同步" : ""}`,
        ...(managed?.pending_action ? [`待执行：${{ delete: "删除", archive: "归档", restore: "恢复" }[managed.pending_action]}`] : []),
        ...(managed?.last_error ? [`原因：${managed.last_error.slice(0, 250)}`] : []),
        `${L("Auto-approve", "자동 승인")}: ${project.auto_approve ? L("On", "켜짐") : L("Off", "꺼짐")}`,
        `${L("Last activity", "마지막 활동")}: ${lastActivity}`,
      ].join("\n").slice(0, 1024),
      inline: false,
    };
    if (shown >= 25 || embed.length + field.name.length + field.value.length > 5700) break;
    embed.addFields(field);
    shown++;
  }

  if (shown < projects.length) embed.setFooter({ text: `显示 ${shown} 个会话频道，共 ${projects.length} 个；在其他频道使用 /status 可优先查看该会话。` });
  await interaction.editReply({ embeds: [embed] });
}
