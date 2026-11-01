import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";
vi.mock("../../security/guard.js",()=>({isAllowedUser:vi.fn(()=>true)}));
vi.mock("../../codex/session-manager.js",()=>({sessionManager:{isActive:vi.fn(),hasQueue:vi.fn(),getQueueSize:vi.fn()}}));
vi.mock("../../codex/storage.js",()=>({getStoredThread:vi.fn(),findStateDbPath:vi.fn(),listStoredThreads:vi.fn()}));
vi.mock("../../codex/app-server-client.js",()=>({codexAppServer:{readThread:vi.fn()}}));
vi.mock("../conversation-history.js",()=>({importConversationHistory:vi.fn()}));
vi.mock("../commands/conversation-lifecycle.js",()=>({handleConversationDeleteButton:vi.fn(()=>false)}));
import { importConversationHistory } from "../conversation-history.js";
import { isAllowedUser } from "../../security/guard.js";
import { codexAppServer } from "../../codex/app-server-client.js";
import { getStoredThread,listStoredThreads } from "../../codex/storage.js";
import { getDb,getSession,initDatabase,registerProject,registerThreadProject,selectSession,setChatMode } from "../../db/database.js";
import { handleSelectMenuInteraction } from "./interaction.js";
import { execute as sessionsCommand } from "../commands/sessions.js";
const parent={id:"root",type:ChannelType.GuildText};
const interaction=(channelId="root")=>({channelId,channel:parent,user:{id:"owner"},values:["saved"],customId:"session-select",
  client:{channels:{fetch:vi.fn().mockResolvedValue(parent)}},deferUpdate:vi.fn(),editReply:vi.fn(),reply:vi.fn()}) as any;
describe("import existing sessions in thread mode",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();vi.mocked(isAllowedUser).mockReturnValue(true);initDatabase(":memory:");registerProject("root","/project","guild");
    vi.mocked(getStoredThread).mockReturnValue({id:"saved",cwd:"/project",title:"最近会话"} as any);
    vi.mocked(importConversationHistory).mockResolvedValue({thread:{id:"imported"} as any,synced:4,reused:false});
  });
  afterEach(()=>getDb().close());
  it("imports immediately from the root menu without changing the root's legacy session",async()=>{
    selectSession("root","legacy");const i=interaction();await handleSelectMenuInteraction(i);
    expect(importConversationHistory).toHaveBeenCalledWith(parent,"owner","saved");
    expect(getSession("root")?.session_id).toBe("legacy");
    expect(codexAppServer.readThread).not.toHaveBeenCalled();
    expect(i.editReply.mock.calls[0][0].content).toContain("<#imported>");
  });
  it("a menu in one child opens the other session in the parent without rebinding this child",async()=>{
    registerThreadProject("child","root");selectSession("child","current-child");
    const i=interaction("child");await handleSelectMenuInteraction(i);
    expect(i.client.channels.fetch).toHaveBeenCalledWith("root");
    expect(importConversationHistory).toHaveBeenCalledWith(parent,"owner","saved");
    expect(getSession("child")?.session_id).toBe("current-child");
  });
  it("channel mode refuses an other-project selection before reading or importing its contents",async()=>{
    setChatMode("root","channel");
    vi.mocked(getStoredThread).mockReturnValue({cwd:"/other"} as any);
    const i=interaction();await handleSelectMenuInteraction(i);
    expect(importConversationHistory).not.toHaveBeenCalled();expect(codexAppServer.readThread).not.toHaveBeenCalled();
    expect(i.editReply.mock.calls[0][0].content).toContain("不属于");
  });
  it("/sessions remains usable inside a child and explains the 20-round import",async()=>{
    registerThreadProject("child","root");
    vi.mocked(listStoredThreads).mockReturnValue([{id:"saved",title:"最近会话",source:"cli",updated_at:1}] as any);
    const i=interaction("child");await sessionsCommand(i);
    expect(i.editReply.mock.calls[0][0].embeds[0].description).toContain("20 轮");
    expect(i.editReply.mock.calls[0][0].components[0].toJSON().components[0].options[1].value).toBe("saved");
  });
});
