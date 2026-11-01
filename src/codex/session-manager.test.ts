import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db/database.js", () => ({
  upsertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  getProject: vi.fn(),
  getSession: vi.fn(),
  getChannelModelPreferences: vi.fn(),
  getAllSessions: vi.fn(),
  setAutoApprove: vi.fn(),
}));

vi.mock("../utils/config.js", () => ({
  getConfig: () => ({ SHOW_COST: false }),
}));

vi.mock("../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

vi.mock("./app-server-client.js", () => ({
  codexAppServer: {
    ensureStarted: vi.fn(),
    on: vi.fn(),
    startThread: vi.fn(),
    resumeThread: vi.fn(),
    startTurn: vi.fn(),
    respond: vi.fn(),
    interruptTurn: vi.fn(),
    releaseThread: vi.fn(),
  },
}));

import { codexAppServer } from "./app-server-client.js";
import { getProject, getSession, getChannelModelPreferences, upsertSession, getAllSessions } from "../db/database.js";
import { SessionManager } from "./session-manager.js";
import { createStopButton, splitMessage } from "./output-formatter.js";

function createFakeMessage() {
  return {
    edit: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SessionManager streaming output", () => {
  let now = 0;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accumulates agent deltas instead of replacing earlier text", async () => {
    const manager = new SessionManager();
    const firstMessage = createFakeMessage();
    const channel = {
      id: "channel-1",
      send: vi.fn(),
    } as any;

    (manager as any).sessions.set("channel-1", {
      channelId: "channel-1",
      channel,
      threadId: "thread-1",
      turnId: "turn-1",
      dbId: "db-1",
    });

    (manager as any).streamState.set("channel-1", {
      buffer: "",
      messages: [firstMessage],
      lastEditTime: 0,
      stopRow: createStopButton("channel-1"),
      startedAt: 0,
      lastActivity: "Thinking...",
      toolUseCount: 0,
      heartbeat: setInterval(() => {}, 60_000),
      hasTextOutput: false,
      lastError: null,
    });

    now = 2_000;
    await (manager as any).handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "저는 " },
    });

    now = 4_000;
    await (manager as any).handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "Codex입니다." },
    });

    expect(firstMessage.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "저는 Codex입니다." }),
    );
    expect(channel.send).not.toHaveBeenCalled();

    clearInterval((manager as any).streamState.get("channel-1").heartbeat);
  });

  it("keeps earlier chunks and sends only newly needed Discord messages", async () => {
    const manager = new SessionManager();
    const firstMessage = createFakeMessage();
    const sentMessages: Array<ReturnType<typeof createFakeMessage>> = [];
    const channel = {
      id: "channel-2",
      send: vi.fn().mockImplementation(async () => {
        const message = createFakeMessage();
        sentMessages.push(message);
        return message;
      }),
    } as any;

    (manager as any).sessions.set("channel-2", {
      channelId: "channel-2",
      channel,
      threadId: "thread-2",
      turnId: "turn-2",
      dbId: "db-2",
    });

    (manager as any).streamState.set("channel-2", {
      buffer: "",
      messages: [firstMessage],
      lastEditTime: 0,
      stopRow: createStopButton("channel-2"),
      startedAt: 0,
      lastActivity: "Thinking...",
      toolUseCount: 0,
      heartbeat: setInterval(() => {}, 60_000),
      hasTextOutput: false,
      lastError: null,
    });

    const firstDelta = "a".repeat(1890);
    const secondDelta = "\n" + "b".repeat(80);

    now = 2_000;
    await (manager as any).handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-2", delta: firstDelta },
    });

    now = 4_000;
    await (manager as any).handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-2", delta: secondDelta },
    });

    const chunks = splitMessage(firstDelta + secondDelta);
    expect(chunks).toHaveLength(2);
    expect(firstMessage.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: chunks[0] }),
    );
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(sentMessages[0].edit).not.toHaveBeenCalled();

    clearInterval((manager as any).streamState.get("channel-2").heartbeat);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeChannel(id: string) {
  const messages: ReturnType<typeof createFakeMessage>[] = [];
  return {
    id, messages,
    send: vi.fn(async () => {
      const message = createFakeMessage();
      messages.push(message);
      return message;
    }),
  } as any;
}

describe("SessionManager conversation ownership", () => {
  let manager: SessionManager;
  let persisted: Map<string, any>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    manager = new SessionManager();
    persisted = new Map();
    vi.mocked(getProject).mockImplementation((id) => ({
      channel_id: id, project_path: "/project", guild_id: "guild", auto_approve: 0,
      parent_channel_id: "root", chat_mode: "threads", conversation_state: "active", created_at: "now",
    }));
    vi.mocked(getSession).mockImplementation((id) => persisted.get(id));
    vi.mocked(getAllSessions).mockImplementation(()=>[...persisted.values()]);
    vi.mocked(upsertSession).mockImplementation((id, channelId, sessionId, status) => {
      persisted.set(channelId, { id, channel_id: channelId, session_id: sessionId, status });
    });
    vi.mocked(codexAppServer.ensureStarted).mockResolvedValue(undefined);
    let serial = 0;
    vi.mocked(codexAppServer.startThread).mockImplementation(async () => ({ id: `codex-${++serial}` } as any));
    vi.mocked(codexAppServer.resumeThread).mockImplementation(async (id) => ({ id } as any));
    vi.mocked(codexAppServer.startTurn).mockResolvedValue({ id: "turn" });
    vi.mocked(codexAppServer.respond).mockResolvedValue(undefined);
    vi.mocked(codexAppServer.interruptTurn).mockResolvedValue(undefined);
    vi.mocked(codexAppServer.releaseThread).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("exits one session by cancelling its queue and closing its writer, preserving another active session",async()=>{
    const a=fakeChannel("a"),b=fakeChannel("b");
    await manager.sendMessage(a,"a");await manager.sendMessage(b,"b");
    await (manager as any).handleNotification({method:"turn/started",params:{threadId:"codex-1",turn:{id:"turn-a"}}});
    manager.setPendingQueue("a",a,"queued a");manager.confirmQueue("a");
    expect(await manager.exitSession("a")).toEqual({threadId:"codex-1",cancelled:1});
    expect(codexAppServer.interruptTurn).toHaveBeenCalledWith("codex-1","turn-a");
    expect(codexAppServer.releaseThread).toHaveBeenCalledWith("codex-1");
    expect(manager.getQueueSize("a")).toBe(0);expect(manager.isActive("a")).toBe(false);expect(manager.isActive("b")).toBe(true);
    expect(persisted.get("a").session_id).toBe("codex-1");expect(codexAppServer.startTurn).toHaveBeenCalledTimes(2);
  });

  it("releases an idle writer and reports release failures rather than claiming exit succeeded",async()=>{
    await manager.sendMessage(fakeChannel("a"),"a");
    (manager as any).finishSession("a");
    vi.mocked(codexAppServer.releaseThread).mockRejectedValueOnce(new Error("cannot close"));
    await expect(manager.exitSession("a")).rejects.toThrow("cannot close");
    expect(await manager.exitSession("a")).toEqual({threadId:"codex-1",cancelled:0});
    expect(persisted.get("a").session_id).toBe("codex-1");
  });

  it("reserves startup immediately and initializes one listener set for parallel children", async () => {
    const startup = deferred<void>();
    vi.mocked(codexAppServer.ensureStarted).mockReturnValue(startup.promise);
    const a = fakeChannel("a");
    const b = fakeChannel("b");
    const first = manager.sendMessage(a, "A");
    const second = manager.sendMessage(b, "B");
    expect(manager.isActive("a")).toBe(true);
    expect(manager.isActive("b")).toBe(true);
    await manager.sendMessage(a, "duplicate during startup");
    startup.resolve(undefined);
    await Promise.all([first, second]);
    expect(codexAppServer.on).toHaveBeenCalledTimes(3);
    expect(codexAppServer.startThread).toHaveBeenCalledTimes(2);
    expect(codexAppServer.startTurn).toHaveBeenCalledTimes(2);
    expect(persisted.get("a").session_id).not.toBe(persisted.get("b").session_id);
  });

  it("routes streaming and approval cards only to their owning child", async () => {
    const a = fakeChannel("a");
    const b = fakeChannel("b");
    await Promise.all([manager.sendMessage(a, "A"), manager.sendMessage(b, "B")]);
    await (manager as any).handleNotification({ method: "item/agentMessage/delta", params: { threadId: "codex-2", delta: "Reply B" } });
    expect(b.messages[0].edit).toHaveBeenCalledWith(expect.objectContaining({ content: "Reply B" }));
    expect(a.messages[0].edit).not.toHaveBeenCalled();
    const approval = (manager as any).handleServerRequest({ id: 501, method: "item/commandExecution/requestApproval", params: { threadId: "codex-1", command: "echo test" } });
    await Promise.resolve();
    expect(a.send).toHaveBeenCalledTimes(2);
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(manager.resolveApproval("501", "deny")).toBe(true);
    await approval;
    expect(codexAppServer.respond).toHaveBeenCalledWith(501, { decision: "cancel" });
  });

  it("resumes a persisted mapping after process restart rather than starting another Codex thread", async () => {
    persisted.set("a", { id: "db-a", channel_id: "a", session_id: "saved-codex" });
    const channel = fakeChannel("a");
    await manager.sendMessage(channel, "continue");
    expect(codexAppServer.resumeThread).toHaveBeenCalledWith("saved-codex");
    expect(codexAppServer.startThread).not.toHaveBeenCalled();
    expect(codexAppServer.startTurn).toHaveBeenCalledWith("saved-codex", "continue");
    expect(persisted.get("a").id).toBe("db-a");
  });

  it("passes a new conversation's saved model and reasoning defaults into Codex creation", async () => {
    const preferences = { model: "test-model", reasoningEffort: "high" };
    vi.mocked(getChannelModelPreferences).mockReturnValue(preferences);
    await manager.sendMessage(fakeChannel("new-child"), "first task");
    expect(getChannelModelPreferences).toHaveBeenCalledWith("new-child");
    expect(codexAppServer.startThread).toHaveBeenCalledWith("/project", preferences);
    expect(codexAppServer.startTurn).toHaveBeenCalledWith("codex-1", "first task");
  });

  it("does not overwrite an existing conversation with its channel's new defaults", async () => {
    persisted.set("a", { id: "db-a", channel_id: "a", session_id: "saved-codex" });
    vi.mocked(getChannelModelPreferences).mockReturnValue({ model: "different-default", reasoningEffort: "low" });
    await manager.sendMessage(fakeChannel("a"), "continue with this conversation's saved settings");
    expect(getChannelModelPreferences).not.toHaveBeenCalled();
    expect(codexAppServer.startThread).not.toHaveBeenCalled();
    expect(codexAppServer.resumeThread).toHaveBeenCalledWith("saved-codex");
    expect(codexAppServer.startTurn).toHaveBeenCalledWith("saved-codex", "continue with this conversation's saved settings");
  });

  it("does not start the same Codex conversation through two different Discord bindings", async () => {
    persisted.set("a", { id: "db-a", session_id: "shared-codex" });
    persisted.set("b", { id: "db-b", session_id: "shared-codex" });
    const preparing = deferred<any>();
    vi.mocked(codexAppServer.resumeThread).mockReturnValue(preparing.promise);
    const a = fakeChannel("a");
    const b = fakeChannel("b");
    const first = manager.sendMessage(a, "A");
    expect(manager.isThreadActive("shared-codex")).toBe(true);
    const second = manager.sendMessage(b, "B");
    preparing.resolve({ id: "shared-codex" });
    await Promise.all([first, second]);
    expect(codexAppServer.resumeThread).toHaveBeenCalledTimes(1);
    expect(codexAppServer.startTurn).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledWith(expect.stringContaining("<#a>"));
    expect(manager.isActive("b")).toBe(false);
  });

  it("releases a failed startup reservation, allowing a later retry", async () => {
    persisted.set("a", { id: "db-a", session_id: "saved-codex" });
    vi.mocked(codexAppServer.resumeThread).mockRejectedValueOnce(new Error("temporary failure"));
    const channel = fakeChannel("a");
    await manager.sendMessage(channel, "first");
    expect(manager.isActive("a")).toBe(false);
    expect(manager.isThreadActive("saved-codex")).toBe(false);
    await manager.sendMessage(channel, "retry");
    expect(codexAppServer.startTurn).toHaveBeenCalledWith("saved-codex", "retry");
  });

  it("cancels outstanding approval controls when a conversation is stopped", async () => {
    const channel = fakeChannel("a");
    await manager.sendMessage(channel, "first");
    await (manager as any).handleNotification({ method: "turn/started", params: { threadId: "codex-1", turn: { id: "turn-a" } } });
    const approval = (manager as any).handleServerRequest({ id: 502, method: "item/commandExecution/requestApproval", params: { threadId: "codex-1", command: "echo test" } });
    await Promise.resolve();
    expect(await manager.stopSession("a")).toBe(true);
    await approval;
    expect(manager.resolveApproval("502", "approve")).toBe(false);
    expect(manager.isThreadActive("codex-1")).toBe(false);
    expect(codexAppServer.respond).toHaveBeenCalledWith(502, { decision: "cancel" });
  });

  it("starts queued follow-ups after completion and keeps the same Codex mapping", async () => {
    const channel = fakeChannel("a");
    await manager.sendMessage(channel, "first");
    manager.setPendingQueue("a", channel, "second");
    manager.confirmQueue("a");
    await (manager as any).handleNotification({ method: "turn/completed", params: { threadId: "codex-1", turn: { status: "completed" } } });
    // Finish schedules the follow-up without waiting for its startup I/O.
    await vi.waitFor(() => expect(codexAppServer.startTurn).toHaveBeenCalledTimes(2));
    expect(codexAppServer.startTurn).toHaveBeenLastCalledWith("codex-1", "second");
    expect(codexAppServer.startThread).toHaveBeenCalledTimes(1);
    expect(manager.isThreadActive("codex-1")).toBe(true);
  });
});
