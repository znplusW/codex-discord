import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("node:fs",()=>({default:{existsSync:vi.fn(()=>true)}}));
vi.mock("./storage.js",()=>({findStateDbPath:vi.fn(()=>"/state.sqlite"),getStoredThread:vi.fn()}));
vi.mock("./app-server-client.js",()=>({codexAppServer:{readThread:vi.fn()}}));
import fs from "node:fs";
import {findStateDbPath,getStoredThread} from "./storage.js";
import {codexAppServer} from "./app-server-client.js";
import {inspectConversationState} from "./conversation-state.js";
describe("authoritative chat state",()=>{
 beforeEach(()=>{vi.resetAllMocks();vi.mocked(fs.existsSync).mockReturnValue(true);vi.mocked(findStateDbPath).mockReturnValue("/state.sqlite");});
 it("reads both active and archived records by exact ID, without acquiring a writer",async()=>{
  vi.mocked(getStoredThread).mockReturnValue({id:"id",archived:1,rollout_path:"/rollout"} as any);expect(await inspectConversationState("id")).toBe("archived");
  vi.mocked(getStoredThread).mockReturnValue({id:"id",archived:0,rollout_path:"/rollout"} as any);expect(await inspectConversationState("id")).toBe("active");expect(codexAppServer.readThread).not.toHaveBeenCalled();
 });
 it("requires both healthy database absence and the exact-ID RPC not-found response",async()=>{
  vi.mocked(codexAppServer.readThread).mockRejectedValue(new Error("thread not loaded: id"));expect(await inspectConversationState("id")).toBe("missing");
  vi.mocked(codexAppServer.readThread).mockRejectedValue(new Error("timeout"));await expect(inspectConversationState("id")).rejects.toThrow("timeout");
 });
 it("never equates unavailable storage, missing rollout, or a successful conflicting RPC with deletion",async()=>{
  vi.mocked(findStateDbPath).mockReturnValue(null);await expect(inspectConversationState("id")).rejects.toThrow("暂不可读");
  vi.mocked(findStateDbPath).mockReturnValue("/state.sqlite");vi.mocked(getStoredThread).mockReturnValue({id:"id",archived:0,rollout_path:""} as any);await expect(inspectConversationState("id")).rejects.toThrow("尚未一致");
  vi.mocked(getStoredThread).mockReturnValue(undefined);vi.mocked(codexAppServer.readThread).mockResolvedValue({id:"id"} as any);await expect(inspectConversationState("id")).rejects.toThrow("尚未一致");
 });
});
