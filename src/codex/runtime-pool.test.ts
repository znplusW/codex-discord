import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerPool } from "./app-server-client.js";

function fixture() {
  const clients: any[] = [];
  const pool = new CodexAppServerPool(() => {
    const client = new EventEmitter() as any;
    client.startThread = vi.fn(async () => ({ id: `thread-${clients.length}` }));
    client.resumeThread = vi.fn(async (id: string) => ({ id }));
    client.startTurn = vi.fn(async () => ({ id: "turn" }));
    client.interruptTurn = vi.fn(async () => {});
    client.unarchiveThread = vi.fn(async () => {});
    client.archiveThread = vi.fn(async () => {});
    client.deleteThread = vi.fn(async () => {});
    client.respond = vi.fn(async () => {});
    client.close = vi.fn(async () => { client.emit("exit"); });
    clients.push(client); return client;
  });
  return { pool, clients };
}

describe("isolated Codex writer runtimes", () => {
  it.each(["archiveThread", "deleteThread"] as const)("routes %s through its own writer and closes only that runtime after success", async method => {
    const { pool, clients } = fixture();
    const selected = await pool.startThread("/selected");await pool.startThread("/unrelated");
    await pool[method](selected.id);
    expect(clients[0][method]).toHaveBeenCalledWith(selected.id);
    expect(clients[0].close).toHaveBeenCalledOnce();expect(clients[1].close).not.toHaveBeenCalled();
    expect(clients[0][method].mock.invocationCallOrder[0]).toBeLessThan(clients[0].close.mock.invocationCallOrder[0]);
    await pool.close();
  });
  it("closes exactly the exited conversation and reconnects it later with the same ID",async()=>{
    const {pool,clients}=fixture();
    const a=await pool.startThread("/a"), b=await pool.startThread("/b");
    await pool.releaseThread(a.id);
    expect(clients[0].close).toHaveBeenCalledOnce();expect(clients[1].close).not.toHaveBeenCalled();
    await pool.startTurn(b.id,"continue b");expect(clients[1].startTurn).toHaveBeenCalledWith(b.id,"continue b");
    expect(await pool.resumeThread(a.id)).toMatchObject({id:a.id});
    expect(clients[2].resumeThread).toHaveBeenCalledWith(a.id);
    await pool.close();
  });

  it("remaps overlapping approval IDs to their own clients",async()=>{
    const {pool,clients}=fixture();await pool.startThread("/a");await pool.startThread("/b");
    const requests:any[]=[];pool.on("serverRequest",m=>requests.push(m));
    clients[0].emit("serverRequest",{id:5,method:"approval",params:{threadId:"thread-1"}});
    clients[1].emit("serverRequest",{id:5,method:"approval",params:{threadId:"thread-2"}});
    expect(requests[0].id).not.toBe(requests[1].id);
    await pool.respond(requests[1].id,{decision:"decline"});await pool.respond(requests[0].id,{decision:"accept"});
    expect(clients[0].respond).toHaveBeenCalledWith(5,{decision:"accept"});
    expect(clients[1].respond).toHaveBeenCalledWith(5,{decision:"decline"});
    await pool.close();
  });

  it("retains ownership after a failed close so /exit can retry instead of losing the writer",async()=>{
    const {pool,clients}=fixture();const a=await pool.startThread("/a");
    clients[0].close.mockRejectedValueOnce(new Error("close failed"));
    await expect(pool.releaseThread(a.id)).rejects.toThrow("close failed");
    await pool.releaseThread(a.id);expect(clients[0].close).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("restoring a conversation also releases its writer instead of keeping a hidden metadata lease",async()=>{
    const {pool,clients}=fixture();await pool.unarchiveThread("restored");
    expect(clients[0].unarchiveThread).toHaveBeenCalledWith("restored");
    expect(clients[0].close).toHaveBeenCalledOnce();await pool.close();
  });

  it("waits for closing to finish before creating the next writer for that ID",async()=>{
    const {pool,clients}=fixture();const a=await pool.startThread("/a");
    let finish!:()=>void;
    clients[0].close.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=()=>{clients[0].emit("exit");resolve();};}));
    const closing=pool.releaseThread(a.id), resuming=pool.resumeThread(a.id);
    await Promise.resolve();expect(clients).toHaveLength(1);
    finish();await Promise.all([closing,resuming]);expect(clients).toHaveLength(2);
    await pool.close();
  });
});
