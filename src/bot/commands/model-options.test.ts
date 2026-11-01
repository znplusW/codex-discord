import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../security/guard.js", () => ({ isAllowedUser: vi.fn(() => true) }));
vi.mock("../../codex/app-server-client.js", () => ({ codexAppServer: { listModels: vi.fn() } }));
vi.mock("../../codex/model-settings.js", () => ({ getModelSelectionContext: vi.fn(), applyModelSelection: vi.fn() }));
vi.mock("./model-picker.js", async importOriginal => ({
  ...await importOriginal<typeof import("./model-picker.js")>(), showModelPicker: vi.fn(),
}));
import { isAllowedUser } from "../../security/guard.js";
import { codexAppServer, type CodexModel } from "../../codex/app-server-client.js";
import { getModelSelectionContext, applyModelSelection, type ModelSelectionContext } from "../../codex/model-settings.js";
import { showModelPicker } from "./model-picker.js";

const makeModel = (index: number, efforts = ["low", "high"]): CodexModel => ({
  id: `model-${index}`, model: `model-${index}`, displayName: `模型 ${index}`,
  defaultReasoningEffort: efforts[0] ?? null,
  supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
});
const models = [makeModel(0), makeModel(1, ["medium", "xhigh"]), makeModel(2, [])];
function context(): ModelSelectionContext {
  return { scopeKey: "thread:codex-a", channelId: "channel-a", sessionId: "codex-a", label: "当前 Codex 会话",
    current: { model: "model-0", reasoningEffort: "low" }, models };
}
function interaction(options: Record<string, string | undefined> = {}, focused = "model", value = "") {
  return {
    channelId: "channel-a", user: { id: "owner" },
    options: { getString: (key: string) => options[key] ?? null, getFocused: () => ({ name: focused, value }) },
    respond: vi.fn().mockResolvedValue(undefined), editReply: vi.fn().mockResolvedValue(undefined),
  } as any;
}
function choices(i: any): Array<{ name: string; value: string }> { return i.respond.mock.calls.at(-1)[0].filter((choice: {value:string}) => choice.value !== "__current_settings__"); }
function content(i: any): string { return i.editReply.mock.calls.at(-1)[0].content; }

describe("pre-send model command choices", () => {
  let helpers: typeof import("./model-options.js");
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.mocked(isAllowedUser).mockReturnValue(true);
    vi.mocked(codexAppServer.listModels).mockResolvedValue(models);
    vi.mocked(getModelSelectionContext).mockImplementation(async (_channelId, knownModels) => ({...context(), models: knownModels ?? models}));
    vi.mocked(applyModelSelection).mockResolvedValue(undefined);
    helpers = await import("./model-options.js");
  });
  afterEach(() => { vi.useRealTimers(); });

  it("registers clickable model names and returns choices even when nothing was typed", async () => {
    const registered = await helpers.getModelOptionChoices();
    expect(registered.map(choice => choice.value)).toEqual(["model-0", "model-1", "model-2"]);
    expect(registered[0].name).toContain("模型 0");
    const i = interaction(); await helpers.autocompleteModelOptions(i, "model");
    expect(choices(i)).toEqual(registered);
    expect(codexAppServer.listModels).toHaveBeenCalledTimes(1);
    expect(applyModelSelection).not.toHaveBeenCalled();
  });

  it("shows only the selected model's supported strengths before sending", async () => {
    const i = interaction({ model: "model-1" }, "reasoning");
    await helpers.autocompleteModelOptions(i, "model");
    expect(choices(i).map(choice => choice.value)).toEqual(["medium", "xhigh"]);
    const chinese = interaction({ model: "model-1" }, "reasoning", "更高");
    await helpers.autocompleteModelOptions(chinese, "model");
    expect(choices(chinese).map(choice => choice.value)).toEqual(["xhigh"]);
    expect(applyModelSelection).not.toHaveBeenCalled();
  });

  it("shows the current model and effort first and treats the status row as read-only", async () => {
    const model = interaction(); await helpers.autocompleteModelOptions(model, "model");
    expect(model.respond.mock.calls[0][0][0]).toMatchObject({value:"__current_settings__"});
    expect(model.respond.mock.calls[0][0][0].name).toContain("model-0");
    expect(model.respond.mock.calls[0][0][0].name).toContain("low");
    const reasoning = interaction({}, "reasoning"); await helpers.autocompleteModelOptions(reasoning, "reasoning");
    expect(reasoning.respond.mock.calls[0][0][0].name).toContain("当前");
    const submitted = interaction({model:"model-1",reasoning:"__current_settings__"});
    await helpers.executeModelOptions(submitted,"model");
    expect(showModelPicker).toHaveBeenCalledWith(submitted,"model","model-1");
    expect(applyModelSelection).not.toHaveBeenCalled();
  });

  it("does not guess an effort list before a valid model is chosen", async () => {
    for (const selected of [undefined, "unknown-model"]) {
      const i = interaction(selected ? { model: selected } : {}, "reasoning");
      await helpers.autocompleteModelOptions(i, "model");
      expect(choices(i)).toEqual([]);
    }
  });

  it("/reasoning reads the current session's model and coalesces concurrent lookups", async () => {
    await helpers.warmModelOptions();
    let resolve!: (value: ModelSelectionContext) => void;
    vi.mocked(getModelSelectionContext).mockReturnValue(new Promise(done => { resolve = done; }));
    const first = interaction({}, "reasoning"), second = interaction({}, "reasoning", "high");
    const one = helpers.autocompleteModelOptions(first, "reasoning"), two = helpers.autocompleteModelOptions(second, "reasoning");
    await Promise.resolve();
    expect(getModelSelectionContext).toHaveBeenCalledTimes(1);
    expect(getModelSelectionContext).toHaveBeenCalledWith("channel-a", models);
    resolve(context()); await Promise.all([one, two]);
    expect(choices(first).map(choice => choice.value)).toEqual(["low", "high"]);
    expect(choices(second).map(choice => choice.value)).toEqual(["high"]);
    vi.mocked(getModelSelectionContext).mockResolvedValue({ ...context(), current: { model: "model-1", reasoningEffort: "medium" } });
    const third = interaction({}, "reasoning"); await helpers.autocompleteModelOptions(third, "reasoning");
    expect(choices(third).map(choice => choice.value)).toEqual(["medium", "xhigh"]);
    expect(codexAppServer.listModels).toHaveBeenCalledTimes(1);
  });

  it("supports catalogs over 25 with searchable autocomplete instead of truncating fixed registration", async () => {
    vi.mocked(codexAppServer.listModels).mockResolvedValue(Array.from({ length: 30 }, (_, index) => makeModel(index)));
    expect(await helpers.getModelOptionChoices()).toEqual([]);
    const all = interaction(); await helpers.autocompleteModelOptions(all, "model"); expect(choices(all)).toHaveLength(24);
    const search = interaction({}, "model", "MODEL-29"); await helpers.autocompleteModelOptions(search, "model");
    expect(choices(search).map(choice => choice.value)).toEqual(["model-29"]);
  });

  it("keeps labels within Discord's length limit without splitting surrogate pairs", async () => {
    vi.mocked(codexAppServer.listModels).mockResolvedValue([{ ...models[0], displayName: "😀".repeat(80) }]);
    const [choice] = await helpers.getModelOptionChoices();
    expect(choice.name.length).toBeLessThanOrEqual(100);
    expect(choice.name.endsWith("😀")).toBe(true);
    expect(choice.value).toBe("model-0");
  });

  it("returns a null-effort sentinel only for models with no adjustable strengths", async () => {
    const i = interaction({ model: "model-2" }, "reasoning"); await helpers.autocompleteModelOptions(i, "model");
    expect(choices(i)).toEqual([{ name: "无需设置（模型默认）", value: "model-default" }]);
    const submitted = interaction({ model: "model-2", reasoning: choices(i)[0].value });
    await helpers.executeModelOptions(submitted, "model");
    expect(applyModelSelection).toHaveBeenCalledWith("channel-a", "thread:codex-a", { model: "model-2", reasoningEffort: null }, undefined);
  });

  it("saves selected model and effort together only when the complete command is sent", async () => {
    const i = interaction({ model: "model-1", reasoning: "xhigh" });
    await helpers.executeModelOptions(i, "model");
    expect(applyModelSelection).toHaveBeenCalledOnce();
    expect(applyModelSelection).toHaveBeenCalledWith("channel-a", "thread:codex-a", { model: "model-1", reasoningEffort: "xhigh" }, undefined);
    expect(content(i)).toContain("下一条消息");
    expect(showModelPicker).not.toHaveBeenCalled();
  });

  it("changes only current model's effort with its model guard and explains new-session defaults", async () => {
    vi.mocked(getModelSelectionContext).mockResolvedValue({ ...context(), scopeKey: "channel:channel-a", sessionId: null, label: "本频道以后新建会话的默认设置" });
    const i = interaction({ reasoning: "high" }); await helpers.executeModelOptions(i, "reasoning");
    expect(applyModelSelection).toHaveBeenCalledWith("channel-a", "channel:channel-a", { model: "model-0", reasoningEffort: "high" }, "model-0");
    expect(content(i)).toContain("新建会话");
  });

  it("preserves parameterless menus and selected-model continuation without mutating", async () => {
    const old = interaction(); await helpers.executeModelOptions(old, "model");
    expect(showModelPicker).toHaveBeenCalledWith(old, "model");
    const modelOnly = interaction({model:"model-1"});
    await helpers.executeModelOptions(modelOnly, "model");
    expect(showModelPicker).toHaveBeenCalledWith(modelOnly, "model", "model-1");
    for (const options of [{ reasoning: "high" }]) {
      const partial = interaction(options); await helpers.executeModelOptions(partial, "model");
      expect(content(partial)).toContain("设置尚未修改");
    }
    expect(applyModelSelection).not.toHaveBeenCalled();
    expect(getModelSelectionContext).not.toHaveBeenCalled();
  });

  it("reports save-time validation failures and never claims success", async () => {
    vi.mocked(applyModelSelection).mockRejectedValue(new Error("该模型不支持所选思考强度，请重新选择。"));
    const i = interaction({ model: "model-1", reasoning: "unsupported" }); await helpers.executeModelOptions(i, "model");
    expect(content(i)).toContain("不支持"); expect(content(i)).not.toContain("已保存");
  });

  it("does not misreport a successfully persisted change if Discord's reply fails", async () => {
    const i = interaction({ model: "model-1", reasoning: "medium" }); i.editReply.mockRejectedValue(new Error("network"));
    await expect(helpers.executeModelOptions(i, "model")).rejects.toThrow("network");
    expect(applyModelSelection).toHaveBeenCalledOnce(); expect(i.editReply).toHaveBeenCalledOnce();
  });

  it("does not disclose live options or save settings for unauthorized users", async () => {
    vi.mocked(isAllowedUser).mockReturnValue(false);
    const i = interaction({ model: "model-1", reasoning: "medium" });
    await helpers.autocompleteModelOptions(i, "model"); await helpers.executeModelOptions(i, "model");
    expect(choices(i)).toEqual([]); expect(content(i)).toContain("没有操作");
    expect(codexAppServer.listModels).not.toHaveBeenCalled(); expect(getModelSelectionContext).not.toHaveBeenCalled();
    expect(applyModelSelection).not.toHaveBeenCalled();
  });

  it("answers once within the Discord deadline, sharing slow catalog requests without late replies", async () => {
    vi.useFakeTimers(); let resolve!: (value: CodexModel[]) => void;
    vi.mocked(codexAppServer.listModels).mockReturnValue(new Promise(done => { resolve = done; }));
    const first = interaction(), second = interaction();
    const one = helpers.autocompleteModelOptions(first, "model"), two = helpers.autocompleteModelOptions(second, "model");
    await vi.advanceTimersByTimeAsync(1_800); await Promise.all([one, two]);
    expect(choices(first)).toEqual([]); expect(choices(second)).toEqual([]);
    expect(codexAppServer.listModels).toHaveBeenCalledOnce();
    resolve(models); await vi.advanceTimersByTimeAsync(0);
    expect(first.respond).toHaveBeenCalledOnce(); expect(second.respond).toHaveBeenCalledOnce();
    expect(await helpers.getModelOptionChoices()).toHaveLength(3);
  });

  it("returns cached suggestions immediately during a slow background refresh", async () => {
    vi.useFakeTimers(); await helpers.warmModelOptions(); await vi.advanceTimersByTimeAsync(60_001);
    let resolve!: (value: CodexModel[]) => void;
    vi.mocked(codexAppServer.listModels).mockReturnValue(new Promise(done => { resolve = done; }));
    const i = interaction(); await helpers.autocompleteModelOptions(i, "model");
    expect(choices(i)).toHaveLength(3); expect(codexAppServer.listModels).toHaveBeenCalledTimes(2);
    resolve([models[0]]); await vi.advanceTimersByTimeAsync(0);
    expect(await helpers.getModelOptionChoices()).toHaveLength(1);
  });

  it("bounds startup catalog registration so unavailable Codex cannot block slash command registration", async () => {
    vi.useFakeTimers(); vi.mocked(codexAppServer.listModels).mockReturnValue(new Promise(() => {}));
    const result = expect(helpers.getModelOptionChoices()).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(20_000); await result;
  });

  it("allows slow cold startup to register fixed choices while native autocomplete keeps its short deadline", async () => {
    vi.useFakeTimers(); let resolve!: (value: CodexModel[]) => void;
    vi.mocked(codexAppServer.listModels).mockReturnValue(new Promise(done => { resolve = done; }));
    const registration = helpers.getModelOptionChoices();
    const i = interaction(); const completion = helpers.autocompleteModelOptions(i, "model");
    await vi.advanceTimersByTimeAsync(1_800); await completion;
    expect(choices(i)).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000); resolve(models);
    expect(await registration).toHaveLength(3);
    expect(i.respond).toHaveBeenCalledTimes(1);
    expect(codexAppServer.listModels).toHaveBeenCalledTimes(1);
  });
});
