import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSessionThread, getDb, getProject, getSession, initDatabase, registerProject, registerThreadProject, setAutoApprove, setChatMode, setChannelModelPreferences, getChannelModelPreferences, unregisterProject, upsertSession, prepareConversationHistoryPage, completeConversationHistoryPage, getConversationHistoryState, recordSyncedHistoryMessage, hasSyncedHistoryMessage } from "./database.js";

describe("persistent conversation mappings", () => {
  let directory: string;
  let databasePath: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-discord-conversations-"));
    databasePath = path.join(directory, "test.db");
  });
  afterEach(() => {
    if (getDb()?.open) getDb().close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("migrates an existing database without losing its original session, and reopens safely", () => {
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE projects (channel_id TEXT PRIMARY KEY, project_path TEXT NOT NULL,
        guild_id TEXT NOT NULL, auto_approve INTEGER DEFAULT 0, created_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, channel_id TEXT REFERENCES projects(channel_id) ON DELETE CASCADE,
        session_id TEXT, status TEXT, last_activity TEXT, created_at TEXT);
      INSERT INTO projects VALUES ('root', '/project', 'guild', 0, 'before');
      INSERT INTO sessions VALUES ('old', 'root', 'old-codex-session', 'idle', 'before', 'before');
    `);
    legacy.close();
    initDatabase(databasePath);
    setChatMode("root", "channel");
    setChannelModelPreferences("root", {model:"test-model", reasoningEffort:"high"});
    registerThreadProject("child", "root");
    upsertSession("new", "child", "new-codex-session", "idle");
    getDb().close();
    initDatabase(databasePath);
    expect(getChannelModelPreferences("root")).toEqual({model:"test-model", reasoningEffort:"high"});
    expect(getChannelModelPreferences("child")).toEqual({model:"test-model", reasoningEffort:"high"});
    expect(getProject("root")?.chat_mode).toBe("channel");
    expect(getSession("root")?.session_id).toBe("old-codex-session");
    expect(getProject("child")?.parent_channel_id).toBe("root");
    expect(getSession("child")?.session_id).toBe("new-codex-session");
    expect(getDb().pragma("foreign_key_check")).toEqual([]);
  });

  it("isolates sibling sessions and inherits only the parent's project and approval setting", () => {
    initDatabase(databasePath);
    registerProject("root", "/project", "guild");
    setAutoApprove("root", true);
    registerThreadProject("a", "root");
    registerThreadProject("b", "root");
    upsertSession("one", "a", "codex-a", "idle");
    upsertSession("two", "b", "codex-b", "waiting");
    registerThreadProject("a", "root");
    registerProject("root", "/project", "guild");
    expect(getProject("a")).toMatchObject({ project_path: "/project", auto_approve: 1, parent_channel_id: "root" });
    expect(getSession("a")?.session_id).toBe("codex-a");
    expect(getSession("b")?.session_id).toBe("codex-b");
    expect(findSessionThread("root", "codex-b")).toBe("b");
    expect(findSessionThread("elsewhere", "codex-b")).toBeUndefined();
  });

  it("retains pending history, sent parts, and the next older cursor across a restart",()=>{
    initDatabase(databasePath);registerProject("root","/project","guild");registerThreadProject("child","root");
    prepareConversationHistoryPage("child","codex",JSON.stringify({number:1,messages:["pending"]}));
    recordSyncedHistoryMessage("child","codex","first-part","discord-message");
    getDb().close();initDatabase(databasePath);
    expect(JSON.parse(getConversationHistoryState("child","codex")!.pending_page!)).toMatchObject({number:1});
    expect(hasSyncedHistoryMessage("child","codex","first-part")).toBe(true);
    completeConversationHistoryPage("child","codex","older-cursor");
    getDb().close();initDatabase(databasePath);
    expect(getConversationHistoryState("child","codex")).toMatchObject({next_cursor:"older-cursor",pending_page:null,page_number:1,exhausted:0});
    completeConversationHistoryPage("child","codex",null);
    expect(getConversationHistoryState("child","codex")).toMatchObject({exhausted:1,next_cursor:null});
  });

  it("rejects nested or conflicting bindings and cascades only the removed project", () => {
    initDatabase(databasePath);
    registerProject("root", "/project", "guild");
    registerProject("other", "/other", "guild");
    registerThreadProject("child", "root");
    upsertSession("one", "child", "codex-a", "idle");
    expect(() => registerThreadProject("nested", "child")).toThrow();
    expect(() => registerThreadProject("child", "other")).toThrow();
    unregisterProject("root");
    expect(getProject("child")).toBeUndefined();
    expect(getSession("child")).toBeUndefined();
    expect(getProject("other")).toBeDefined();
  });
});
