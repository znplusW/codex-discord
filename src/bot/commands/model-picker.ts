import { randomBytes } from "node:crypto";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import { isAllowedUser } from "../../security/guard.js";
import type { CodexModel } from "../../codex/app-server-client.js";
import { applyModelSelection, getModelSelectionContext, type ModelSelectionContext } from "../../codex/model-settings.js";

type PickerMode = "model" | "reasoning";
type PickerInteraction = ButtonInteraction | StringSelectMenuInteraction;
type Picker = {
  token: string;
  userId: string;
  channelId: string;
  context: ModelSelectionContext;
  mode: PickerMode;
  selectedModel: CodexModel | null;
  modelPage: number;
  effortPage: number;
  revision: number;
  expiresAt: number;
  processing: boolean;
};
const menus = new Map<string, Picker>();
const PAGE_SIZE = 25;
const MENU_TTL = 15 * 60 * 1000;

const effortNames: Record<string, string> = {
  none: "无额外思考", minimal: "最少", low: "低", medium: "中等", high: "高",
  xhigh: "更高", max: "最高", ultra: "超高",
};

export function reasoningLabel(effort: string | null): string {
  return effort === null ? "模型默认" : effortNames[effort] ? `${effortNames[effort]}（${effort}）` : effort;
}

function trim(value: string, limit = 100): string {
  let result = "";
  for (const character of value) {
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result;
}

function id(menu: Picker, action: string): string {
  return `model-picker:${menu.token}:${menu.revision}:${action}`;
}

function cleanup(): void {
  for (const [token, menu] of menus) if (menu.expiresAt <= Date.now()) menus.delete(token);
  // Each command replaces only this caller's menu for this channel below.
  while (menus.size >= 200) menus.delete(menus.keys().next().value!);
}

function modelName(model: CodexModel): string {
  return model.displayName || model.model;
}

function controls(menu: Picker, page: number, pages: number, showBack: boolean) {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (pages > 1) row.addComponents(
    new ButtonBuilder().setCustomId(id(menu, "previous")).setLabel("上一页").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(id(menu, "next")).setLabel("下一页").setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
  );
  if (showBack) row.addComponents(new ButtonBuilder().setCustomId(id(menu, "back")).setLabel("重新选模型").setStyle(ButtonStyle.Secondary));
  row.addComponents(new ButtonBuilder().setCustomId(id(menu, "cancel")).setLabel("取消").setStyle(ButtonStyle.Secondary));
  return row;
}

function render(menu: Picker) {
  const current = `当前：${menu.context.current.model} · ${reasoningLabel(menu.context.current.reasoningEffort)}`;
  const header = `${menu.context.label}\n${current}\n\n`;
  if (!menu.selectedModel) {
    const pages = Math.ceil(menu.context.models.length / PAGE_SIZE);
    const start = menu.modelPage * PAGE_SIZE;
    const select = new StringSelectMenuBuilder().setCustomId(id(menu, "model"))
      .setPlaceholder("第 1 步：选择使用的模型")
      .addOptions(menu.context.models.slice(start, start + PAGE_SIZE).map((model, index) => ({
        label: trim(modelName(model)), value: String(start + index),
        description: trim(`${model.model}${model.model === menu.context.current.model ? " · 当前模型" : model.isDefault ? " · Codex 默认" : ""}`),
        default: model.model === menu.context.current.model,
      })));
    return {
      content: `${header}请选择模型（第 ${menu.modelPage + 1}/${pages} 页）。下一步选择该模型支持的思考强度，完成后才保存。`,
      embeds: [], allowedMentions: { parse: [] as never[] },
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), controls(menu, menu.modelPage, pages, false)],
    };
  }
  const model = menu.selectedModel;
  const efforts = model.supportedReasoningEfforts;
  if (efforts.length === 0) {
    return {
      content: `${header}已选模型：**${modelName(model)}**\n该模型没有可调的思考强度。点击“使用此模型”确认保存。`,
      embeds: [], allowedMentions: { parse: [] as never[] },
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(id(menu, "confirm")).setLabel("使用此模型").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(id(menu, "back")).setLabel("重新选模型").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id(menu, "cancel")).setLabel("取消").setStyle(ButtonStyle.Secondary),
      )],
    };
  }
  const pages = Math.ceil(efforts.length / PAGE_SIZE);
  const start = menu.effortPage * PAGE_SIZE;
  const suggested = menu.context.current.model === model.model && efforts.some(e => e.reasoningEffort === menu.context.current.reasoningEffort)
    ? menu.context.current.reasoningEffort : model.defaultReasoningEffort;
  const select = new StringSelectMenuBuilder().setCustomId(id(menu, "effort"))
    .setPlaceholder(menu.mode === "model" ? "第 2 步：选择思考强度并保存" : "选择当前模型的思考强度")
    .addOptions(efforts.slice(start, start + PAGE_SIZE).map((effort, index) => ({
      label: trim(reasoningLabel(effort.reasoningEffort)), value: String(start + index),
      description: trim(`${effort.reasoningEffort === model.defaultReasoningEffort ? "模型默认 · " : ""}${effort.description || effort.reasoningEffort}`),
      default: effort.reasoningEffort === suggested,
    })));
  return {
    content: `${header}模型：**${modelName(model)}**\n请选择该模型的思考强度${pages > 1 ? `（第 ${menu.effortPage + 1}/${pages} 页）` : ""}。选择后保存，用于后续消息。`,
    embeds: [], allowedMentions: { parse: [] as never[] },
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), controls(menu, menu.effortPage, pages, menu.mode === "model")],
  };
}

export async function showModelPicker(interaction: ChatInputCommandInteraction, mode: PickerMode, initialModel?: string): Promise<void> {
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.editReply({ content: "你没有操作此机器人的权限。", components: [] });
    return;
  }
  try {
    const context = await getModelSelectionContext(interaction.channelId);
    if (!context.models.length) throw new Error("Codex 当前没有返回可选择的模型，请稍后重试。");
    const selectedModel = mode === "reasoning" || initialModel
      ? context.models.find(model => model.model === (initialModel ?? context.current.model)) ?? null : null;
    if (initialModel && !selectedModel) throw new Error("所选模型已不可用，请重新选择模型。");
    if (mode === "reasoning" && !selectedModel) throw new Error("当前模型不在可选模型目录中，无法确认其思考强度。请先用 `/model` 选择可用模型。");
    if (mode === "reasoning" && selectedModel!.supportedReasoningEfforts.length === 0) {
      await interaction.editReply({ content: `${context.label}\n当前模型：${modelName(selectedModel!)}\n该模型没有可调的思考强度。`, components: [], embeds: [], allowedMentions: { parse: [] } });
      return;
    }
    cleanup();
    for (const [token, existing] of menus) {
      if (existing.userId === interaction.user.id && existing.channelId === interaction.channelId) menus.delete(token);
    }
    const menu: Picker = {
      token: randomBytes(12).toString("hex"), userId: interaction.user.id, channelId: interaction.channelId,
      context, mode, selectedModel, modelPage: 0, effortPage: 0, revision: 0,
      expiresAt: Date.now() + MENU_TTL, processing: false,
    };
    menus.set(menu.token, menu);
    await interaction.editReply(render(menu));
  } catch (error) {
    await interaction.editReply({ content: `无法打开选择菜单：${error instanceof Error ? error.message : "请稍后重试。"}`, components: [], embeds: [], allowedMentions: { parse: [] } });
  }
}

async function getMenu(interaction: PickerInteraction): Promise<{ menu: Picker; action: string } | null> {
  const match = /^model-picker:([a-f0-9]{24}):(\d+):([a-z]+)$/.exec(interaction.customId);
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({ content: "你没有操作此机器人的权限。", ephemeral: true });
    return null;
  }
  const menu = match ? menus.get(match[1]) : undefined;
  if (!menu || menu.expiresAt <= Date.now()) {
    if (menu) menus.delete(menu.token);
    await interaction.reply({ content: "菜单已过期或机器人已重启，请重新输入 `/model` 或 `/reasoning`。", ephemeral: true });
    return null;
  }
  if (menu.userId !== interaction.user.id || menu.channelId !== interaction.channelId) {
    await interaction.reply({ content: "只有在原频道发起菜单的用户可以操作。", ephemeral: true });
    return null;
  }
  if (menu.processing || menu.revision !== Number(match![2])) {
    await interaction.reply({ content: "菜单正在更新，或这个选项已经失效。请使用最新菜单。", ephemeral: true });
    return null;
  }
  menu.processing = true; // Claim synchronously before yielding to another component event.
  return { menu, action: match![3] };
}

async function save(interaction: PickerInteraction, menu: Picker, effort: string | null): Promise<void> {
  const model = menu.selectedModel!;
  try {
    await applyModelSelection(menu.channelId, menu.context.scopeKey, { model: model.model, reasoningEffort: effort },
      menu.mode === "reasoning" ? menu.context.current.model : undefined);
  } catch (error) {
    menus.delete(menu.token);
    await interaction.editReply({ content: `未能保存：${error instanceof Error ? error.message : "请稍后重试。"}\n请重新打开选择菜单。`, embeds: [], components: [], allowedMentions: { parse: [] } });
    return;
  }
  menus.delete(menu.token);
  const effect = menu.context.sessionId ? "用于后续消息，当前会话上下文保留。" : "将作为后续新会话的默认设置。";
  // A Discord edit failure after persistence must not be reported as a failed save.
  await interaction.editReply({
    content: `✅ 已保存：${menu.context.label}\n模型：**${modelName(model)}**\n思考强度：**${reasoningLabel(effort)}**\n${effect}`,
    embeds: [], components: [], allowedMentions: { parse: [] },
  });
}

export async function handleModelPickerSelect(interaction: StringSelectMenuInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("model-picker:")) return false;
  const selected = await getMenu(interaction);
  if (!selected) return true;
  const { menu, action } = selected;
  const value = interaction.values.length === 1 ? interaction.values[0] : "";
  const index = /^\d+$/.test(value) ? Number(value) : -1;
  const validModel = action === "model" && !menu.selectedModel && menu.mode === "model"
    && index >= menu.modelPage * PAGE_SIZE && index < (menu.modelPage + 1) * PAGE_SIZE && index < menu.context.models.length;
  const validEffort = action === "effort" && menu.selectedModel
    && index >= menu.effortPage * PAGE_SIZE && index < (menu.effortPage + 1) * PAGE_SIZE && index < menu.selectedModel.supportedReasoningEfforts.length;
  if (!validModel && !validEffort) {
    menu.processing = false;
    await interaction.reply({ content: "该选项无效，请使用菜单中显示的选项。", ephemeral: true });
    return true;
  }
  menu.processing = true;
  try {
    await interaction.deferUpdate();
    if (validModel) {
      menu.selectedModel = menu.context.models[index];
      menu.effortPage = 0;
      menu.revision++;
      await interaction.editReply(render(menu));
    } else {
      await save(interaction, menu, menu.selectedModel!.supportedReasoningEfforts[index].reasoningEffort);
    }
  } finally { menu.processing = false; }
  return true;
}

export async function handleModelPickerButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("model-picker:")) return false;
  const selected = await getMenu(interaction);
  if (!selected) return true;
  const { menu, action } = selected;
  const page = menu.selectedModel ? menu.effortPage : menu.modelPage;
  const itemCount = menu.selectedModel ? menu.selectedModel.supportedReasoningEfforts.length : menu.context.models.length;
  const pageCount = Math.ceil(itemCount / PAGE_SIZE);
  const valid = action === "cancel" || (action === "back" && menu.mode === "model" && menu.selectedModel !== null)
    || (action === "confirm" && menu.mode === "model" && menu.selectedModel?.supportedReasoningEfforts.length === 0)
    || (action === "previous" && page > 0) || (action === "next" && page < pageCount - 1);
  if (!valid) {
    menu.processing = false;
    await interaction.reply({ content: "该按钮已失效，请使用当前菜单。", ephemeral: true });
    return true;
  }
  menu.processing = true;
  try {
    await interaction.deferUpdate();
    if (action === "cancel") {
      menus.delete(menu.token);
      await interaction.editReply({ content: "已取消，未修改模型或思考强度。", embeds: [], components: [] });
    } else if (action === "confirm") await save(interaction, menu, null);
    else {
      if (action === "back") menu.selectedModel = null;
      else if (menu.selectedModel) menu.effortPage += action === "next" ? 1 : -1;
      else menu.modelPage += action === "next" ? 1 : -1;
      menu.revision++;
      await interaction.editReply(render(menu));
    }
  } finally { menu.processing = false; }
  return true;
}
