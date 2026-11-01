import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../db/database.js",()=>({getProject:vi.fn()}));
vi.mock("../../codex/session-manager.js",()=>({sessionManager:{exitSession:vi.fn()}}));
import { getProject } from "../../db/database.js";
import { sessionManager } from "../../codex/session-manager.js";
import { execute } from "./exit.js";
const interaction=()=>({channelId:"child",editReply:vi.fn()}) as any;
describe("/exit command",()=>{
  beforeEach(()=>{vi.resetAllMocks();vi.mocked(getProject).mockReturnValue({parent_channel_id:"root",chat_mode:"threads"} as any);});
  it("releases the selected conversation and reports cancelled queue entries",async()=>{
    vi.mocked(sessionManager.exitSession).mockResolvedValue({threadId:"original",cancelled:2});
    const i=interaction();await execute(i);
    expect(sessionManager.exitSession).toHaveBeenCalledWith("child");
    expect(i.editReply.mock.calls[0][0].content).toContain("运行连接已关闭");
    expect(i.editReply.mock.calls[0][0].content).toContain("2 条");
  });
  it("does not guess a conversation at the thread-mode root",async()=>{
    vi.mocked(getProject).mockReturnValue({parent_channel_id:null,chat_mode:"threads"} as any);
    const i=interaction();await execute(i);expect(sessionManager.exitSession).not.toHaveBeenCalled();
    expect(i.editReply.mock.calls[0][0].content).toContain("会话子区");
  });
  it("does not report success when the writer could not be closed",async()=>{
    vi.mocked(sessionManager.exitSession).mockRejectedValue(new Error("close timeout"));
    const i=interaction();await execute(i);expect(i.editReply.mock.calls[0][0].content).toContain("尚未完成");
    expect(i.editReply.mock.calls[0][0].content).not.toContain("可以回电脑");
  });
});
