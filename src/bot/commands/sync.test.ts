import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../security/guard.js",()=>({isAllowedUser:vi.fn(()=>true)}));
vi.mock("../conversation-history.js",()=>({syncConversationHistory:vi.fn()}));
import { syncConversationHistory } from "../conversation-history.js";
import { isAllowedUser } from "../../security/guard.js";
import { data, execute } from "./sync.js";
const interaction=(thread=true)=>({user:{id:"owner"},channel:{isThread:()=>thread},editReply:vi.fn()}) as any;
describe("/sync history feedback",()=>{
  beforeEach(()=>{vi.resetAllMocks();vi.mocked(isAllowedUser).mockReturnValue(true);});
  it("registers history as a subcommand and requires a bound conversation",async()=>{
    expect(data.toJSON().options).toMatchObject([{name:"history",type:1}]);
    const i=interaction(false);await execute(i);expect(i.editReply.mock.calls[0][0].content).toContain("会话频道或子区");
    expect(syncConversationHistory).not.toHaveBeenCalled();
  });
  it("reports fewer than 20 remaining rounds and the end of history",async()=>{
    vi.mocked(syncConversationHistory).mockResolvedValue({rounds:7,synced:14,exhausted:true});
    const i=interaction();await execute(i);expect(i.editReply.mock.calls[0][0].content).toContain("7 轮");
    expect(i.editReply.mock.calls[0][0].content).toContain("最早");
  });
  it("reports no older history without claiming 20 rounds were synced",async()=>{
    vi.mocked(syncConversationHistory).mockResolvedValue({rounds:0,synced:0,exhausted:true});
    const i=interaction();await execute(i);expect(i.editReply.mock.calls[0][0].content).toContain("没有更早");
    expect(i.editReply.mock.calls[0][0].content).not.toContain("已加载");
  });
  it("keeps partial failures distinct from success and guards unauthorized users",async()=>{
    vi.mocked(syncConversationHistory).mockResolvedValue({rounds:20,synced:2,exhausted:false,warning:"同步尚未完成，请重试"});
    const i=interaction();await execute(i);expect(i.editReply.mock.calls[0][0].content).toContain("尚未完成");
    vi.mocked(isAllowedUser).mockReturnValue(false);await execute(interaction());
    expect(syncConversationHistory).toHaveBeenCalledOnce();
  });
});
