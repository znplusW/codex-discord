import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient, type CodexModel } from "./app-server-client.js";
const model = (name: string, isDefault = false): CodexModel => ({
  id: name, model: name, displayName: name, isDefault,
  defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
});
afterEach(() => vi.restoreAllMocks());
describe("Codex model settings RPC", () => {
  it("collects every model page, excludes hidden models and deduplicates repeated entries", async () => {
    const client = new CodexAppServerClient();
    const rpc = vi.spyOn(client, "request").mockResolvedValueOnce({ data: [model("a"), { ...model("hidden"), hidden: true }], nextCursor: "next" })
      .mockResolvedValueOnce({ data: [model("a"), model("b")], nextCursor: null });
    expect((await client.listModels()).map(m => m.model)).toEqual(["a", "b"]);
    expect(rpc).toHaveBeenNthCalledWith(2, "model/list", { limit: 100, includeHidden: false, cursor: "next" });
  });
  it("rejects a repeated cursor instead of looping indefinitely", async () => {
    const client = new CodexAppServerClient();
    vi.spyOn(client, "request").mockResolvedValue({ data: [model("a")], nextCursor: "same" });
    await expect(client.listModels()).rejects.toThrow("分页异常");
  });
  it("uses effective project config rather than the catalog recommendation", async () => {
    const client = new CodexAppServerClient();
    const rpc = vi.spyOn(client, "request").mockResolvedValueOnce({ config: { model: "configured", model_reasoning_effort: "high" } });
    vi.spyOn(client, "listModels").mockResolvedValue([model("recommended", true), model("configured")]);
    expect(await client.readModelDefaults("/project")).toEqual({ model: "configured", reasoningEffort: "high" });
    expect(rpc).toHaveBeenCalledWith("config/read", { includeLayers: false, cwd: "/project" });
  });
  it("uses the returned catalog default only when config omits a model", async () => {
    const client = new CodexAppServerClient();
    vi.spyOn(client, "request").mockResolvedValue({ config: {} });
    vi.spyOn(client, "listModels").mockResolvedValue([model("first"), model("recommended", true)]);
    expect(await client.readModelDefaults()).toEqual({ model: "recommended", reasoningEffort: "medium" });
  });
  it("reads current project config without fetching the catalog again for autocomplete", async () => {
    const client = new CodexAppServerClient();
    const rpc = vi.spyOn(client, "request").mockResolvedValue({ config: { model: "configured" } });
    const listing = vi.spyOn(client, "listModels");
    expect(await client.readModelDefaults("/project", [model("configured")])).toEqual({ model: "configured", reasoningEffort: "medium" });
    expect(rpc).toHaveBeenCalledOnce();
    expect(listing).not.toHaveBeenCalled();
  });
  it("does not invent a default when neither config nor catalog supplies one", async () => {
    const client = new CodexAppServerClient();
    vi.spyOn(client, "request").mockResolvedValue({ config: {} });
    vi.spyOn(client, "listModels").mockResolvedValue([]);
    await expect(client.readModelDefaults()).rejects.toThrow("没有返回默认模型");
  });
  it("starts new conversations with selected defaults and existing sandbox/approval policy", async () => {
    const client = new CodexAppServerClient();
    const rpc = vi.spyOn(client, "request").mockResolvedValue({ thread: { id: "new" } });
    await client.startThread("/project", { model: "chosen", reasoningEffort: "high" });
    expect(rpc).toHaveBeenCalledWith("thread/start", { cwd: "/project", approvalPolicy: "on-request", sandbox: "workspace-write", model: "chosen", config: { model_reasoning_effort: "high" } });
  });
  it("leaves Codex defaults untouched when no preference was chosen", async () => {
    const client = new CodexAppServerClient();
    const rpc = vi.spyOn(client, "request").mockResolvedValue({ thread: { id: "new" } });
    await client.startThread("/project");
    const params = rpc.mock.calls[0][1];
    expect(params).not.toHaveProperty("model");expect(params).not.toHaveProperty("config");expect(params).not.toHaveProperty("modelProvider");
  });
  it("loads a persisted thread only when required and verifies the resulting model and effort", async () => {
    const client = new CodexAppServerClient();
    const rpc = vi.spyOn(client, "request").mockRejectedValueOnce(new Error("thread not found: saved"))
      .mockResolvedValueOnce({ thread: { id: "saved" } }).mockResolvedValueOnce({})
      .mockResolvedValueOnce({ thread: { id: "saved", model: "chosen", reasoningEffort: "high" } });
    await client.setThreadModelSettings("saved", { model: "chosen", reasoningEffort: "high" });
    expect(rpc.mock.calls.map(call => call[0])).toEqual(["thread/settings/update", "thread/resume", "thread/settings/update", "thread/read"]);
    expect(rpc).toHaveBeenNthCalledWith(2, "thread/resume", { threadId: "saved" });
  });
  it("does not retry unrelated errors or falsely report a rejected setting", async () => {
    const client = new CodexAppServerClient();
    const rpc = vi.spyOn(client, "request").mockRejectedValue(new Error("unsupported model"));
    await expect(client.setThreadModelSettings("saved", { model: "chosen", reasoningEffort: "high" })).rejects.toThrow("unsupported model");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("fails verification if Codex accepts the request but keeps different settings", async () => {
    const client = new CodexAppServerClient();
    vi.spyOn(client, "request").mockResolvedValueOnce({}).mockResolvedValueOnce({ thread: { id: "saved", model: "chosen", reasoningEffort: "low" } });
    await expect(client.setThreadModelSettings("saved", { model: "chosen", reasoningEffort: "high" })).rejects.toThrow("未确认");
  });
});
