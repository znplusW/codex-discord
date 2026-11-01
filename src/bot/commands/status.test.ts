import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, initDatabase } from "../../db/database.js";
import { bindManagedChannel, saveManagedConversation, setManagedAction, setManagedSyncResult } from "../../db/channel-conversations.js";
import { describeLifecycleFailure } from "../../codex/lifecycle-errors.js";
import { execute } from "./status.js";

describe("status with blocked lifecycle requests", () => {
  beforeEach(() => initDatabase(":memory:"));
  afterEach(() => getDb().close());
  it.each([50, 2000])("fits Discord's total and field limits with %i-character project paths", async length => {
    for (let n = 0; n < 30; n++) {
      saveManagedConversation("guild", `s-${n}`, `会话 ${n}`, "/" + "a".repeat(length));
      bindManagedChannel("guild", `s-${n}`, `c-${n}`);
      setManagedAction("guild", `s-${n}`, "delete", true);
      setManagedSyncResult("guild", `s-${n}`, describeLifecycleFailure(new Error("thread id already has an active writer")));
    }
    const interaction = { guildId: "guild", channelId: "c-0", editReply: vi.fn() } as any;
    await execute(interaction);
    const embed = interaction.editReply.mock.calls[0][0].embeds[0];
    const json = embed.toJSON();
    expect(embed.length).toBeLessThanOrEqual(6000);
    expect(json.fields.length).toBeLessThanOrEqual(25);
    expect(json.fields.every((f: {value:string}) => f.value.length <= 1024)).toBe(true);
    expect(json.fields[0].name).toContain("<#c-0>");
    expect(json.fields[0].value).toContain("待执行：删除");
    expect(json.fields[0].value).toContain("请先退出占用");
    expect(json.footer.text).toContain("共 30 个");
  });
});
