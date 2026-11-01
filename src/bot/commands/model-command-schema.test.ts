import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./model-options.js", () => ({
  warmModelOptions: vi.fn(),
  executeModelOptions: vi.fn(),
  autocompleteModelOptions: vi.fn(),
}));

import { warmModelOptions } from "./model-options.js";
import { data as modelData, registrationData } from "./model.js";
import { data as reasoningData } from "./reasoning.js";

describe("pre-send command definitions", () => {
  beforeEach(() => vi.resetAllMocks());

  it("keeps both native options optional so parameterless commands open menus", () => {
    expect(modelData.toJSON().options).toMatchObject([
      { name: "model", type: 3, required: false, autocomplete: true },
      { name: "reasoning", type: 3, required: false, autocomplete: true },
    ]);
    expect(reasoningData.toJSON().options).toMatchObject([
      { name: "reasoning", type: 3, required: false, autocomplete: true },
    ]);
  });

  it("registers dynamic suggestions so the first row can show current session settings", async () => {
    vi.mocked(warmModelOptions).mockResolvedValue(undefined);
    const definition = await registrationData();
    expect(definition.options?.[0]).toMatchObject({ name: "model", autocomplete: true, required: false });
    expect(definition.options?.[0]).not.toHaveProperty("choices", expect.anything());
    expect(definition.options?.[1]).toMatchObject({ name: "reasoning", autocomplete: true, required: false });
  });

  it("still registers pre-send options if the live catalog is unavailable", async () => {
    vi.mocked(warmModelOptions).mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const definition = JSON.parse(JSON.stringify(await registrationData()));
      expect(definition.options?.[0]).toMatchObject({ required: false, autocomplete: true });
      expect(definition.options?.[0]).not.toHaveProperty("choices");
    } finally {
      warn.mockRestore();
    }
  });
});
