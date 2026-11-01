import { createHash } from "node:crypto";
import type { TextChannel, ThreadChannel } from "discord.js";
import { codexAppServer, type CodexTurn } from "../codex/app-server-client.js";
import { splitMessage } from "../codex/output-formatter.js";
import { findSessionThread, getProject, getSession, hasSyncedHistoryMessage, recordSyncedHistoryMessage, getConversationHistoryState, prepareConversationHistoryPage, completeConversationHistoryPage } from "../db/database.js";
import { getStoredThread } from "../codex/storage.js";
import { openConversationThread } from "./conversation-threads.js";
import { withConversationLock } from "./conversation-lock.js";
import { sessionManager } from "../codex/session-manager.js";

const RECENT_TURNS = 20;

export interface HistoryMessage { key: string; content: string }

/** Only visible conversation text is mirrored; tools and private reasoning are omitted. */
export function renderRecentHistory(turns: CodexTurn[]): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  for (const turn of turns) {
    const status = typeof turn.status === "string" ? turn.status : turn.status?.type;
    if (status === "inProgress" || status === "active") continue;
    for (const [index, item] of (turn.items ?? []).entries()) {
      let text = "";
      let label: string;
      if (item.type === "agentMessage" && typeof item.text === "string") {
        text = item.text;
        label = "Codex 助手";
      } else if (item.type === "userMessage" && Array.isArray(item.content)) {
        text = item.content.map((input: unknown) => {
          if (!input || typeof input !== "object") return "";
          const value = input as { type?: string; text?: unknown };
          if ((value.type === "text" || value.type === "inputText") && typeof value.text === "string") return value.text;
          return value.type === "image" || value.type === "localImage" ? "[图片]" : "";
        }).filter(Boolean).join("\n");
        label = "用户";
      } else continue;
      if (!text.trim()) continue;
      splitMessage(`**${label} · 历史**\n${text.trim()}`).forEach((content, part) => {
        messages.push({ key: `${turn.id}:${item.id || index}:${part}`, content });
      });
    }
  }
  return messages;
}

async function sendHistoryMessage(thread: ThreadChannel | TextChannel, sessionId: string, message: HistoryMessage): Promise<boolean> {
  if (hasSyncedHistoryMessage(thread.id, sessionId, message.key)) return false;
  const nonce = createHash("sha256").update(`${thread.id}:${sessionId}:${message.key}`).digest("hex").slice(0, 24);
  const sent = await thread.send({ content: message.content, allowedMentions: { parse: [] }, nonce, enforceNonce: true });
  recordSyncedHistoryMessage(thread.id, sessionId, message.key, sent.id);
  return true;
}

type HistoryPage = Awaited<ReturnType<typeof codexAppServer.readRecentTurns>>;
interface PendingHistoryPage { number: number; rounds: number; messages: HistoryMessage[]; nextCursor: string | null }
export interface HistorySyncResult { synced: number; rounds: number; exhausted: boolean; warning?: string }

/** Persist the page before sending; a restart or partial send resumes that exact batch. */
export async function syncConversationHistory(thread: ThreadChannel | TextChannel, initialPage?: HistoryPage): Promise<HistorySyncResult> {
  return withConversationLock(thread.id, async () => {
    const project = getProject(thread.id);
    const sessionId = getSession(thread.id)?.session_id;
    if ((!project?.parent_channel_id && !project?.fixed_session) || project?.conversation_state !== "active" || !sessionId) {
      throw new Error("请在一个已绑定、未归档的会话频道或子区使用 `/sync history`。");
    }
    if (sessionManager.isActive(thread.id) || sessionManager.isThreadActive(sessionId)) {
      throw new Error("当前会话正在处理任务，请完成后再同步历史。");
    }
    const state = getConversationHistoryState(thread.id, sessionId);
    if (state?.exhausted && !state.pending_page) return { synced: 0, rounds: 0, exhausted: true };
    let pending: PendingHistoryPage;
    if (state?.pending_page) pending = JSON.parse(state.pending_page) as PendingHistoryPage;
    else {
      const page = initialPage ?? await codexAppServer.readRecentTurns(sessionId, RECENT_TURNS, state?.next_cursor);
      pending = { number: (state?.page_number ?? 0) + 1, rounds: page.turns.length,
        messages: renderRecentHistory(page.turns), nextCursor: page.nextCursor };
      prepareConversationHistoryPage(thread.id, sessionId, JSON.stringify(pending));
    }
    let synced = 0;
    try {
      if (pending.rounds) await sendHistoryMessage(thread, sessionId, { key: `history:batch:${pending.number}`,
        content: pending.number === 1
          ? `**历史同步 · 最近 ${pending.rounds} 轮**\n按时间顺序显示用户消息与助手回复。直接在这里发消息可继续原会话。${pending.nextCursor ? `输入 \`/sync history\` 可再加载更早的 ${RECENT_TURNS} 轮。` : "已经到达本会话最早的记录，没有更早历史。"}`
          : `**更早历史 · 第 ${pending.number} 批（${pending.rounds} 轮）**\n本批时间早于之前同步的历史；以下内容按从早到晚排列。${pending.nextCursor ? "" : "\n已经到达本会话最早的记录。"}` });
      for (const message of pending.messages) if (await sendHistoryMessage(thread, sessionId, message)) synced++;
      completeConversationHistoryPage(thread.id, sessionId, pending.nextCursor);
      return { synced, rounds: pending.rounds, exhausted: pending.nextCursor === null };
    } catch {
      return { synced, rounds: pending.rounds, exhausted: false,
        warning: "历史同步尚未完成；重新执行 `/sync history` 会补齐本批，已发送内容不会重复。" };
    }
  });
}

/** Parent lock serializes imports; each imported conversation retains its Codex ID. */
export async function importConversationHistory(
  parent: TextChannel, userId: string, sessionId: string,
): Promise<{ thread: ThreadChannel; synced: number; reused: boolean; warning?: string; notice?: string }> {
  const project = getProject(parent.id);
  const stored = getStoredThread(sessionId);
  if (!project || project.parent_channel_id || !stored || !stored.cwd || stored.archived) {
    throw new Error("该会话已不存在、已归档，或无法读取原项目目录。请重新打开 `/sessions`。");
  }
  const mappedId = findSessionThread(parent.id, sessionId);
  let thread: ThreadChannel | null = null;
  if (mappedId) {
    try { thread = await parent.threads.fetch(mappedId); }
    catch (error) { if ((error as { code?: number }).code !== 10003) throw error; }
  }
  const reused = Boolean(thread);
  let history: HistoryPage | undefined;
  if (!thread) {
    history = await codexAppServer.readRecentTurns(sessionId, RECENT_TURNS);
    const starter = await parent.send({
      content: `**${stored.title || "Codex 会话"}**\n已有会话 · \`${sessionId.slice(0, 8)}\`\n工作目录：\`${stored.cwd}\`\n进入此消息的子区查看最近对话，并继续同一个 Codex 会话。`,
      allowedMentions: { parse: [] },
    });
    try { thread = await openConversationThread(starter, userId, stored.title || "继续 Codex 会话", sessionId, stored.cwd); }
    catch (error) { await starter.delete().catch(() => {}); throw error; }
  }
  if (thread.archived) {
    if (thread.locked) throw new Error("对应 Discord 子区已锁定，请先解除锁定。");
    await thread.setArchived(false);
  }
  await thread.members.add(userId).catch(() => {});
  const state = getConversationHistoryState(thread.id, sessionId);
  // Existing native conversations already contain their dialogue. Reopening an
  // imported conversation only retries an unfinished page; /sync loads older ones.
  if (reused && !state?.pending_page) return { thread, synced: 0, reused };
  try {
    const result = await syncConversationHistory(thread, history);
    return { thread, synced: result.synced, reused, warning: result.warning,
      notice: result.exhausted ? result.rounds ? "已经同步到本会话最早的记录。" : "该会话暂无历史消息，可直接在子区开始对话。" : undefined };
  } catch (error) {
    return { thread, synced: 0, reused,
      warning: `子区已连接，但尚未同步历史：${error instanceof Error ? error.message : "请重试"}。请在子区执行 \`/sync history\`。` };
  }
}
