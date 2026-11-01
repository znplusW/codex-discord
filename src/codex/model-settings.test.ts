import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("./app-server-client.js",()=>({codexAppServer:{listModels:vi.fn(),readThread:vi.fn(),readModelDefaults:vi.fn(),setThreadModelSettings:vi.fn()}}));
vi.mock("./session-manager.js",()=>({sessionManager:{isActive:vi.fn(),isThreadActive:vi.fn()}}));
import {codexAppServer} from "./app-server-client.js";
import {sessionManager} from "./session-manager.js";
import {getDb,getChannelModelPreferences,initDatabase,registerProject,registerThreadProject,selectSession,setChannelModelPreferences,setChatMode,setConversationState} from "../db/database.js";
import {applyModelSelection,getModelSelectionContext} from "./model-settings.js";
const preferences={model:"model-a",reasoningEffort:"high"};
const catalog=[{id:"a",model:"model-a",displayName:"A",defaultReasoningEffort:"low",supportedReasoningEfforts:[{reasoningEffort:"low",description:""},{reasoningEffort:"high",description:""}]}];
describe("model selection scopes and validation",()=>{
 beforeEach(()=>{vi.resetAllMocks();initDatabase(":memory:");registerProject("root","/project","guild");vi.mocked(codexAppServer.listModels).mockResolvedValue(catalog);vi.mocked(codexAppServer.readModelDefaults).mockResolvedValue({model:"model-a",reasoningEffort:"low"});vi.mocked(codexAppServer.readThread).mockResolvedValue({id:"existing",model:"model-a",reasoningEffort:"low"} as any);});
 afterEach(()=>getDb().close());
 it("sets new-conversation defaults without changing the old root session in thread mode",async()=>{
  selectSession("root","old-root-session");const ctx=await getModelSelectionContext("root");
  expect(ctx.scopeKey).toBe("channel:root");await applyModelSelection("root",ctx.scopeKey,preferences);
  expect(getChannelModelPreferences("root")).toEqual(preferences);expect(codexAppServer.setThreadModelSettings).not.toHaveBeenCalled();
 });
 it("snapshots parent defaults for new children and preserves existing children",()=>{
  setChannelModelPreferences("root",preferences);registerThreadProject("first","root");
  setChannelModelPreferences("root",{...preferences,reasoningEffort:"low"});registerThreadProject("first","root");registerThreadProject("second","root");
  expect(getChannelModelPreferences("first")).toEqual(preferences);expect(getChannelModelPreferences("second")?.reasoningEffort).toBe("low");
 });
 it.each(["channel","child"])("updates only the current Codex session for %s scope",async(mode)=>{
  let id="root";if(mode==="channel")setChatMode("root","channel");else{registerThreadProject("child","root");id="child";}
  selectSession(id,"existing");const ctx=await getModelSelectionContext(id);expect(ctx.current.reasoningEffort).toBe("low");
  await applyModelSelection(id,ctx.scopeKey,preferences);expect(codexAppServer.setThreadModelSettings).toHaveBeenCalledWith("existing",preferences);expect(getChannelModelPreferences(id)).toBeUndefined();
 });
 it("rejects stale sessions, a running session, and a model changed behind /reasoning",async()=>{
  setChatMode("root","channel");selectSession("root","existing");
  await expect(applyModelSelection("root","thread:previous",preferences)).rejects.toThrow("失效");
  vi.mocked(sessionManager.isThreadActive).mockReturnValue(true);await expect(applyModelSelection("root","thread:existing",preferences)).rejects.toThrow("正在执行");
  vi.mocked(sessionManager.isThreadActive).mockReturnValue(false);await expect(applyModelSelection("root","thread:existing",preferences,"changed-model")).rejects.toThrow("模型已经改变");
  expect(codexAppServer.setThreadModelSettings).not.toHaveBeenCalled();
 });
 it("revalidates supported model and effort at save time",async()=>{
  await expect(applyModelSelection("root","channel:root",{...preferences,reasoningEffort:"ultra"})).rejects.toThrow("不支持");
  await expect(applyModelSelection("root","channel:root",{...preferences,model:"removed-model"})).rejects.toThrow("可选目录");
  expect(getChannelModelPreferences("root")).toBeUndefined();
 });
 it("reuses a warmed catalog for suggestions but fetches current capabilities before saving",async()=>{
  const ctx=await getModelSelectionContext("root",catalog);
  expect(codexAppServer.listModels).not.toHaveBeenCalled();
  expect(codexAppServer.readModelDefaults).toHaveBeenCalledWith("/project",catalog);
  vi.mocked(codexAppServer.listModels).mockResolvedValue([]);
  await expect(applyModelSelection("root",ctx.scopeKey,preferences)).rejects.toThrow("可选目录");
  expect(codexAppServer.listModels).toHaveBeenCalledOnce();
  expect(getChannelModelPreferences("root")).toBeUndefined();
 });
 it("rejects a task started by another binding while model metadata is loading",async()=>{
  setChatMode("root","channel");selectSession("root","existing");
  let finishRead!: (thread: Awaited<ReturnType<typeof codexAppServer.readThread>>) => void;
  const readStarted = new Promise<void>(resolve => {
   vi.mocked(codexAppServer.readThread).mockImplementationOnce(() => {
    resolve();
    return new Promise(done => { finishRead = done; });
   });
  });
  const save = applyModelSelection("root","thread:existing",preferences);
  await readStarted;
  vi.mocked(sessionManager.isThreadActive).mockReturnValue(true);
  finishRead({id:"existing",model:"model-a",reasoningEffort:"low"} as any);
  await expect(save).rejects.toThrow("正在执行");
  expect(codexAppServer.setThreadModelSettings).not.toHaveBeenCalled();
  expect(getChannelModelPreferences("root")).toBeUndefined();
 });
 it("does not adjust an archived child",async()=>{
  registerThreadProject("child","root");selectSession("child","existing");setConversationState("child","archived");
  await expect(getModelSelectionContext("child")).rejects.toThrow("已归档");
 });
 it("accepts null effort only for models with no effort selector",async()=>{
  vi.mocked(codexAppServer.listModels).mockResolvedValue([{...catalog[0],supportedReasoningEfforts:[],defaultReasoningEffort:null}]);
  await applyModelSelection("root","channel:root",{...preferences,reasoningEffort:null});expect(getChannelModelPreferences("root")?.reasoningEffort).toBeNull();
 });
});
