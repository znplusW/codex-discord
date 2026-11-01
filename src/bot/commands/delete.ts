import { SlashCommandBuilder } from "discord.js";
import { requestConversationDelete } from "./conversation-lifecycle.js";

export const data = new SlashCommandBuilder().setName("delete")
  .setDescription("确认后删除电脑端当前会话及对应 Discord 频道");

export const execute = requestConversationDelete;
