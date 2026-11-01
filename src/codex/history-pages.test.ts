import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient, type CodexTurn } from "./app-server-client.js";
const turns = Array.from({length:47},(_,i)=>({id:`turn-${i+1}`,status:"completed",items:[]} as CodexTurn));
afterEach(()=>vi.restoreAllMocks());
describe("stored history pages",()=>{
  it("requests 20 newest turns with full items, reverses for display, and passes the older cursor",async()=>{
    const client=new CodexAppServerClient();
    const rpc=vi.spyOn(client,"request").mockResolvedValueOnce({data:turns.slice(27).reverse(),nextCursor:"older"})
      .mockResolvedValueOnce({data:turns.slice(7,27).reverse(),nextCursor:"oldest"})
      .mockResolvedValueOnce({data:turns.slice(0,7).reverse(),nextCursor:null});
    const one=await client.readRecentTurns("session");
    expect(one.turns).toEqual(turns.slice(27));expect(one.nextCursor).toBe("older");
    const two=await client.readRecentTurns("session",20,one.nextCursor);
    const three=await client.readRecentTurns("session",20,two.nextCursor);
    expect(three).toEqual({turns:turns.slice(0,7),hasMore:false,nextCursor:null});
    expect(rpc).toHaveBeenNthCalledWith(2,"thread/turns/list",{threadId:"session",limit:20,sortDirection:"desc",itemsView:"full",cursor:"older"});
  });
  it("falls back for older local versions using stable before-turn anchors",async()=>{
    const client=new CodexAppServerClient();
    vi.spyOn(client,"request").mockRejectedValue(new Error("unknown variant thread/turns/list"));
    const read=vi.spyOn(client,"readThread").mockResolvedValue({turns} as any);
    const one=await client.readRecentTurns("session");
    expect(one.turns).toEqual(turns.slice(27));
    const two=await client.readRecentTurns("session",20,one.nextCursor);
    expect(two.turns).toEqual(turns.slice(7,27));
    const three=await client.readRecentTurns("session",20,two.nextCursor);
    expect(three).toEqual({turns:turns.slice(0,7),hasMore:false,nextCursor:null});
    expect(read).toHaveBeenCalledWith("session",true);
  });
  it("returns no history accurately and does not hide genuine read errors",async()=>{
    const client=new CodexAppServerClient();
    const rpc=vi.spyOn(client,"request").mockResolvedValueOnce({data:[],nextCursor:null}).mockRejectedValueOnce(new Error("permission denied"));
    expect(await client.readRecentTurns("empty")).toEqual({turns:[],hasMore:false,nextCursor:null});
    await expect(client.readRecentTurns("unreadable")).rejects.toThrow("permission denied");
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
