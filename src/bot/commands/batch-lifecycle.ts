import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, StringSelectMenuBuilder, type ChatInputCommandInteraction, type ButtonInteraction, type StringSelectMenuInteraction } from "discord.js";
import { getManagedChannel, listManagedConversations, type ManagedConversation } from "../../db/channel-conversations.js";
import { isAllowedUser } from "../../security/guard.js";
import { executeManagedLifecycle } from "./managed-lifecycle.js";

type BatchInteraction = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
type BatchAction = "archive" | "delete";
const verb = (draft: Draft) => draft.action === "archive" ? "归档" : "删除";
interface Draft {
  action: BatchAction;
  owner: string; guildId: string; sourceChannelId: string; expires: number;
  rows: ManagedConversation[]; selected: Set<string>; page: number; confirming: boolean;
}
const drafts = new Map<string, Draft>();
function short(text: string, limit = 90): string { return Array.from(text.replace(/\s+/g, " ")).slice(0, limit).join("").slice(0, limit); }
function button(token: string, action: string, label: string, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(`batch:${token}:${action}`).setLabel(label).setStyle(style);
}
async function render(interaction: BatchInteraction, token: string, draft: Draft): Promise<void> {
  if (draft.confirming) {
    const names = draft.rows.filter(r => draft.selected.has(r.session_id)).map(r => `• ${short(r.title, 60)}`);
    await interaction.editReply({ content: draft.action === "delete" ? `确认永久删除 **${names.length} 个电脑端会话及对应 Discord 频道**？频道消息也会删除，无法撤销。\n\n${names.join("\n").slice(0, 1200)}` : `确认归档 **${names.length} 个电脑端会话**？逐项核验后，对应频道将移到 CodeX-已归档，历史保留。\n\n${names.join("\n").slice(0, 1200)}`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(token, "confirm", `确认${verb(draft)} ${names.length} 个会话`, ButtonStyle.Danger), button(token, "back", "返回选择"), button(token, "cancel", "取消"))],
      allowedMentions: { parse: [] } });
    return;
  }
  const pages = Math.ceil(draft.rows.length / 25);
  const pageRows = draft.rows.slice(draft.page * 25, (draft.page + 1) * 25);
  const menu = new StringSelectMenuBuilder().setCustomId(`batch:${token}:select`).setPlaceholder(`选择本页要${verb(draft)}的会话，可跨页多选`)
    .setMinValues(0).setMaxValues(pageRows.length).addOptions(pageRows.map(r => ({ label: short(r.title) || "Codex 会话", value: r.session_id,
      description: `${r.state === "active" ? "进行中" : r.state === "archived" ? "已归档" : "电脑已删除，仅清理频道"} · ${r.session_id.slice(0, 8)}`,
      default: draft.selected.has(r.session_id) })));
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(token, "previous", "上一页").setDisabled(draft.page === 0), button(token, "next", "下一页").setDisabled(draft.page === pages - 1),
    button(token, "all", "全部选中"), button(token, "review", `预览${verb(draft)}（${draft.selected.size}）`, ButtonStyle.Primary).setDisabled(!draft.selected.size), button(token, "cancel", "取消"));
  await interaction.editReply({ content: `**批量${verb(draft)}会话 · 第 ${draft.page + 1}/${pages} 页**\n共 ${draft.rows.length} 个已关联频道，已选 ${draft.selected.size} 个。选择后还需确认才会执行。`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), controls], allowedMentions: { parse: [] } });
}
export async function startBatch(interaction: ChatInputCommandInteraction, action: BatchAction): Promise<void> {
  if (!isAllowedUser(interaction.user.id) || !interaction.guildId) {
    await interaction.editReply({ content: "你没有操作权限。" }); return;
  }
  for (const [id, draft] of drafts) if (draft.expires < Date.now()) drafts.delete(id);
  const guild = await interaction.client.guilds.fetch(interaction.guildId);
  const channels = await guild.channels.fetch();
  const rows = listManagedConversations(interaction.guildId).flatMap(r => {
    const channel = r.channel_id ? channels.get(r.channel_id) : undefined;
    return channel?.type === ChannelType.GuildText && (action === "delete" || r.state === "active")
      ? [{ ...r, title: channel.name }] : [];
  });
  if (!rows.length) { await interaction.editReply({ content: "没有可执行此批量操作的会话频道。" }); return; }
  const token = randomUUID();
  const draft: Draft = { action, owner: interaction.user.id, guildId: interaction.guildId, sourceChannelId: interaction.channelId,
    expires: Date.now() + 15 * 60_000, rows, selected: new Set(), page: 0, confirming: false };
  drafts.set(token, draft);
  await render(interaction, token, draft);
}
export async function handleBatchInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<boolean> {
  const match = /^batch:([^:]+):(select|previous|next|all|review|back|confirm|cancel)$/.exec(interaction.customId);
  if (!match) return false;
  const [, token, action] = match;
  const draft = drafts.get(token);
  if (!draft || draft.expires < Date.now() || draft.owner !== interaction.user.id || draft.guildId !== interaction.guildId
    || draft.sourceChannelId !== interaction.channelId || !isAllowedUser(interaction.user.id)) {
    await interaction.reply({ content: "此批量操作已过期或不属于你，请重新输入 /multi-delete 或 /multi-archive。", flags: ["Ephemeral"] });
    return true;
  }
  await interaction.deferUpdate();
  if (action === "cancel") {
    drafts.delete(token); await interaction.editReply({ content: `已取消批量${verb(draft)}。`, components: [] }); return true;
  }
  if (action === "confirm") {
    if (!draft.confirming || !draft.selected.size) return true;
    drafts.delete(token);
    const selected = draft.rows.filter(r => draft.selected.has(r.session_id));
    await interaction.editReply({ content: `正在处理 ${selected.length} 个会话…`, components: [] });
    let done = 0;
    const failures: string[] = [];
    for (const row of selected) {
      try {
        if (!row.channel_id || getManagedChannel(row.channel_id)?.session_id !== row.session_id) throw new Error("频道绑定已改变，请重新选择");
        await executeManagedLifecycle(interaction.client, row.channel_id, draft.action, row.session_id);
        done++;
      } catch (error) { failures.push(`${short(row.title, 40)}：${short(error instanceof Error ? error.message : String(error), 160)}`); }
    }
    await interaction.editReply({ content: `批量${verb(draft)}结果：完成 ${done}/${selected.length} 个。${failures.length ? `\n未完成的项目：\n${failures.join("\n").slice(0, 1500)}` : draft.action === "delete" ? "电脑端删除均已核验，对应频道已移除。" : "电脑端归档均已核验，对应频道已移至 CodeX-已归档。"}`,
      components: [], allowedMentions: { parse: [] } }).catch(() => {});
    return true;
  }
  if (action === "back") draft.confirming = false;
  else if (!draft.confirming) {
    if (action === "select" && "values" in interaction) {
      const pageRows = draft.rows.slice(draft.page * 25, (draft.page + 1) * 25);
      for (const row of pageRows) draft.selected.delete(row.session_id);
      for (const id of interaction.values) if (pageRows.some(r => r.session_id === id)) draft.selected.add(id);
    } else if (action === "all") for (const row of draft.rows) draft.selected.add(row.session_id);
    else if (action === "previous") draft.page = Math.max(0, draft.page - 1);
    else if (action === "next") draft.page = Math.min(Math.ceil(draft.rows.length / 25) - 1, draft.page + 1);
    else if (action === "review" && draft.selected.size) draft.confirming = true;
  }
  await render(interaction, token, draft);
  return true;
}
