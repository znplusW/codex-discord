import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { ChannelType } from "discord.js";
vi.mock("../codex/conversation-state.js",()=>({inspectConversationState:vi.fn()}));
vi.mock("../codex/thread-lifecycle.js",()=>({changeThreadLifecycle:vi.fn()}));
vi.mock("../codex/session-manager.js",()=>({sessionManager:{exitSession:vi.fn(),isThreadActive:vi.fn(),hasQueue:vi.fn(),getQueueSize:vi.fn()}}));
vi.mock("./conversation-channels.js",()=>({categoryFor:vi.fn(async(_g,state)=>({id:`category-${state}`}))}));
vi.mock("../security/guard.js",()=>({isAllowedUser:()=>true}));
import { inspectConversationState } from "../codex/conversation-state.js";
import { changeThreadLifecycle } from "../codex/thread-lifecycle.js";
import { sessionManager } from "../codex/session-manager.js";
import { getDb,getProject,getSession,initDatabase } from "../db/database.js";
import { bindManagedChannel,saveManagedConversation,getManagedChannel,getManagedConversation,setManagedState,setManagedAction } from "../db/channel-conversations.js";
import { assertManagedConversationActive,reconcileManagedConversation } from "./managed-sync.js";
import { executeManagedLifecycle } from "./commands/managed-lifecycle.js";
import { categoryFor } from "./conversation-channels.js";
function surface(){
 const channel:any={id:"channel",guildId:"guild",type:ChannelType.GuildText,guild:{id:"guild"},parentId:"category-active",topic:"codex-discord:original"};
 channel.setParent=vi.fn(async(id)=>{channel.parentId=id;});channel.setTopic=vi.fn(async(topic)=>{channel.topic=topic;});channel.delete=vi.fn();
 const client:any={channels:{fetch:vi.fn(async()=>channel)}};
 return {channel,client};
}
describe("desktop lifecycle reconciliation",()=>{
 beforeEach(()=>{vi.resetAllMocks();initDatabase(":memory:");saveManagedConversation("guild","original","会话","/cwd");bindManagedChannel("guild","original","channel");
  vi.mocked(inspectConversationState).mockResolvedValue("active");
  vi.mocked(categoryFor).mockImplementation(async(_g,state)=>({id:`category-${state}`} as any));
 });
 afterEach(()=>getDb().close());
 const row=()=>getManagedConversation("guild","original")!;
 it("archives desktop first, verifies, then moves the same channel and preserves its binding",async()=>{
  const {channel,client}=surface();const calls:string[]=[];
  vi.mocked(changeThreadLifecycle).mockImplementation(async()=>{calls.push("core");});channel.setParent.mockImplementation(async(id:string)=>{calls.push("move");channel.parentId=id;});
  await executeManagedLifecycle(client,"channel","archive","original");
  expect(calls).toEqual(["core","move"]);expect(channel.parentId).toBe("category-archived");expect(getProject("channel")?.conversation_state).toBe("archived");expect(getSession("channel")?.session_id).toBe("original");
  expect(channel.setParent).toHaveBeenCalledWith("category-archived",expect.objectContaining({lockPermissions:false}));
 });
 it("restores the same ID before moving the original channel back",async()=>{
  setManagedState("guild","original","archived");const {channel,client}=surface();channel.parentId="category-archived";
  await executeManagedLifecycle(client,"channel","restore","original");
  expect(changeThreadLifecycle).toHaveBeenCalledWith("original","restore");expect(channel.parentId).toBe("category-active");expect(getSession("channel")?.session_id).toBe("original");
 });
 it("does not move when core verification fails and persists the action for retry",async()=>{
  const {channel,client}=surface();vi.mocked(changeThreadLifecycle).mockRejectedValueOnce(new Error("core verification failed"));
  await expect(executeManagedLifecycle(client,"channel","archive","original")).rejects.toThrow("待同步");
  expect(channel.setParent).not.toHaveBeenCalled();expect(row().pending_action).toBe("archive");
  await reconcileManagedConversation(client,row());expect(channel.parentId).toBe("category-archived");expect(row().pending_action).toBeNull();
 });
 it("keeps desktop archive after a Discord failure and retries only the presentation",async()=>{
  const {channel,client}=surface();channel.setParent.mockRejectedValueOnce(new Error("Discord offline"));
  await expect(executeManagedLifecycle(client,"channel","archive","original")).rejects.toThrow("重试");
  expect(row()).toMatchObject({state:"archived",sync_pending:1,pending_action:null});
  vi.mocked(inspectConversationState).mockResolvedValue("archived");await reconcileManagedConversation(client,row());
  expect(changeThreadLifecycle).toHaveBeenCalledTimes(1);expect(row().sync_pending).toBe(0);expect(channel.parentId).toBe("category-archived");
 });
 it("follows desktop-first archive and restore, releasing an owned runtime",async()=>{
  const {channel,client}=surface();vi.mocked(inspectConversationState).mockResolvedValue("archived");await reconcileManagedConversation(client,row());
  expect(channel.parentId).toBe("category-archived");expect(sessionManager.exitSession).toHaveBeenCalledWith("channel");
  vi.mocked(inspectConversationState).mockResolvedValue("active");await reconcileManagedConversation(client,row());expect(channel.parentId).toBe("category-active");
  expect(changeThreadLifecycle).not.toHaveBeenCalled();
 });
 it("requires repeated confirmed absence before keeping a deleted desktop chat as a history channel",async()=>{
  const {channel,client}=surface();vi.mocked(inspectConversationState).mockResolvedValue("missing");
  await reconcileManagedConversation(client,row());expect(row().state).toBe("active");expect(channel.setParent).not.toHaveBeenCalled();
  await reconcileManagedConversation(client,row());expect(row().state).toBe("deleted");expect(channel.parentId).toBe("category-deleted");expect(channel.delete).not.toHaveBeenCalled();
 });
 it("does not infer deletion from a read error, and breaks the consecutive-missing sequence",async()=>{
  const {channel,client}=surface();vi.mocked(inspectConversationState).mockResolvedValueOnce("missing").mockRejectedValueOnce(new Error("database locked")).mockResolvedValueOnce("missing");
  await reconcileManagedConversation(client,row());await reconcileManagedConversation(client,row());await reconcileManagedConversation(client,row());
  expect(row().state).toBe("active");expect(channel.delete).not.toHaveBeenCalled();expect(channel.setParent).not.toHaveBeenCalled();
 });
 it("prevents submission after desktop archive, deletion, or unavailable state, without creating a replacement",async()=>{
  vi.mocked(inspectConversationState).mockResolvedValue("archived");await expect(assertManagedConversationActive("channel")).rejects.toThrow("/restore");
  expect(getSession("channel")?.session_id).toBe("original");
  vi.mocked(inspectConversationState).mockRejectedValue(new Error("unavailable"));await expect(assertManagedConversationActive("channel")).rejects.toThrow("unavailable");
 });
 it("deletes the channel only after verified explicit deletion and never resumes deleted chats",async()=>{
  const {channel,client}=surface();await executeManagedLifecycle(client,"channel","delete","original");
  expect(changeThreadLifecycle).toHaveBeenCalledWith("original","delete");expect(channel.delete).toHaveBeenCalledOnce();expect(getManagedChannel("channel")).toBeUndefined();
  expect(row().state).toBe("deleted");expect(row().channel_id).toBeNull();expect(getProject("channel")).toBeUndefined();
 });
 it("blocks stale bindings and busy conversations before modifying either side",async()=>{
  const {channel,client}=surface();await expect(executeManagedLifecycle(client,"channel","delete","wrong")).rejects.toThrow("对应关系");
  vi.mocked(sessionManager.isThreadActive).mockReturnValue(true);await expect(executeManagedLifecycle(client,"channel","archive","original")).rejects.toThrow("运行");
  expect(changeThreadLifecycle).not.toHaveBeenCalled();expect(channel.setParent).not.toHaveBeenCalled();
 });
 it("never recreates a manually removed Discord channel or deletes its Codex chat",async()=>{
  const {client}=surface();client.channels.fetch.mockResolvedValue(null);await reconcileManagedConversation(client,row());
  expect(row().channel_id).toBeNull();expect(changeThreadLifecycle).not.toHaveBeenCalled();
 });
 it.each(["archive","delete"] as const)("preserves a blocked %s and completes only after the external writer releases",async(action)=>{
  const {channel,client}=surface();
  vi.mocked(changeThreadLifecycle).mockRejectedValueOnce(new Error("thread original already has an active writer"))
   .mockRejectedValueOnce(new Error("thread original already has an active writer"));
  await expect(executeManagedLifecycle(client,"channel",action,"original")).rejects.toThrow("请先退出占用");
  expect(row()).toMatchObject({state:"active",pending_action:action,sync_pending:1});
  expect(row().last_error).toContain("/exit 只能释放机器人");
  await reconcileManagedConversation(client,row());
  expect(channel.setParent).not.toHaveBeenCalled();expect(channel.delete).not.toHaveBeenCalled();
  expect(sessionManager.exitSession).not.toHaveBeenCalled();
  expect(row().pending_action).toBe(action);
  await reconcileManagedConversation(client,row());
  expect(row()).toMatchObject({state:action==="archive"?"archived":"deleted",pending_action:null,sync_pending:0});
  if(action==="archive")expect(channel.parentId).toBe("category-archived");
  else expect(channel.delete).toHaveBeenCalledOnce();
 });
 it("does not execute a pending lifecycle request while its conversation is running or queued",async()=>{
  const {client}=surface();setManagedAction("guild","original","delete",true);
  vi.mocked(sessionManager.isThreadActive).mockReturnValue(true);
  await reconcileManagedConversation(client,row());expect(changeThreadLifecycle).not.toHaveBeenCalled();
  vi.mocked(sessionManager.isThreadActive).mockReturnValue(false);vi.mocked(sessionManager.hasQueue).mockReturnValue(true);
  await reconcileManagedConversation(client,row());expect(changeThreadLifecycle).not.toHaveBeenCalled();
  vi.mocked(sessionManager.hasQueue).mockReturnValue(false);
  await reconcileManagedConversation(client,row());expect(changeThreadLifecycle).toHaveBeenCalledWith("original","delete");
 });
});
