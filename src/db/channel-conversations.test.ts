import {afterEach,describe,expect,it} from "vitest";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {getDb,getSession,initDatabase,selectSession,upsertSession} from "./database.js";
import {bindManagedChannel,createHub,finishHubInitialization,getHub,getManagedConversation,saveManagedConversation,setHubAssistant,setManagedAction,setManagedSyncResult,detachManagedChannel} from "./channel-conversations.js";
const directories:string[]=[];
afterEach(()=>{try{getDb().close();}catch{}for(const p of directories.splice(0))fs.rmSync(p,{recursive:true,force:true});});
describe("fixed channel durable bindings",()=>{
 it("persists initialization, original IDs and an unfinished lifecycle operation across restart",()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"channel-db-"));directories.push(directory);const db=path.join(directory,"data.db");initDatabase(db);
  createHub("g","/cwd",null);saveManagedConversation("g","original","助理","/cwd");setHubAssistant("g","original");finishHubInitialization("g");bindManagedChannel("g","original","channel");setManagedAction("g","original","archive");setManagedSyncResult("g","original","Discord unavailable");
  getDb().close();initDatabase(db);expect(getHub("g")).toMatchObject({assistant_session_id:"original",initialized:1});expect(getManagedConversation("g","original")).toMatchObject({channel_id:"channel",pending_action:"archive",sync_pending:1});expect(getSession("channel")?.session_id).toBe("original");
 });
 it("rejects rebinding and makes manually deleted channels eligible for later explicit reimport only",()=>{
  initDatabase(":memory:");saveManagedConversation("g","original","助理","/cwd");bindManagedChannel("g","original","channel");
  expect(()=>selectSession("channel",null)).toThrow("固定绑定");expect(()=>upsertSession("other","channel","different","idle")).toThrow("不能更改");
  detachManagedChannel("channel");expect(getManagedConversation("g","original")).toMatchObject({channel_id:null,sync_pending:0,needs_history:1});
 });
 it("clears a previous pending-delete intent when the user explicitly chooses restore instead",()=>{
  initDatabase(":memory:");saveManagedConversation("g","original","助理","/cwd");
  setManagedAction("g","original","delete",true);setManagedAction("g","original",null);
  expect(getManagedConversation("g","original")?.delete_channel_requested).toBe(1);
  setManagedAction("g","original","restore");expect(getManagedConversation("g","original")?.delete_channel_requested).toBe(0);
 });
});
