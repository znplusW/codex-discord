import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, Collection } from "discord.js";

vi.mock("../../security/guard.js", () => ({ isAllowedUser: vi.fn(() => true), checkRateLimit: vi.fn(() => true) }));
vi.mock("../../codex/session-manager.js", () => ({ sessionManager: {
  sendMessage: vi.fn(), hasPendingCustomInput: vi.fn(), resolveCustomInput: vi.fn(),
  isActive: vi.fn(), hasQueue: vi.fn(), isQueueFull: vi.fn(), setPendingQueue: vi.fn(),
} }));

import { getDb, getProject, getSession, initDatabase, registerProject, setChatMode, selectSession, setConversationState, upsertSession } from "../../db/database.js";
import { sessionManager } from "../../codex/session-manager.js";
import { isAllowedUser, checkRateLimit } from "../../security/guard.js";
import { createHub,saveManagedConversation,bindManagedChannel } from "../../db/channel-conversations.js";
import { handleMessage } from "./message.js";
import { openConversationThread } from "../conversation-threads.js";

function rootMessage(id: string, content = "开始一个任务") {
  const thread = {
    id, parentId: "root", isThread: () => true, archived: false,
    members: { add: vi.fn().mockResolvedValue(undefined) },
    send: vi.fn().mockResolvedValue({ edit: vi.fn() }),
  };
  const message = {
    id, content, channelId: "root", guild: { id: "guild" }, system: false,
    author: { id: "owner", bot: false }, attachments: new Collection(),
    channel: { id: "root", type: ChannelType.GuildText, isThread: () => false,
      threads: { fetch: vi.fn().mockResolvedValue(null) } },
    startThread: vi.fn().mockResolvedValue(thread), reply: vi.fn(), react: vi.fn(),
  };
  return { message: message as any, thread: thread as any };
}

function replyIn(thread: any, content = "继续这个任务") {
  const { message } = rootMessage("reply", content);
  message.channelId = thread.id;
  message.channel = thread;
  return message;
}

describe("Discord conversation routing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isAllowedUser).mockReturnValue(true);
    vi.mocked(checkRateLimit).mockReturnValue(true);
    initDatabase(":memory:");
    registerProject("root", "/project", "guild");
    vi.mocked(sessionManager.sendMessage).mockImplementation(async (channel) => {
      upsertSession(getSession(channel.id)?.id ?? `db-${channel.id}`, channel.id, `codex-${channel.id}`, "idle");
    });
  });
  afterEach(() => getDb().close());

  it("creates independent sessions for root messages and resumes only the replied-to thread", async () => {
    const a = rootMessage("a", "任务 A");
    const b = rootMessage("b", "任务 B");
    await Promise.all([handleMessage(a.message), handleMessage(b.message)]);
    await handleMessage(replyIn(a.thread, "继续 A"));
    expect(a.message.startThread).toHaveBeenCalledWith(expect.objectContaining({ name: "任务 A" }));
    expect(getSession("a")?.session_id).toBe("codex-a");
    expect(getSession("b")?.session_id).toBe("codex-b");
    expect(getSession("root")).toBeUndefined();
    expect(sessionManager.sendMessage).toHaveBeenLastCalledWith(a.thread, "继续 A");
    expect(a.thread.members.add).toHaveBeenCalledWith("owner");
  });

  it("keeps main-channel messages in the selected legacy session, and starts fresh after clearing it", async () => {
    setChatMode("root", "channel");
    selectSession("root", "legacy-session");
    vi.mocked(sessionManager.sendMessage).mockImplementation(async (channel) => {
      const existing = getSession(channel.id);
      upsertSession(existing!.id, channel.id, existing?.session_id ?? "fresh-session", "idle");
    });
    const first = rootMessage("first");
    await handleMessage(first.message);
    expect(first.message.startThread).not.toHaveBeenCalled();
    expect(getSession("root")?.session_id).toBe("legacy-session");
    selectSession("root", null);
    await handleMessage(rootMessage("next").message);
    expect(getSession("root")?.session_id).toBe("fresh-session");
  });

  it("preserves child bindings when switching the parent back to legacy mode", async () => {
    const {message, thread} = rootMessage("a");
    await handleMessage(message);
    setChatMode("root", "channel");
    await handleMessage(replyIn(thread));
    expect(sessionManager.sendMessage).toHaveBeenLastCalledWith(thread, "继续这个任务");
    expect(getSession("a")?.session_id).toBe("codex-a");
  });

  it("does not resurrect archived or deleted child sessions", async () => {
    const {message, thread} = rootMessage("a");
    await handleMessage(message);
    setConversationState("a", "archived");
    await handleMessage(replyIn(thread));
    setConversationState("a", "deleted");
    await handleMessage(replyIn(thread));
    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("ignores system events, other bots, unauthorized users and unmapped threads", async () => {
    const { message, thread } = rootMessage("a");
    await handleMessage({ ...message, system: true });
    await handleMessage({ ...message, author: { id: "bot", bot: true } });
    await handleMessage(replyIn(thread));
    vi.mocked(isAllowedUser).mockReturnValue(false);
    await handleMessage(message);
    expect(message.startThread).not.toHaveBeenCalled();
    expect(sessionManager.sendMessage).not.toHaveBeenCalled();
  });

  it("does not rerun a replayed starter message", async () => {
    const { message } = rootMessage("a");
    await Promise.all([handleMessage(message), handleMessage(message)]);
    expect(message.startThread).toHaveBeenCalledTimes(1);
    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("reports a thread creation failure without executing in the parent", async () => {
    const { message } = rootMessage("a");
    message.startThread.mockRejectedValue(new Error("Missing Permissions"));
    await expect(handleMessage(message)).rejects.toThrow("Missing Permissions");
    expect(sessionManager.sendMessage).not.toHaveBeenCalled();
    expect(getProject("a")).toBeUndefined();
  });

  it("serializes an immediate reply behind initial startup and queues it in the same child", async () => {
    const { message, thread } = rootMessage("a");
    let release!: () => void;
    const starting = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(sessionManager.sendMessage).mockImplementation(async () => {
      await starting;
      vi.mocked(sessionManager.isActive).mockReturnValue(true);
    });
    const initial = handleMessage(message);
    await vi.waitFor(() => expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1));
    const reply = replyIn(thread);
    const next = handleMessage(reply);
    release();
    await Promise.all([initial, next]);
    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(sessionManager.setPendingQueue).toHaveBeenCalledWith("a", thread, "继续这个任务");
    const components = reply.reply.mock.calls[0][0].components[0].toJSON();
    expect(components.components[0].custom_id).toBe("queue-yes:a");
  });

  it("keeps requested custom input in its existing conversation", async () => {
    const { message, thread } = rootMessage("a");
    await handleMessage(message);
    vi.mocked(sessionManager.hasPendingCustomInput).mockReturnValue(true);
    const reply = replyIn(thread, "我的回答");
    await handleMessage(reply);
    expect(sessionManager.resolveCustomInput).toHaveBeenCalledWith("a", "我的回答");
    expect(sessionManager.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing thread when resuming the same historical Codex session", async () => {
    const first = rootMessage("a");
    await openConversationThread(first.message, "owner", "历史任务", "historic-codex");
    const second = rootMessage("b");
    second.message.channel.threads.fetch.mockResolvedValue(first.thread);
    const reused = await openConversationThread(second.message, "owner", "历史任务", "historic-codex");
    expect(reused.id).toBe("a");
    expect(second.message.startThread).not.toHaveBeenCalled();
    expect(getSession("a")?.session_id).toBe("historic-codex");
  });
  it("sends ordinary messages in a fixed channel to the same Codex ID without mentions or subthreads",async()=>{
    createHub("guild","/project","root");saveManagedConversation("guild","fixed-id","助理","/project");bindManagedChannel("guild","fixed-id","fixed");
    vi.mocked(sessionManager.sendMessage).mockResolvedValue(undefined);
    const {message}=rootMessage("ordinary","直接聊天");message.channelId="fixed";message.channel.id="fixed";
    await handleMessage(message);expect(sessionManager.sendMessage).toHaveBeenCalledWith(message.channel,"直接聊天");
    expect(getSession("fixed")?.session_id).toBe("fixed-id");expect(message.startThread).not.toHaveBeenCalled();
  });
  it("keeps archived fixed channels from submitting tasks or silently starting a replacement",async()=>{
    createHub("guild","/project","root");saveManagedConversation("guild","fixed-id","助理","/project");bindManagedChannel("guild","fixed-id","fixed");setConversationState("fixed","archived");
    const {message}=rootMessage("ordinary");message.channelId="fixed";message.channel.id="fixed";
    await handleMessage(message);expect(sessionManager.sendMessage).not.toHaveBeenCalled();expect(message.reply).toHaveBeenCalledWith(expect.stringContaining("/restore"));
    expect(getSession("fixed")?.session_id).toBe("fixed-id");
  });

});
