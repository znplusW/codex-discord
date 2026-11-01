import { Collection, ChannelType } from "discord.js";
import { execute as archiveExecute } from "./multi-archive.js";
import { listManagedConversations, setManagedState } from "../../db/channel-conversations.js";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("../../security/guard.js",()=>({isAllowedUser:vi.fn(()=>true)}));
vi.mock("./managed-lifecycle.js",()=>({executeManagedLifecycle:vi.fn()}));
import { executeManagedLifecycle } from "./managed-lifecycle.js";
import { isAllowedUser } from "../../security/guard.js";
import { bindManagedChannel,saveManagedConversation } from "../../db/channel-conversations.js";
import { getDb,initDatabase } from "../../db/database.js";
import { execute } from "./multi-delete.js";
import { handleBatchInteraction } from "./batch-lifecycle.js";
function interaction(customId?:string,values?:string[]){
 const channels=()=>new Collection(listManagedConversations("guild").filter(r=>r.channel_id).map(r=>[r.channel_id!,{type:ChannelType.GuildText,name:r.title}]));
 const guild={channels:{fetch:vi.fn(async()=>channels())}};
 return {id:"interaction",guildId:"guild",channelId:"source",user:{id:"owner"},client:{guilds:{fetch:vi.fn(async()=>guild)}},customId,values,
  editReply:vi.fn().mockResolvedValue(undefined),reply:vi.fn(),deferUpdate:vi.fn()} as any;
}
function seed(count=2){for(let n=0;n<count;n++){saveManagedConversation("guild",`s-${n}`,`会话 ${n}`,"/cwd");bindManagedChannel("guild",`s-${n}`,`c-${n}`);}}
async function open(){const i=interaction();await execute(i);const payload=i.editReply.mock.calls[0][0];const id=payload.components[0].toJSON().components[0].custom_id;return id.split(":")[1];}
const action=async(token:string,name:string,values?:string[])=>{const i=interaction(`batch:${token}:${name}`,values);await handleBatchInteraction(i);return i;};
describe("confirmed batch deletion",()=>{
 beforeEach(()=>{vi.resetAllMocks();vi.mocked(isAllowedUser).mockReturnValue(true);initDatabase(":memory:");seed();});
 afterEach(()=>{getDb().close();vi.useRealTimers();});
 it("requires selection and preview confirmation before deleting either side",async()=>{
  const token=await open();await action(token,"select",["s-0"]);await action(token,"confirm");expect(executeManagedLifecycle).not.toHaveBeenCalled();
  await action(token,"review");await action(token,"confirm");expect(executeManagedLifecycle).toHaveBeenCalledOnce();expect(executeManagedLifecycle).toHaveBeenCalledWith(expect.anything(),"c-0","delete","s-0");
  await action(token,"confirm");expect(executeManagedLifecycle).toHaveBeenCalledOnce();
 });
 it("cancels safely and ignores forged or other-user confirmations",async()=>{
  const token=await open();await action(token,"all");await action(token,"review");
  const other=interaction(`batch:${token}:confirm`);other.user.id="other";await handleBatchInteraction(other);expect(other.reply).toHaveBeenCalled();
  await action(token,"cancel");await action(token,"confirm");expect(executeManagedLifecycle).not.toHaveBeenCalled();
 });
 it("continues other targets after a failure and reports partial results",async()=>{
  const token=await open();await action(token,"all");await action(token,"review");vi.mocked(executeManagedLifecycle).mockRejectedValueOnce(new Error("busy"));
  const result=await action(token,"confirm");expect(executeManagedLifecycle).toHaveBeenCalledTimes(2);expect(result.editReply.mock.calls.at(-1)![0].content).toContain("1/2");
 });
 it("supports more than 25 targets while preserving selections across pages",async()=>{
  seed(28);const token=await open();await action(token,"select",["s-0"]);await action(token,"next");await action(token,"select",["s-27"]);await action(token,"review");
  await action(token,"confirm");expect(executeManagedLifecycle).toHaveBeenCalledTimes(2);
  expect(vi.mocked(executeManagedLifecycle).mock.calls.map(c=>c[3])).toEqual(["s-0","s-27"]);
 });
 it("expires stale confirmation cards and never deletes chats without a managed channel",async()=>{
  const token=await open();await action(token,"all");await action(token,"review");vi.useFakeTimers();vi.setSystemTime(Date.now()+16*60_000);
  const result=await action(token,"confirm");expect(result.reply).toHaveBeenCalled();expect(executeManagedLifecycle).not.toHaveBeenCalled();
 });
 it("archives only selected live channels and excludes archived and desktop-only chats",async()=>{
  setManagedState("guild","s-1","archived");saveManagedConversation("guild","desktop-only","电脑未导入","/cwd");
  const i=interaction();await archiveExecute(i);const token=i.editReply.mock.calls[0][0].components[0].toJSON().components[0].custom_id.split(":")[1];
  const options=i.editReply.mock.calls[0][0].components[0].toJSON().components[0].options;expect(options.map((o:any)=>o.value)).toEqual(["s-0"]);
  await action(token,"all");await action(token,"review");await action(token,"confirm");expect(executeManagedLifecycle).toHaveBeenCalledWith(expect.anything(),"c-0","archive","s-0");
 });
 it("lists only channels confirmed to exist on Discord",async()=>{
  const i=interaction();i.client.guilds.fetch.mockResolvedValue({channels:{fetch:vi.fn(async()=>new Collection([["c-0",{type:ChannelType.GuildText,name:"当前频道名称"}]]))}});
  await execute(i);const options=i.editReply.mock.calls[0][0].components[0].toJSON().components[0].options;
  expect(options).toHaveLength(1);expect(options[0]).toMatchObject({value:"s-0",label:"当前频道名称"});
 });

});
