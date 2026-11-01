import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../codex/thread-lifecycle.js", () => ({ changeThreadLifecycle: vi.fn() }));
vi.mock("../../codex/session-manager.js", () => ({ sessionManager: {
  isActive: vi.fn(), isThreadActive: vi.fn(), hasQueue: vi.fn(), getQueueSize: vi.fn(),
} }));
vi.mock("../../security/guard.js", () => ({ isAllowedUser: vi.fn() }));

import { changeThreadLifecycle } from "../../codex/thread-lifecycle.js";
import { sessionManager } from "../../codex/session-manager.js";
import { isAllowedUser } from "../../security/guard.js";
import { getDb, getProject, getSession, initDatabase, registerProject, registerThreadProject, selectSession, setChatMode, setConversationState } from "../../db/database.js";
import { handleConversationDeleteButton, performConversationLifecycle, requestConversationDelete } from "./conversation-lifecycle.js";
import { withConversationLock } from "../conversation-lock.js";
import { execute as archive } from "./archive.js";

const SESSION = "01a19600-1234-7000-8000-000000000001";
function thread(id = "child") {
  return { id, name: "测试会话", parentId: "root", guildId: "guild", isThread: () => true,
    setArchived: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined),
    parent: { isSendable: () => true, send: vi.fn().mockResolvedValue(undefined) } };
}
function interaction(channelId = "root", channel: any = { isThread: () => false }): any {
  return {
    channelId, channel, guildId: "guild", user: { id: "1234567890" },
    client: { channels: { fetch: vi.fn() } }, options: { getBoolean: vi.fn() },
    editReply: vi.fn().mockResolvedValue(undefined), reply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined), customId: "",
  };
}
function bindChild(id = "child", sessionId = SESSION) {
  registerThreadProject(id, "root");
  selectSession(id, sessionId);
}

describe("conversation lifecycle commands", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isAllowedUser).mockReturnValue(true);
    initDatabase(":memory:");
    registerProject("root", "/project", "guild");
    setChatMode("root", "channel");
    selectSession("root", SESSION);
  });
  afterEach(() => getDb().close());

  it.each(["archive", "delete"] as const)("clears the current channel binding only after verified %s", async (action) => {
    const input = interaction();
    vi.mocked(changeThreadLifecycle).mockImplementation(async () => {
      expect(getSession("root")?.session_id).toBe(SESSION);
    });
    await performConversationLifecycle(input, action);
    expect(changeThreadLifecycle).toHaveBeenCalledWith(SESSION, action);
    expect(getSession("root")?.session_id).toBeNull();
    expect(getProject("root")?.conversation_state).toBe("active");
    expect(input.editReply.mock.calls[0][0].content).toContain("下一条普通消息会自动创建新会话");
  });

  it("preserves the binding and reports incomplete when core/desktop verification fails", async () => {
    const input = interaction();
    vi.mocked(changeThreadLifecycle).mockRejectedValue(new Error("desktop catalog still contains this thread"));
    await archive(input);
    expect(getSession("root")?.session_id).toBe(SESSION);
    expect(input.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("未完成操作") }));
  });

  it("archives the matching child and root, leaves unrelated sessions untouched, and can restore", async () => {
    bindChild();
    bindChild("other", "other-codex");
    const channel = thread();
    const input = interaction("child", channel);
    await performConversationLifecycle(input, "archive");
    expect(getSession("root")?.session_id).toBeNull();
    expect(getSession("child")?.session_id).toBe(SESSION);
    expect(getProject("child")?.conversation_state).toBe("archived");
    expect(getProject("other")?.conversation_state).toBe("active");
    expect(channel.setArchived).toHaveBeenCalledWith(true, expect.any(String));
    expect(channel.parent.send).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("<#child>") }));
    expect(input.editReply).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining("正在同步 Discord 子区") }));
    expect(input.editReply.mock.invocationCallOrder[0]).toBeLessThan(channel.setArchived.mock.invocationCallOrder[0]);
    expect(channel.setArchived.mock.invocationCallOrder[0]).toBeLessThan(channel.parent.send.mock.invocationCallOrder[0]);
    await performConversationLifecycle(input, "restore");
    expect(changeThreadLifecycle).toHaveBeenLastCalledWith(SESSION, "restore");
    expect(getProject("child")?.conversation_state).toBe("active");
    expect(getSession("root")?.session_id).toBeNull();
    expect(channel.setArchived).toHaveBeenLastCalledWith(false, expect.any(String));
  });

  it("deletes only matching Discord threads and reports the result in the parent", async () => {
    bindChild();
    const channel = thread();
    const input = interaction("child", channel);
    await performConversationLifecycle(input, "delete");
    expect(changeThreadLifecycle).toHaveBeenCalledWith(SESSION, "delete");
    expect(channel.delete).toHaveBeenCalledTimes(1);
    expect(getProject("child")?.conversation_state).toBe("deleted");
    expect(getSession("root")?.session_id).toBeNull();
    expect(channel.parent.send).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("桌面列表已核验") }));
    expect(channel.parent.send).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("测试会话") }));
    expect(input.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("正在同步 Discord 子区") }));
  });

  it("keeps a tombstone and reports partial completion if the Discord deletion fails", async () => {
    bindChild();
    const channel = thread();
    channel.delete.mockRejectedValue(new Error("Missing Permissions"));
    const input = interaction("child", channel);
    await performConversationLifecycle(input, "delete");
    expect(getProject("child")?.conversation_state).toBe("deleted");
    expect(getSession("root")?.session_id).toBeNull();
    expect(channel.parent.send.mock.calls[0][0].content).toContain("Discord 子区同步未全部完成");
  });

  it("requests confirmation without deleting and rejects a stale confirmation after switching sessions", async () => {
    const input = interaction();
    await requestConversationDelete(input);
    expect(changeThreadLifecycle).not.toHaveBeenCalled();
    const row = input.editReply.mock.calls[0][0].components[0].toJSON();
    const confirm = row.components[0].custom_id;
    expect(confirm).toContain(SESSION);
    expect(confirm.length).toBeLessThanOrEqual(100);
    selectSession("root", "different-codex-session");
    input.customId = confirm;
    await handleConversationDeleteButton(input);
    expect(changeThreadLifecycle).not.toHaveBeenCalled();
    expect(getSession("root")?.session_id).toBe("different-codex-session");
    expect(input.editReply).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining("已失效") }));
  });

  it("requires the same authorized user for the destructive confirmation", async () => {
    const input = interaction();
    input.customId = `conversation-delete-confirm:${SESSION}:someone-else`;
    await handleConversationDeleteButton(input);
    expect(changeThreadLifecycle).not.toHaveBeenCalled();
    expect(input.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    input.customId = `conversation-delete-confirm:${SESSION}:${input.user.id}`;
    vi.mocked(isAllowedUser).mockReturnValue(false);
    await handleConversationDeleteButton(input);
    expect(changeThreadLifecycle).not.toHaveBeenCalled();
  });

  it("allows cancelling confirmation without any changes", async () => {
    const input = interaction();
    input.customId = `conversation-delete-cancel:${SESSION}:${input.user.id}`;
    expect(await handleConversationDeleteButton(input)).toBe(true);
    expect(changeThreadLifecycle).not.toHaveBeenCalled();
    expect(getSession("root")?.session_id).toBe(SESSION);
  });

  it("executes a current confirmation and clears the binding", async () => {
    const input = interaction();
    input.customId = `conversation-delete-confirm:${SESSION}:${input.user.id}`;
    expect(await handleConversationDeleteButton(input)).toBe(true);
    expect(input.deferUpdate).toHaveBeenCalledOnce();
    expect(changeThreadLifecycle).toHaveBeenCalledWith(SESSION, "delete");
    expect(getSession("root")?.session_id).toBeNull();
  });

  it("does not clear another channel's current binding because an old session row matches", async () => {
    registerProject("other-root", "/project", "guild");
    setChatMode("other-root", "channel");
    selectSession("other-root", "other-current-session");
    getDb().prepare("INSERT INTO sessions (id, channel_id, session_id, status, created_at) VALUES (?, ?, ?, 'idle', '2000-01-01')")
      .run("old-binding", "other-root", SESSION);
    await performConversationLifecycle(interaction(), "delete");
    expect(getSession("other-root")?.session_id).toBe("other-current-session");
    expect(getSession("root")?.session_id).toBeNull();
  });

  it.each(["active", "startingElsewhere", "queued", "pendingQueue"])("refuses lifecycle changes while %s", async (busy) => {
    bindChild();
    vi.mocked(sessionManager.isActive).mockImplementation((id) => busy === "active" && id === "child");
    vi.mocked(sessionManager.isThreadActive).mockReturnValue(busy === "startingElsewhere");
    vi.mocked(sessionManager.getQueueSize).mockImplementation((id) => busy === "queued" && id === "child" ? 1 : 0);
    vi.mocked(sessionManager.hasQueue).mockImplementation((id) => busy === "pendingQueue" && id === "child");
    await expect(performConversationLifecycle(interaction(), "archive")).rejects.toThrow("运行中或排队");
    expect(changeThreadLifecycle).not.toHaveBeenCalled();
  });

  it("does not act on a stale root binding while in thread mode", async () => {
    setChatMode("root", "threads");
    await expect(performConversationLifecycle(interaction(), "delete")).rejects.toThrow("请进入");
    expect(changeThreadLifecycle).not.toHaveBeenCalled();
    expect(getSession("root")?.session_id).toBe(SESSION);
  });

  it("rechecks the exact session after waiting for an in-flight message lock", async () => {
    let release!: () => void;
    const waiting = withConversationLock("root", () => new Promise<void>((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeDefined());
    const action = performConversationLifecycle(interaction(), "archive");
    selectSession("root", "new-session");
    release();
    await waiting;
    await expect(action).rejects.toThrow("当前会话已改变");
    expect(changeThreadLifecycle).not.toHaveBeenCalled();
  });

  it("rejects restore of a deleted child", async () => {
    bindChild();
    setConversationState("child", "deleted");
    await expect(performConversationLifecycle(interaction("child", thread()), "restore")).rejects.toThrow("只有仍保留");
    expect(changeThreadLifecycle).not.toHaveBeenCalled();
  });

  it("reports an error in the parent if an archived thread cannot edit its interaction reply", async () => {
    bindChild();
    const channel = thread();
    const input = interaction("child", channel);
    input.editReply.mockRejectedValue(new Error("Thread is archived"));
    vi.mocked(changeThreadLifecycle).mockRejectedValue(new Error("Core verification failed"));
    await archive(input);
    expect(channel.parent.send).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("未完成操作：Core verification failed") }));
    expect(getProject("child")?.conversation_state).toBe("active");
  });
});
