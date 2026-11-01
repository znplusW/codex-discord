import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { startBatch } from "./batch-lifecycle.js";
export const data = new SlashCommandBuilder().setName("multi-delete").setDescription("多选会话，确认后删除电脑端会话及对应频道");
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> { await startBatch(interaction, "delete"); }
