import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";
vi.mock("../codex/app-server-client.js", () => ({ codexAppServer: { readRecentTurns: vi.fn() } }));
vi.mock("../codex/storage.js", () => ({ getStoredThread: vi.fn() }));
vi.mock("../codex/session-manager.js", () => ({ sessionManager: { isActive: vi.fn(), isThreadActive: vi.fn() } }));
import { codexAppServer, type CodexTurn } from "../codex/app-server-client.js";
import { getStoredThread } from "../codex/storage.js";
import { sessionManager } from "../codex/session-manager.js";
import { getDb, getProject, getSession, initDatabase, registerProject, registerThreadProject, selectSession, getConversationHistoryState } from "../db/database.js";
import { importConversationHistory, renderRecentHistory, syncConversationHistory } from "./conversation-history.js";

function turn(index: number): CodexTurn {
  return { id: `turn-${index}`, status: "completed", items: [
    { id: `u-${index}`, type: "userMessage", content: [{ type: "text", text: `问题 ${index}` }] },
    { id: `tool-${index}`, type: "commandExecution", command: "private tool output", cwd: "/project", status: "completed" },
    { id: `a-${index}`, type: "agentMessage", text: `答复 ${index}` },
  ] };
}
function page(start: number, count: number, nextCursor: string | null = null) {
  return { turns: Array.from({ length: count }, (_, i) => turn(start + i)), nextCursor, hasMore: Boolean(nextCursor) };
}
function surfaces() {
  const threads = new Map<string, any>();
  let nextMessage = 0;
  const thread = { id: "entry", archived: false, locked: false, members: { add: vi.fn().mockResolvedValue(undefined) },
    send: vi.fn(async () => ({ id: `message-${++nextMessage}` })) } as any;
  const parent = { id: "root", type: ChannelType.GuildText, threads: { fetch: vi.fn(async id => threads.get(id) ?? null) }, send: vi.fn() } as any;
  const starter = { id: "entry", channelId: "root", channel: parent, delete: vi.fn(),
    startThread: vi.fn(async () => { threads.set(thread.id, thread); return thread; }) };
  parent.send.mockResolvedValue(starter);
  return { parent, thread, starter, threads };
}
describe("conversation history import and older pages", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    initDatabase(":memory:"); registerProject("root", "/project", "guild");
    vi.mocked(getStoredThread).mockReturnValue({ id: "original", cwd: "/project", title: "原会话", archived: 0 } as any);
    vi.mocked(codexAppServer.readRecentTurns).mockResolvedValue(page(1, 2));
  });
  afterEach(() => getDb().close());

  it("renders user and assistant text in order, omits tools/reasoning, and preserves long text", () => {
    const t = turn(1);
    t.items.push({ id: "r", type: "reasoning", text: "private reasoning" });
    const rendered = renderRecentHistory([t]);
    expect(rendered.map(m => m.content)).toEqual(["**用户 · 历史**\n问题 1", "**Codex 助手 · 历史**\n答复 1"]);
    const text = "中".repeat(6000);
    t.items = [{ id: "long", type: "agentMessage", text }];
    const chunks = renderRecentHistory([t]);
    expect(chunks.every(m => m.content.length <= 2000)).toBe(true);
    expect(chunks.map(m => m.content).join("").replace("**Codex 助手 · 历史**\n", "")).toBe(text);
    expect(new Set(chunks.map(m => m.key)).size).toBe(chunks.length);
    expect(renderRecentHistory([{ ...t, status: "inProgress" }])).toEqual([]);
  });

  it("creates a separate entry and child bound to the original session, then reuses both", async () => {
    const { parent, thread, starter } = surfaces();
    const result = await importConversationHistory(parent, "owner", "original");
    expect(result).toMatchObject({ thread, synced: 4, reused: false });
    expect(getSession("entry")?.session_id).toBe("original");
    expect(parent.send).toHaveBeenCalledOnce(); expect(starter.startThread).toHaveBeenCalledOnce();
    expect(codexAppServer.readRecentTurns).toHaveBeenCalledWith("original", 20);
    for (const [message] of thread.send.mock.calls) expect(message.allowedMentions).toEqual({ parse: [] });
    const count = thread.send.mock.calls.length;
    expect((await importConversationHistory(parent, "owner", "original")).reused).toBe(true);
    expect(parent.send).toHaveBeenCalledOnce(); expect(thread.send).toHaveBeenCalledTimes(count);
  });

  it("loads 20 rounds then the remaining 7 and stops without repeating anything", async () => {
    const { parent, thread } = surfaces();
    vi.mocked(codexAppServer.readRecentTurns).mockResolvedValueOnce(page(8, 20, "older"))
      .mockResolvedValueOnce(page(1, 7));
    await importConversationHistory(parent, "owner", "original");
    const older = await syncConversationHistory(thread);
    expect(older).toMatchObject({ rounds: 7, synced: 14, exhausted: true });
    expect(codexAppServer.readRecentTurns).toHaveBeenLastCalledWith("original", 20, "older");
    const count = thread.send.mock.calls.length;
    expect(await syncConversationHistory(thread)).toEqual({ rounds: 0, synced: 0, exhausted: true });
    expect(thread.send).toHaveBeenCalledTimes(count); expect(codexAppServer.readRecentTurns).toHaveBeenCalledTimes(2);
    expect(thread.send.mock.calls.some(([m]: any[]) => m.content.includes("本批时间早于"))).toBe(true);
  });

  it("handles no history without sending empty history messages", async () => {
    const { parent, thread } = surfaces();
    vi.mocked(codexAppServer.readRecentTurns).mockResolvedValue(page(0, 0));
    await importConversationHistory(parent, "owner", "original");
    expect(thread.send).not.toHaveBeenCalled();
    expect(await syncConversationHistory(thread)).toEqual({ synced: 0, rounds: 0, exhausted: true });
  });

  it("persists the pending batch and resumes only missing parts after a partial send", async () => {
    const { parent, thread } = surfaces();
    thread.send.mockResolvedValueOnce({ id: "header" }).mockResolvedValueOnce({ id: "user" }).mockRejectedValueOnce(new Error("network"));
    const result = await importConversationHistory(parent, "owner", "original");
    expect(result.warning).toContain("尚未完成");
    expect(getConversationHistoryState("entry", "original")?.pending_page).toBeTruthy();
    const retried = await syncConversationHistory(thread);
    expect(retried).toMatchObject({ rounds: 2, synced: 3, exhausted: true });
    expect(getConversationHistoryState("entry", "original")?.pending_page).toBeNull();
    expect(codexAppServer.readRecentTurns).toHaveBeenCalledOnce();
    expect(thread.send.mock.calls.filter(([m]: any[]) => m.content === "**用户 · 历史**\n问题 1")).toHaveLength(1);
  });

  it("does not duplicate native conversation text when reopening its existing child", async () => {
    const { parent, thread, threads } = surfaces();
    registerThreadProject("entry", "root"); selectSession("entry", "original"); threads.set("entry", thread);
    const result = await importConversationHistory(parent, "owner", "original");
    expect(result.reused).toBe(true); expect(thread.send).not.toHaveBeenCalled(); expect(codexAppServer.readRecentTurns).not.toHaveBeenCalled();
  });

  it("imports a desktop session from another directory while retaining its original cwd",async()=>{
    const {parent}=surfaces();
    vi.mocked(getStoredThread).mockReturnValue({id:"original",cwd:"/desktop-project",title:"桌面旧会话",archived:0} as any);
    await importConversationHistory(parent,"owner","original");
    expect(getProject("entry")?.project_path).toBe("/desktop-project");
    expect(getProject("root")?.project_path).toBe("/project");
    expect(getSession("entry")?.session_id).toBe("original");
  });

  it("rejects missing-directory and archived sessions before creating an entry", async () => {
    const { parent } = surfaces();
    for (const info of [{ cwd: "" }, { cwd: "/project", archived: 1 }]) {
      vi.mocked(getStoredThread).mockReturnValue(info as any);
      await expect(importConversationHistory(parent, "owner", "original")).rejects.toThrow("已归档");
    }
    expect(parent.send).not.toHaveBeenCalled();
  });

  it("refuses history replay during a running turn or in an unbound child", async () => {
    const { thread } = surfaces();
    await expect(syncConversationHistory(thread)).rejects.toThrow("已绑定");
    registerThreadProject("entry", "root"); selectSession("entry", "original");
    vi.mocked(sessionManager.isThreadActive).mockReturnValue(true);
    await expect(syncConversationHistory(thread)).rejects.toThrow("正在处理");
    expect(thread.send).not.toHaveBeenCalled();
  });
});
