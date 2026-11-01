import {describe,expect,it,vi} from "vitest";
import {CodexAppServerClient} from "./app-server-client.js";
describe("new named chat initialization",()=>{
 it("records creation once and waits for its completion before release",async()=>{
  const client=new CodexAppServerClient();vi.spyOn(client,"readThread").mockResolvedValue({id:"id",turns:[]} as any);
  const start=vi.spyOn(client,"startTurn").mockImplementation(async()=>{client.emit("notification",{method:"turn/completed",params:{threadId:"id",turn:{status:"completed"}}});return {id:"turn"};});
  await client.initializeNamedThread("id","助理");expect(start).toHaveBeenCalledWith("id",expect.stringContaining("不要调用工具"));expect(client.listenerCount("notification")).toBe(0);
 });
 it("does not replay creation after a retry if the first user record already exists",async()=>{
  const client=new CodexAppServerClient();vi.spyOn(client,"readThread").mockResolvedValue({id:"id",turns:[{items:[{type:"userMessage"}]}]} as any);
  const start=vi.spyOn(client,"startTurn");await client.initializeNamedThread("id","助理");expect(start).not.toHaveBeenCalled();
 });
 it("reports a failed initial confirmation without retaining event listeners",async()=>{
  const client=new CodexAppServerClient();vi.spyOn(client,"readThread").mockResolvedValue({id:"id",turns:[]} as any);
  vi.spyOn(client,"startTurn").mockImplementation(async()=>{client.emit("notification",{method:"turn/completed",params:{threadId:"id",turn:{status:"failed",error:{message:"network failure"}}}});return {id:"turn"};});
  await expect(client.initializeNamedThread("id","助理")).rejects.toThrow("network failure");expect(client.listenerCount("notification")).toBe(0);
 });
});
