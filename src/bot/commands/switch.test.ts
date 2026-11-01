import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../codex/session-manager.js", () => ({sessionManager:{isActive:vi.fn(),hasQueue:vi.fn(),getQueueSize:vi.fn()}}));
import { sessionManager } from "../../codex/session-manager.js";
import { getDb, getProject, getSession, initDatabase, registerProject, registerThreadProject, selectSession } from "../../db/database.js";
import { showMode } from "./switch.js";

describe("conversation mode selection", () => {
  beforeEach(() => {vi.resetAllMocks();initDatabase(":memory:");registerProject("root","/project","guild");});
  afterEach(() => getDb().close());
  const interaction = (channelId="root") => ({channelId,editReply:vi.fn().mockResolvedValue(undefined)}) as any;
  it("offers both modes and persists a choice without losing either mapping", async () => {
    selectSession("root","old-session");registerThreadProject("child","root");selectSession("child","child-session");
    const i=interaction();await showMode(i);
    expect(i.editReply.mock.calls[0][0].components[0].toJSON().components).toHaveLength(2);
    await showMode(i,"channel");
    expect(getProject("root")?.chat_mode).toBe("channel");
    expect(getSession("root")?.session_id).toBe("old-session");
    expect(getSession("child")?.session_id).toBe("child-session");
    await showMode(i,"threads");expect(getProject("root")?.chat_mode).toBe("threads");
  });
  it("switching from a child updates only its parent", async () => {
    registerThreadProject("child","root");await showMode(interaction("child"),"channel");
    expect(getProject("root")?.chat_mode).toBe("channel");
    expect(getProject("child")?.chat_mode).toBe("threads");
  });
  it("does not switch while the main-channel conversation is running or queued", async () => {
    vi.mocked(sessionManager.isActive).mockReturnValue(true);
    await showMode(interaction(),"channel");expect(getProject("root")?.chat_mode).toBe("threads");
    vi.mocked(sessionManager.isActive).mockReturnValue(false);
    vi.mocked(sessionManager.getQueueSize).mockReturnValue(1);
    await showMode(interaction(),"channel");expect(getProject("root")?.chat_mode).toBe("threads");
  });
});
