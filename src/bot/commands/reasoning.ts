import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from "discord.js";
import { autocompleteModelOptions, executeModelOptions } from "./model-options.js";

export const data = new SlashCommandBuilder().setName("reasoning")
  .setDescription("调整当前模型的思考强度；不填参数直接发送可打开菜单")
  .addStringOption(option => option.setName("reasoning")
    .setDescription("点选当前模型支持的思考强度").setRequired(false).setAutocomplete(true));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await executeModelOptions(interaction, "reasoning");
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await autocompleteModelOptions(interaction, "reasoning");
}
