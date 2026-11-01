import { codexAppServer, type CodexModel, type ModelPreferences } from "./app-server-client.js";
import { getChannelModelPreferences, getProject, getSession, setChannelModelPreferences } from "../db/database.js";
import { withConversationLock } from "../bot/conversation-lock.js";
import { sessionManager } from "./session-manager.js";

export interface ModelSelectionContext {
  scopeKey: string;
  channelId: string;
  sessionId: string | null;
  label: string;
  current: ModelPreferences;
  models: CodexModel[];
}

function target(channelId: string) {
  const project = getProject(channelId);
  if (!project) throw new Error("请在已注册的频道或对应会话子区使用此命令。");
  if ((project.parent_channel_id || project.fixed_session) && project.conversation_state !== "active") {
    throw new Error("这个子区会话已归档或删除，请先恢复会话。");
  }
  const sessionId = project.parent_channel_id || project.chat_mode === "channel"
    ? getSession(channelId)?.session_id ?? null : null;
  return {
    project, sessionId, scopeKey: sessionId ? `thread:${sessionId}` : `channel:${channelId}`,
    label: sessionId ? "当前 Codex 会话" : project.parent_channel_id ? "此子区的新会话" : "本频道以后新建会话的默认设置",
  };
}

export async function getModelSelectionContext(channelId: string, knownModels?: CodexModel[]): Promise<ModelSelectionContext> {
  const scope = target(channelId);
  // Autocomplete can reuse its warmed catalog; save-time callers omit it so
  // validation still checks the current model capabilities before any write.
  const models = knownModels ?? await codexAppServer.listModels();
  let current: ModelPreferences;
  if (scope.sessionId) {
    const thread = await codexAppServer.readThread(scope.sessionId);
    if (!thread.model) throw new Error("暂时无法读取当前会话的模型，请稍后重试。");
    const model = models.find(item => item.model === thread.model);
    current = { model: thread.model, reasoningEffort: thread.reasoningEffort ?? model?.defaultReasoningEffort ?? null };
  } else {
    current = getChannelModelPreferences(channelId) ?? await codexAppServer.readModelDefaults(scope.project.project_path, models);
  }
  if (target(channelId).scopeKey !== scope.scopeKey) throw new Error("当前会话已改变，请重新打开模型菜单。");
  return { channelId, scopeKey: scope.scopeKey, sessionId: scope.sessionId, label: scope.label, current, models };
}

export async function applyModelSelection(
  channelId: string, expectedScopeKey: string, preferences: ModelPreferences, expectedCurrentModel?: string,
): Promise<void> {
  await withConversationLock(channelId, () => withConversationLock(`model:${expectedScopeKey}`, async () => {
    const scope = target(channelId);
    if (scope.scopeKey !== expectedScopeKey) throw new Error("当前会话已切换，这个菜单已失效。请重新输入命令。");
    if (sessionManager.isActive(channelId) || (scope.sessionId && sessionManager.isThreadActive(scope.sessionId))) {
      throw new Error("当前会话正在执行任务，请等本轮完成后再调整模型或思考强度。");
    }
    const context = await getModelSelectionContext(channelId);
    if (context.scopeKey !== expectedScopeKey) throw new Error("当前会话已改变，请重新打开菜单。");
    if (expectedCurrentModel && context.current.model !== expectedCurrentModel) {
      throw new Error("当前模型已经改变，请重新输入 `/reasoning` 选择它支持的思考强度。");
    }
    const model = context.models.find(item => item.model === preferences.model);
    if (!model) throw new Error("该模型已不在当前可选目录中，请重新打开 `/model`。");
    const efforts = model.supportedReasoningEfforts.map(item => item.reasoningEffort);
    if (efforts.length ? !efforts.includes(preferences.reasoningEffort ?? "") : preferences.reasoningEffort !== null) {
      throw new Error("该模型不支持所选思考强度，请重新选择。");
    }
    // A different Discord binding can start this Codex thread while its
    // metadata is being fetched, outside the current channel's lock.
    if (sessionManager.isActive(channelId) || (scope.sessionId && sessionManager.isThreadActive(scope.sessionId))) {
      throw new Error("当前会话正在执行任务，请等本轮完成后再调整模型或思考强度。");
    }
    if (scope.sessionId) {
      if (scope.project.fixed_session) {
        const { assertManagedConversationActive } = await import("../bot/managed-sync.js");
        await assertManagedConversationActive(channelId);
      }
      await codexAppServer.setThreadModelSettings(scope.sessionId, preferences);
    } else {
      setChannelModelPreferences(channelId, preferences);
    }
  }));
}
