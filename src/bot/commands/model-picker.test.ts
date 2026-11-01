import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../security/guard.js", () => ({ isAllowedUser: vi.fn(() => true) }));
vi.mock("../../codex/model-settings.js", () => ({ getModelSelectionContext: vi.fn(), applyModelSelection: vi.fn() }));
import { isAllowedUser } from "../../security/guard.js";
import { getModelSelectionContext, applyModelSelection, type ModelSelectionContext } from "../../codex/model-settings.js";
import { showModelPicker, handleModelPickerSelect, handleModelPickerButton } from "./model-picker.js";
import type { CodexModel } from "../../codex/app-server-client.js";

const makeModel = (index: number, efforts = ["low", "high"]): CodexModel => ({
  id: `model-${index}`, model: `model-${index}`, displayName: `模型 ${index}`, isDefault: index === 0,
  defaultReasoningEffort: efforts[0] ?? null,
  supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: `说明 ${reasoningEffort}` })),
});
function context(models = [makeModel(0), makeModel(1, ["medium", "xhigh"])]): ModelSelectionContext {
  return { scopeKey: "thread:codex-a", channelId: "channel-a", sessionId: "codex-a", label: "当前子区会话",
    current: { model: "model-0", reasoningEffort: "low" }, models };
}
const command = (channelId = "channel-a", userId = "owner") => ({ channelId, user: { id: userId }, editReply: vi.fn().mockResolvedValue(undefined) }) as any;
function component(customId: string, value?: string, channelId = "channel-a", userId = "owner") {
  return { channelId, user: { id: userId }, customId, values: value === undefined ? [] : [value],
    deferUpdate: vi.fn().mockResolvedValue(undefined), editReply: vi.fn().mockResolvedValue(undefined), reply: vi.fn().mockResolvedValue(undefined) } as any;
}
function payload(interaction: any) { return interaction.editReply.mock.calls.at(-1)[0]; }
function rows(interaction: any) { return payload(interaction).components.map((row: any) => row.toJSON().components).flat(); }
function selectId(interaction: any) { return rows(interaction).find((row: any) => row.type === 3).custom_id; }
function buttonId(interaction: any, label: string) { return rows(interaction).find((row: any) => row.label === label).custom_id; }
async function open(mode: "model" | "reasoning" = "model") {
  const i = command(); await showModelPicker(i, mode); return i;
}

describe("mobile model and reasoning menus", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isAllowedUser).mockReturnValue(true);
    vi.mocked(getModelSelectionContext).mockResolvedValue(context());
    vi.mocked(applyModelSelection).mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("selects a model first and saves model plus supported effort only after the second choice", async () => {
    const first = await open();
    expect(rows(first)[0].options.map((option: any) => option.label)).toEqual(["模型 0", "模型 1"]);
    const selectedModel = component(selectId(first), "1");
    await handleModelPickerSelect(selectedModel);
    expect(applyModelSelection).not.toHaveBeenCalled();
    expect(rows(selectedModel)[0].options.map((option: any) => option.label)).toEqual(["中等（medium）", "更高（xhigh）"]);
    const selectedEffort = component(selectId(selectedModel), "1");
    await handleModelPickerSelect(selectedEffort);
    expect(applyModelSelection).toHaveBeenCalledTimes(1);
    expect(applyModelSelection).toHaveBeenCalledWith("channel-a", "thread:codex-a", { model: "model-1", reasoningEffort: "xhigh" }, undefined);
    expect(payload(selectedEffort).components).toEqual([]);
    expect(payload(selectedEffort).content).toContain("已保存");
  });

  it("reasoning skips the model page and guards the current model against later changes", async () => {
    const first = await open("reasoning");
    expect(rows(first)[0].placeholder).toContain("当前模型");
    expect(rows(first).some((row: any) => row.label === "重新选模型")).toBe(false);
    const selected = component(selectId(first), "1");
    await handleModelPickerSelect(selected);
    expect(applyModelSelection).toHaveBeenCalledWith("channel-a", "thread:codex-a", { model: "model-0", reasoningEffort: "high" }, "model-0");
  });

  it("continues from a preselected model without saving until an effort is chosen", async () => {
    const i=command(); await showModelPicker(i,"model","model-1");
    expect(rows(i)[0].options.map((option:any)=>option.label)).toEqual(["中等（medium）","更高（xhigh）"]);
    expect(payload(i).content).toContain("当前：model-0");
    expect(applyModelSelection).not.toHaveBeenCalled();
    await handleModelPickerSelect(component(selectId(i),"0"));
    expect(applyModelSelection).toHaveBeenCalledWith("channel-a","thread:codex-a",{model:"model-1",reasoningEffort:"medium"},undefined);
  });

  it("cancelling after choosing a model leaves both settings untouched", async () => {
    const first = await open();
    const second = component(selectId(first), "1"); await handleModelPickerSelect(second);
    const cancel = component(buttonId(second, "取消")); await handleModelPickerButton(cancel);
    expect(applyModelSelection).not.toHaveBeenCalled();
    expect(payload(cancel).content).toContain("未修改");
  });

  it("pages a model catalog larger than Discord's 25-option limit", async () => {
    vi.mocked(getModelSelectionContext).mockResolvedValue(context(Array.from({ length: 27 }, (_, index) => makeModel(index))));
    const first = await open(); expect(rows(first)[0].options).toHaveLength(25);
    const next = component(buttonId(first, "下一页")); await handleModelPickerButton(next);
    expect(rows(next)[0].options).toHaveLength(2);
    expect(rows(next)[0].options[1].value).toBe("26");
    const chosen = component(selectId(next), "26"); await handleModelPickerSelect(chosen);
    const final = component(selectId(chosen), "0"); await handleModelPickerSelect(final);
    expect(applyModelSelection).toHaveBeenCalledWith("channel-a", "thread:codex-a", { model: "model-26", reasoningEffort: "low" }, undefined);
  });

  it("pages future models' arbitrary reasoning options instead of assuming a fixed list", async () => {
    const efforts = Array.from({ length: 27 }, (_, index) => `effort-${index}`);
    vi.mocked(getModelSelectionContext).mockResolvedValue(context([makeModel(0, efforts)]));
    const first = await open("reasoning");
    const next = component(buttonId(first, "下一页")); await handleModelPickerButton(next);
    expect(rows(next)[0].options.map((o: any) => o.label)).toEqual(["effort-25", "effort-26"]);
    await handleModelPickerSelect(component(selectId(next), "1")); // A forged index outside this page.
    expect(applyModelSelection).not.toHaveBeenCalled();
    await handleModelPickerSelect(component(selectId(next), "26"));
    expect(applyModelSelection).toHaveBeenCalledWith("channel-a", "thread:codex-a", { model: "model-0", reasoningEffort: "effort-26" }, "model-0");
  });

  it("requires an explicit model confirmation when no adjustable efforts exist", async () => {
    vi.mocked(getModelSelectionContext).mockResolvedValue(context([makeModel(0, [])]));
    const first = await open(); const selected = component(selectId(first), "0"); await handleModelPickerSelect(selected);
    expect(applyModelSelection).not.toHaveBeenCalled(); expect(rows(selected).some((c: any) => c.type === 3)).toBe(false);
    await handleModelPickerButton(component(buttonId(selected, "使用此模型")));
    expect(applyModelSelection).toHaveBeenCalledWith("channel-a", "thread:codex-a", { model: "model-0", reasoningEffort: null }, undefined);
  });

  it("does not invent a reasoning option when the current model has none", async () => {
    vi.mocked(getModelSelectionContext).mockResolvedValue(context([makeModel(0, [])]));
    const first = await open("reasoning");
    expect(payload(first).components).toEqual([]); expect(payload(first).content).toContain("没有可调");
  });

  it("reports an unavailable current model and empty catalogs without guessing", async () => {
    vi.mocked(getModelSelectionContext).mockResolvedValue(context([makeModel(8)]));
    expect(payload(await open("reasoning")).content).toContain("不在可选模型目录");
    vi.mocked(getModelSelectionContext).mockResolvedValue(context([]));
    expect(payload(await open()).content).toContain("没有返回可选择");
  });

  it("rejects other users, other channels, and unauthorized callers", async () => {
    const first = await open();
    const wrongUser = component(selectId(first), "0", "channel-a", "other");
    await handleModelPickerSelect(wrongUser); expect(wrongUser.reply).toHaveBeenCalled();
    const wrongChannel = component(selectId(first), "0", "channel-b");
    await handleModelPickerSelect(wrongChannel); expect(wrongChannel.reply).toHaveBeenCalled();
    vi.mocked(isAllowedUser).mockReturnValue(false);
    const denied = component(selectId(first), "0"); await handleModelPickerSelect(denied);
    expect(denied.deferUpdate).not.toHaveBeenCalled(); expect(applyModelSelection).not.toHaveBeenCalled();
  });

  it("rejects expired, replaced, and prior-stage menu events", async () => {
    const first = await open(); const selected = component(selectId(first), "0"); await handleModelPickerSelect(selected);
    const old = component(selectId(first), "1"); await handleModelPickerSelect(old);
    expect(old.reply.mock.calls[0][0].content).toContain("失效");
    await open();
    const replaced = component(selectId(selected), "0"); await handleModelPickerSelect(replaced);
    expect(replaced.reply.mock.calls[0][0].content).toContain("过期");
    const fresh = await open(); const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60 * 1000);
    const expired = component(selectId(fresh), "0"); await handleModelPickerSelect(expired);
    expect(expired.reply.mock.calls[0][0].content).toContain("过期"); expect(applyModelSelection).not.toHaveBeenCalled();
  });

  it("reports service rejection without claiming that a stale scope or changed model was saved", async () => {
    const first = await open("reasoning"); vi.mocked(applyModelSelection).mockRejectedValue(new Error("当前会话已切换"));
    const selected = component(selectId(first), "1"); await handleModelPickerSelect(selected);
    expect(payload(selected).content).toContain("未能保存"); expect(payload(selected).content).toContain("当前会话已切换");
    expect(payload(selected).components).toEqual([]);
  });

  it("deduplicates concurrent submission events", async () => {
    const first = await open("reasoning");
    let release!: () => void;
    vi.mocked(applyModelSelection).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const a = component(selectId(first), "1"); const b = component(selectId(first), "1");
    const pending = handleModelPickerSelect(a); await handleModelPickerSelect(b);
    expect(b.reply).toHaveBeenCalled();
    await vi.waitFor(() => expect(applyModelSelection).toHaveBeenCalledTimes(1));
    release(); await pending;
  });

  it("returns unrelated components to other handlers", async () => {
    expect(await handleModelPickerSelect(component("session-select", "0"))).toBe(false);
    expect(await handleModelPickerButton(component("stop:thread"))).toBe(false);
  });
});
