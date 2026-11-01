import fs from "node:fs";
import { codexAppServer } from "./app-server-client.js";
import { findStateDbPath, getStoredThread } from "./storage.js";

export type InspectedState = "active" | "archived" | "missing";
/** An unavailable database or RPC is never evidence that a chat was deleted. */
export async function inspectConversationState(threadId: string): Promise<InspectedState> {
  const databasePath = findStateDbPath();
  if (!databasePath || !fs.existsSync(databasePath)) throw new Error("Codex 状态暂不可读，请稍后重试。");
  const row = getStoredThread(threadId);
  if (row) {
    if (!row.rollout_path || !fs.existsSync(row.rollout_path)) throw new Error("会话记录与历史文件尚未一致，正在等待重新核验。");
    if (row.archived !== 0 && row.archived !== 1) throw new Error("无法确认 Codex 会话归档状态。");
    return row.archived === 1 ? "archived" : "active";
  }
  try {
    await codexAppServer.readThread(threadId);
    throw new Error("Codex 数据源状态尚未一致，请稍后重试。");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/^(?:thread not (?:found|loaded):|no rollout found for thread|thread .* (?:not found|does not exist))/i.test(message)) return "missing";
    throw error;
  }
}
