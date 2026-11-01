import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../codex/storage.js", () => ({
  listStoredThreads: vi.fn(),
}));

import { listStoredThreads } from "../../codex/storage.js";
import {
  findSessionDir,
  getLastAssistantMessage,
  getLastAssistantMessageFull,
  listSessions,
  execute,
  showSessions,
} from "./sessions.js";
import { getDb, initDatabase, registerProject,setChatMode } from "../../db/database.js";

describe("sessions helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("findSessionDir returns the parent directory of the first rollout file", () => {
    vi.mocked(listStoredThreads).mockReturnValue([
      {
        id: "thread-1",
        rollout_path: "/tmp/codex/2026/03/rollout-1.jsonl",
        created_at: 1,
        updated_at: 2,
        source: "vscode",
        model_provider: "openai",
        cwd: "/project",
        title: "Hello",
      },
    ]);

    expect(findSessionDir("/project")).toBe("/tmp/codex/2026/03");
  });

  it("findSessionDir returns null when no stored threads exist", () => {
    vi.mocked(listStoredThreads).mockReturnValue([]);
    expect(findSessionDir("/project")).toBeNull();
  });

  it("getLastAssistantMessageFull reads Codex agentMessage entries", async () => {
    const filePath = path.join(os.tmpdir(), `codex-session-${Date.now()}.jsonl`);
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "item_completed", item: { type: "agentMessage", text: "First" } }),
        JSON.stringify({ type: "item_completed", item: { type: "agentMessage", text: "Line 1\nLine 2" } }),
      ].join("\n"),
    );

    const result = await getLastAssistantMessageFull(filePath);
    expect(result).toBe("Line 1\nLine 2");
  });

  it("getLastAssistantMessage returns the last line of the last message", async () => {
    const filePath = path.join(os.tmpdir(), `codex-session-last-${Date.now()}.jsonl`);
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "item_completed", item: { type: "agentMessage", text: "Part A" } }),
        JSON.stringify({ type: "item_completed", item: { type: "agentMessage", text: "Part B\nTail" } }),
      ].join("\n"),
    );

    const result = await getLastAssistantMessage(filePath);
    expect(result).toBe("Tail");
  });

  it("listSessions maps stored threads into session summaries", async () => {
    vi.mocked(listStoredThreads).mockReturnValue([
      {
        id: "thread-1",
        rollout_path: "/tmp/rollout-1.jsonl",
        created_at: 1,
        updated_at: 1700000000,
        source: "vscode",
        model_provider: "openai",
        cwd: "/project",
        title: "Analyze repo",
      },
    ]);

    const result = await listSessions("/project");
    expect(result).toEqual([
      {
        sessionId: "thread-1",
        preview: "Analyze repo",
        timestamp: new Date(1700000000 * 1000).toISOString(),
        source: "vscode",
      },
    ]);
  });

  it("renders real Discord menu builders with long metadata and excludes internal agent chats",async()=>{
    initDatabase(":memory:");registerProject("root","/project","guild");
    try {
      vi.mocked(listStoredThreads).mockReturnValue([
        {id:"main",title:"😀".repeat(80),source:JSON.stringify({external:"source".repeat(80)}),updated_at:1700000000},
        {id:"internal",title:"internal",source:JSON.stringify({subagent:{thread_spawn:{agent_path:"/root/helper",extra:"long".repeat(80)}}}),updated_at:1700000001},
      ] as any);
      const i={channelId:"root",editReply:vi.fn()} as any;
      await execute(i);
      const menu=i.editReply.mock.calls[0][0].components[0].toJSON().components[0];
      expect(menu.options.map((o:any)=>o.value)).toEqual(["__new_session__","main"]);
      expect(menu.options[1].label.length).toBeLessThanOrEqual(100);
      expect(menu.options[1].label.endsWith("😀")).toBe(true);
      expect(menu.options[1].description.length).toBeLessThanOrEqual(100);
      expect(menu.options[1].description).toContain("Codex 会话");
      expect(menu.options[1].description).not.toContain("external");
    } finally {getDb().close();}
  });

  it("browses all desktop projects with pages in thread mode while channel mode remains project-scoped",async()=>{
    initDatabase(":memory:");registerProject("root","/project","guild");
    try {
      vi.mocked(listStoredThreads).mockReturnValue(Array.from({length:39},(_,i)=>({id:`session-${i}`,title:`桌面会话 ${i}`,source:"vscode",updated_at:1700000000-i,cwd:`/project-${i}`})) as any);
      const i={channelId:"root",editReply:vi.fn()} as any;
      await showSessions(i,1);
      expect(listStoredThreads).toHaveBeenLastCalledWith(undefined);
      const payload=i.editReply.mock.calls[0][0];
      expect(payload.embeds[0].title).toContain("2/2");
      expect(payload.components[0].toJSON().components[0].options[1].value).toBe("session-24");
      expect(payload.components[0].toJSON().components[0].options).toHaveLength(16);
      expect(payload.components[1].toJSON().components[0].custom_id).toBe("session-page:0");
      setChatMode("root","channel");await showSessions(i);
      expect(listStoredThreads).toHaveBeenLastCalledWith("/project");
    } finally {getDb().close();}
  });
});
