import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { performConversationLifecycle, reportLifecycleError } from "./conversation-lifecycle.js";

export const data = new SlashCommandBuilder().setName("archive")
  .setDescription("先归档电脑端会话并核验，再将频道移至 CodeX-已归档")
  .addBooleanOption((option) => option.setName("restore").setDescription("恢复当前会话，等同于 /restore"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await performConversationLifecycle(interaction, interaction.options.getBoolean("restore") ? "restore" : "archive");
  } catch (error) {
    await reportLifecycleError(interaction, error);
  }
}
