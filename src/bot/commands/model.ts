import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from "discord.js";
import { autocompleteModelOptions, executeModelOptions, warmModelOptions } from "./model-options.js";

function commandData() {
  return new SlashCommandBuilder().setName("model")
    .setDescription("选择模型和思考强度；不填参数直接发送可打开菜单")
    .addStringOption(option => {
      option.setName("model").setDescription("第 1 步：点选使用的模型（可留空后发送）").setRequired(false);
      return option.setAutocomplete(true);
    })
    .addStringOption(option => option.setName("reasoning")
      .setDescription("第 2 步：点选该模型支持的思考强度").setRequired(false).setAutocomplete(true));
}

export const data = commandData();

// Suggestions include this conversation's current settings, so they are dynamic.
export async function registrationData() {
  try {
    await warmModelOptions();
  } catch {
    console.warn("Model catalog unavailable during registration; using model autocomplete.");
  }
  return data.toJSON();
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await executeModelOptions(interaction, "model");
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await autocompleteModelOptions(interaction, "model");
}
