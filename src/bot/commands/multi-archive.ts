import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { startBatch } from "./batch-lifecycle.js";
export const data = new SlashCommandBuilder().setName("multi-archive").setDescription("多选会话，先归档电脑端并核验，再移动频道至 CodeX-已归档");
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> { await startBatch(interaction, "archive"); }
