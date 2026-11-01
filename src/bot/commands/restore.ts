import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { performConversationLifecycle, reportLifecycleError } from "./conversation-lifecycle.js";

export const data = new SlashCommandBuilder().setName("restore").setDescription("恢复电脑端原会话，并将频道移回 CodeX");
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  try { await performConversationLifecycle(interaction, "restore"); }
  catch (error) { await reportLifecycleError(interaction, error); }
}
