import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import { codexAppServer, type CodexModel } from "../../codex/app-server-client.js";
import { applyModelSelection, getModelSelectionContext, type ModelSelectionContext } from "../../codex/model-settings.js";
import { isAllowedUser } from "../../security/guard.js";
import { reasoningLabel, showModelPicker } from "./model-picker.js";

type Mode = "model" | "reasoning";
type Choice = { name: string; value: string };
const DEFAULT_EFFORT = "model-default";
const CURRENT_SETTINGS = "__current_settings__";
const CATALOG_TTL = 60_000;
// Command registration is not an interaction: allow a cold local Codex start
// to finish so users get native fixed choices instead of an avoidable fallback.
const STARTUP_CATALOG_TIMEOUT = 20_000;
// Leave time for Discord's HTTP acknowledgement inside its three-second limit.
const AUTOCOMPLETE_TIMEOUT = 1_800;
let catalog: CodexModel[] | undefined;
let catalogUpdatedAt = 0;
let catalogRequest: Promise<CodexModel[]> | undefined;
const contextRequests = new Map<string, Promise<ModelSelectionContext>>();

function trim(value: string, limit = 100): string {
  let result = "";
  for (const character of value) {
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result;
}

function refreshCatalog(): Promise<CodexModel[]> {
  if (!catalogRequest) {
    catalogRequest = codexAppServer.listModels().then(models => {
      catalog = models;
      catalogUpdatedAt = Date.now();
      return models;
    }).finally(() => { catalogRequest = undefined; });
  }
  return catalogRequest;
}

function getCatalog(): Promise<CodexModel[]> {
  if (!catalog) return refreshCatalog();
  if (Date.now() - catalogUpdatedAt >= CATALOG_TTL) void refreshCatalog().catch(() => {});
  return Promise.resolve(catalog);
}

// Coalesce concurrent keystrokes, but never cache a completed session lookup:
// /sessions and /model may have changed the active target since the last request.
function getCurrentContext(channelId: string): Promise<ModelSelectionContext> {
  let request = contextRequests.get(channelId);
  if (!request) {
    request = getCatalog().then(models => getModelSelectionContext(channelId, models))
      .finally(() => { contextRequests.delete(channelId); });
    contextRequests.set(channelId, request);
  }
  return request;
}

function modelChoices(models: CodexModel[]): Choice[] {
  return models.map(model => ({
    name: trim(model.displayName && model.displayName !== model.model ? `${model.displayName}（${model.model}）` : model.model),
    value: model.model,
  }));
}

function effortChoices(model: CodexModel): Choice[] {
  if (!model.supportedReasoningEfforts.length) return [{ name: "无需设置（模型默认）", value: DEFAULT_EFFORT }];
  return model.supportedReasoningEfforts.map(effort => ({
    name: trim(`${reasoningLabel(effort.reasoningEffort)}${effort.reasoningEffort === model.defaultReasoningEffort ? " · 模型默认" : ""}`),
    value: effort.reasoningEffort,
  }));
}

function filterChoices(choices: Choice[], query: string): Choice[] {
  const normalized = query.trim().toLocaleLowerCase();
  return choices.filter(choice => !normalized || `${choice.name} ${choice.value}`.toLocaleLowerCase().includes(normalized)).slice(0, 25);
}

export async function warmModelOptions(): Promise<void> {
  await catalogBeforeDeadline();
}

async function catalogBeforeDeadline(): Promise<CodexModel[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    getCatalog(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("读取模型目录超时")), STARTUP_CATALOG_TIMEOUT);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Fixed choices are immediately available in the native command composer. */
export async function getModelOptionChoices(): Promise<Choice[]> {
  const models = await catalogBeforeDeadline();
  return models.length <= 25 ? modelChoices(models) : [];
}

async function suggestions(interaction: AutocompleteInteraction, mode: Mode): Promise<Choice[]> {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value ?? "");
  if (!interaction.channelId) return [];
  const context = await getCurrentContext(interaction.channelId);
  const current: Choice = { name: trim(`当前：${context.current.model} · ${reasoningLabel(context.current.reasoningEffort)}（仅查看）`), value: CURRENT_SETTINGS };
  const withCurrent = (choices: Choice[]) => [current, ...filterChoices(choices, query).slice(0, 24)];
  if (mode === "model" && focused.name === "model") return withCurrent(modelChoices(context.models));
  if (focused.name !== "reasoning") return [];

  let model: CodexModel | undefined;
  if (mode === "model") {
    const selected = interaction.options.getString("model");
    if (!selected || selected === CURRENT_SETTINGS) return [current];
    model = context.models.find(item => item.model === selected);
  } else {
    model = context.models.find(item => item.model === context.current.model);
  }
  return model ? withCurrent(effortChoices(model)) : [current];
}

export async function autocompleteModelOptions(interaction: AutocompleteInteraction, mode: Mode): Promise<void> {
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.respond([]);
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const choices = await Promise.race([
    suggestions(interaction, mode).catch(() => [] as Choice[]),
    new Promise<Choice[]>(resolve => { timer = setTimeout(() => resolve([]), AUTOCOMPLETE_TIMEOUT); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  // Only this caller responds. A late API result can warm the cache, but cannot
  // produce a second acknowledgement after the timeout wins.
  await interaction.respond(choices);
}

export async function executeModelOptions(interaction: ChatInputCommandInteraction, mode: Mode): Promise<void> {
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.editReply({ content: "你没有操作此机器人的权限。", components: [] });
    return;
  }
  const modelValue = mode === "model" ? interaction.options.getString("model") : null;
  const effortValue = interaction.options.getString("reasoning");
  const selectedModel = modelValue === CURRENT_SETTINGS ? null : modelValue;
  const selectedEffort = effortValue === CURRENT_SETTINGS ? null : effortValue;
  if (modelValue === CURRENT_SETTINGS || effortValue === CURRENT_SETTINGS) {
    await showModelPicker(interaction, mode, selectedModel ?? undefined);
    return;
  }
  // Both native pre-send options and the post-send picker remain supported.
  if (!selectedModel && !selectedEffort) {
    await showModelPicker(interaction, mode);
    return;
  }
  if (mode === "model" && selectedModel && !selectedEffort) {
    await showModelPicker(interaction, mode, selectedModel);
    return;
  }
  if ((mode === "model" && !selectedModel) || !selectedEffort) {
    await interaction.editReply({
      content: "请先在命令输入框中选好模型和思考强度，再发送 `/model`。设置尚未修改。",
      components: [], embeds: [], allowedMentions: { parse: [] },
    });
    return;
  }

  let content: string;
  try {
    const context = await getModelSelectionContext(interaction.channelId);
    const preferences = {
      model: mode === "model" ? selectedModel! : context.current.model,
      reasoningEffort: selectedEffort === DEFAULT_EFFORT ? null : selectedEffort,
    };
    await applyModelSelection(interaction.channelId, context.scopeKey, preferences, mode === "reasoning" ? context.current.model : undefined);
    content = `已保存：${context.label}\n模型：${preferences.model}\n思考强度：${reasoningLabel(preferences.reasoningEffort)}\n${context.sessionId ? "从此会话的下一条消息开始使用。" : "此后新建会话将使用该设置。"}`;
  } catch (error) {
    content = `无法保存设置：${trim(error instanceof Error ? error.message : "请稍后重试。", 1_800)}`;
  }
  // Keep Discord delivery outside the save catch: a lost acknowledgement must
  // not claim the already-persisted model change failed.
  await interaction.editReply({ content, components: [], embeds: [], allowedMentions: { parse: [] } });
}
