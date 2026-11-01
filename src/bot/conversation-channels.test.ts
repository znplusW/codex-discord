import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";
vi.mock("../utils/config.js", () => ({getConfig:()=>({BASE_PROJECT_DIR:"/default",ALLOWED_USER_IDS:["owner"]})}));
vi.mock("../codex/app-server-client.js",()=>({codexAppServer:{startThread:vi.fn(),setThreadName:vi.fn(),releaseThread:vi.fn(),initializeNamedThread:vi.fn()}}));
vi.mock("../codex/storage.js",()=>({getStoredThread:vi.fn()}));
vi.mock("../codex/thread-lifecycle.js",()=>({notifyDesktopLifecycle:vi.fn()}));
vi.mock("./conversation-history.js",()=>({syncConversationHistory:vi.fn()}));
import { codexAppServer } from "../codex/app-server-client.js";
import { getStoredThread } from "../codex/storage.js";
import { syncConversationHistory } from "./conversation-history.js";
import { getDb,getProject,getSession,initDatabase,registerProject,selectSession } from "../db/database.js";
import { getHub,getManagedConversation,listManagedConversations,setManagedState,detachManagedChannel } from "../db/channel-conversations.js";
import { categoryFor,createNamedConversation,initializeConversationHub,openConversationChannel,channelName } from "./conversation-channels.js";
function surfaces(){
 const all=new Collection<string,any>();let id=0;
 const guild:any={id:"guild",client:{user:{id:"bot"}},channels:{}};
 guild.channels.fetch=vi.fn(async(key?:string)=>key?all.get(key)??null:all);
 guild.channels.create=vi.fn(async(opts:any)=>{
  const channel:any={id:`c-${++id}`,guild,guildId:"guild",type:opts.type,name:opts.name,topic:opts.topic,parentId:opts.parent};
  if(opts.type===ChannelType.GuildCategory)channel.children={get cache(){return all.filter(c=>c.parentId===channel.id);}};
  all.set(channel.id,channel);return channel;
 });
 const client:any={guilds:{fetch:vi.fn(async()=>guild)}};
 return {guild,client,all};
}
describe("CodeX fixed conversation channels",()=>{
 beforeEach(()=>{vi.resetAllMocks();initDatabase(":memory:");registerProject("old","/original","guild");
  let id=0;vi.mocked(codexAppServer.startThread).mockImplementation(async()=>({id:`thread-${++id}`} as any));
  vi.mocked(getStoredThread).mockImplementation(id=>({id,cwd:"/desktop-project",title:"桌面原会话",archived:0} as any));
  vi.mocked(syncConversationHistory).mockResolvedValue({rounds:20,synced:40,exhausted:false});
 });
 afterEach(()=>getDb().close());
 it("creates one assistant and private category on first run, and reuses IDs on restart",async()=>{
  const {client,guild}=surfaces();await initializeConversationHub(client,"guild");await initializeConversationHub(client,"guild");
  expect(codexAppServer.startThread).toHaveBeenCalledTimes(1);expect(codexAppServer.setThreadName).toHaveBeenCalledWith("thread-1","助理");
  expect(codexAppServer.releaseThread).toHaveBeenCalledWith("thread-1");expect(guild.channels.create).toHaveBeenCalledTimes(2);
  const row=listManagedConversations("guild")[0];expect(getSession(row.channel_id!)?.session_id).toBe("thread-1");
  expect(getProject(row.channel_id!)?.fixed_session).toBe(1);expect(getHub("guild")?.initialized).toBe(1);
  const permissions=guild.channels.create.mock.calls[0][0].permissionOverwrites;
  expect(permissions).toContainEqual({id:"guild",deny:[PermissionFlagsBits.ViewChannel]});
  expect(permissions.some((p:any)=>p.id==="owner")).toBe(true);
 });
 it("does not recreate an assistant that the user later deleted",async()=>{
  const {client,all}=surfaces();await initializeConversationHub(client,"guild");
  const row=listManagedConversations("guild")[0];setManagedState("guild",row.session_id,"deleted");all.delete(row.channel_id!);detachManagedChannel(row.channel_id!);
  await initializeConversationHub(client,"guild");expect(codexAppServer.startThread).toHaveBeenCalledTimes(1);
 });
 it("creates named conversations without registering a source channel and prevents duplicate event delivery",async()=>{
  const {client,guild}=surfaces();await initializeConversationHub(client,"guild");
  const channel=await createNamedConversation(guild,"网站开发","request");
  const again=await createNamedConversation(guild,"网站开发","request");expect(again.id).toBe(channel.id);
  expect(codexAppServer.startThread).toHaveBeenCalledTimes(2);expect(getSession(channel.id)?.session_id).toBe("thread-2");
  expect(()=>selectSession(channel.id,"another")).toThrow("固定绑定");
  await expect(createNamedConversation(guild," ")).rejects.toThrow("1–100");
 });
 it("keeps the created ID across a Discord failure, allowing retry without a second Codex chat",async()=>{
  const {client,guild}=surfaces();await initializeConversationHub(client,"guild");
  guild.channels.create.mockRejectedValueOnce(new Error("Missing Permissions"));
  await expect(createNamedConversation(guild,"失败重试","same-request")).rejects.toThrow("Permissions");
  const saved=getManagedConversation("guild","thread-2");expect(saved?.channel_id).toBeNull();
  const channel=await createNamedConversation(guild,"失败重试","same-request");expect(getSession(channel.id)?.session_id).toBe("thread-2");
  expect(codexAppServer.startThread).toHaveBeenCalledTimes(2);
 });
 it("imports the original desktop ID and cwd once, with no second channel or duplicate transcript",async()=>{
  const {client,guild}=surfaces();await initializeConversationHub(client,"guild");
  const imported=await openConversationChannel(guild,"desktop");const again=await openConversationChannel(guild,"desktop");
  expect(imported.reused).toBe(false);expect(again.reused).toBe(true);expect(again.channel.id).toBe(imported.channel.id);
  expect(getProject(imported.channel.id)?.project_path).toBe("/desktop-project");expect(getSession(imported.channel.id)?.session_id).toBe("desktop");
  expect(syncConversationHistory).toHaveBeenCalledTimes(2);
 });
 it("retries an unfinished initial history sync when reopening the same channel",async()=>{
  const {client,guild}=surfaces();await initializeConversationHub(client,"guild");
  vi.mocked(syncConversationHistory).mockResolvedValueOnce({rounds:20,synced:1,exhausted:false,warning:"retry"});
  const first=await openConversationChannel(guild,"desktop");expect(first.warning).toBe("retry");
  expect((await openConversationChannel(guild,"desktop")).channel.id).toBe(first.channel.id);
  expect(syncConversationHistory).toHaveBeenCalledTimes(3);
 });
 it("uses a second category at 50 channels and gives distinct same-name chats a short suffix",async()=>{
  const {client,guild,all}=surfaces();await initializeConversationHub(client,"guild");
  const category=[...all.values()].find(c=>c.type===ChannelType.GuildCategory);
  for(let i=0;i<49;i++)all.set(`fill-${i}`,{parentId:category.id});
  expect((await categoryFor(guild,"active")).name).toBe("CodeX-2");
  await createNamedConversation(guild,"网站开发");const second=await createNamedConversation(guild,"网站开发");
  expect(second.name).toContain("网站开发-");
 });
 it("normalizes display names while preserving identity in the binding",()=>{
  expect(channelName("  网站 开发 / 测试 ")).toBe("网站-开发--测试");
  expect(channelName("/ / ")).toBe("-");
 });
});
