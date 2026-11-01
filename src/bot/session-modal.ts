import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, type StringSelectMenuInteraction, type ModalSubmitInteraction } from "discord.js";
import { createNamedConversation } from "./conversation-channels.js";
import { getHub } from "../db/channel-conversations.js";
import { isAllowedUser } from "../security/guard.js";

export async function showNewSessionModal(interaction: StringSelectMenuInteraction): Promise<void> {
  const modal = new ModalBuilder().setCustomId(`conversation-create:${interaction.user.id}`).setTitle("新建 Codex 会话");
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
    .setCustomId("name").setLabel("会话名称").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(100)
    .setPlaceholder("例如：网站开发、旅行计划")));
  await interaction.showModal(modal);
}
export async function handleSessionModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.customId.startsWith("conversation-create:")) return;
  if (!isAllowedUser(interaction.user.id) || interaction.customId !== `conversation-create:${interaction.user.id}` || !interaction.guildId || !getHub(interaction.guildId)) {
    await interaction.reply({ content: "此创建入口无效或你没有权限。", flags: ["Ephemeral"] });
    return;
  }
  await interaction.deferReply({ flags: ["Ephemeral"] });
  try {
    const guild = await interaction.client.guilds.fetch(interaction.guildId);
    const channel = await createNamedConversation(guild, interaction.fields.getTextInputValue("name"), interaction.id);
    await interaction.editReply({ content: `会话及频道已创建：<#${channel.id}>。进入频道直接聊天即可。`, allowedMentions: { parse: [] } });
  } catch (error) {
    await interaction.editReply({ content: `创建尚未完成：${error instanceof Error ? error.message : String(error)}`, allowedMentions: { parse: [] } });
  }
}
