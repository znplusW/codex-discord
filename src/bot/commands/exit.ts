import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getProject } from "../../db/database.js";
import { sessionManager } from "../../codex/session-manager.js";
import { withConversationLock } from "../conversation-lock.js";

export const data = new SlashCommandBuilder().setName("exit").setDescription("退出手机端当前会话，释放运行连接供电脑继续使用");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await withConversationLock(interaction.channelId, async () => {
    const project = getProject(interaction.channelId);
    if (!project || (!project.parent_channel_id && project.chat_mode === "threads")) {
      await interaction.editReply({ content: "请进入要退出的会话子区使用 `/exit`；频道会话模式可在主频道使用。" });
      return;
    }
    try {
      const result = await sessionManager.exitSession(interaction.channelId);
      await interaction.editReply({ content: result
        ? `已退出手机端当前会话，所属运行连接已关闭，可以回电脑继续。${result.cancelled ? `已取消 ${result.cancelled} 条排队任务。` : ""}\n会话和${project.fixed_session ? "频道" : "子区"}保留；以后在这里发消息，会重新连接同一会话。`
        : "当前没有已连接的会话，无需退出。", allowedMentions: { parse: [] } });
    } catch (error) {
      await interaction.editReply({ content: `退出尚未完成：${error instanceof Error ? error.message : "请稍后重试。"}`, allowedMentions: { parse: [] } });
    }
  });
}
