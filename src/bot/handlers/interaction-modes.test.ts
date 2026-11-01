import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../security/guard.js",()=>({isAllowedUser:vi.fn(()=>true)}));
vi.mock("../../codex/session-manager.js",()=>({sessionManager:{isActive:vi.fn(),hasQueue:vi.fn(),getQueueSize:vi.fn()}}));
vi.mock("../../codex/storage.js",()=>({getStoredThread:vi.fn(),findStateDbPath:vi.fn()}));
vi.mock("../commands/conversation-lifecycle.js",()=>({handleConversationDeleteButton:vi.fn(()=>false)}));
import { handleSelectMenuInteraction,handleButtonInteraction } from "./interaction.js";
import { getDb,getSession,initDatabase,registerProject,setChatMode,selectSession } from "../../db/database.js";
import { getStoredThread } from "../../codex/storage.js";
import { sessionManager } from "../../codex/session-manager.js";
const interaction = ()=>({channelId:"root",user:{id:"owner"},values:["__new_session__"],customId:"session-select",deferUpdate:vi.fn(),editReply:vi.fn(),reply:vi.fn(),message:{startThread:vi.fn()}}) as any;
describe("session menu in channel mode",()=>{
 beforeEach(()=>{vi.clearAllMocks();initDatabase(":memory:");registerProject("root","/project","guild");setChatMode("root","channel");selectSession("root","old");});
 afterEach(()=>getDb().close());
 it("create-new clears the selected session without creating a Discord child",async()=>{
  const i=interaction();await handleSelectMenuInteraction(i);
  expect(getSession("root")?.session_id).toBeNull();expect(i.message.startThread).not.toHaveBeenCalled();
 });
 it("resume selects a historical session of this project",async()=>{
  vi.mocked(getStoredThread).mockReturnValue({cwd:"/project",id:"saved"} as any);
  const i=interaction();i.customId="session-resume:saved";await handleButtonInteraction(i);
  expect(getSession("root")?.session_id).toBe("saved");
 });
 it("rejects a stale menu for another project",async()=>{
  vi.mocked(getStoredThread).mockReturnValue({cwd:"/other",id:"elsewhere"} as any);
  const i=interaction();i.customId="session-resume:elsewhere";await handleButtonInteraction(i);
  expect(getSession("root")?.session_id).toBe("old");
 });
 it("does not switch an active session",async()=>{
  vi.mocked(sessionManager.isActive).mockReturnValueOnce(true);
  await handleSelectMenuInteraction(interaction());expect(getSession("root")?.session_id).toBe("old");
 });
});
