import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createThreadLifecycle, notifyDesktopLifecycle } from "./thread-lifecycle.js";

describe("verified Codex lifecycle", () => {
  let dir: string;
  let core: Database.Database;
  let catalog: Database.Database;
  let paths: Record<string, string>;
  let change: ReturnType<typeof createThreadLifecycle>;
  const api = { archiveThread: vi.fn(), deleteThread: vi.fn(), unarchiveThread: vi.fn() };
  const notify = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lifecycle-"));
    core = new Database(path.join(dir, "state.db"));
    catalog = new Database(path.join(dir, "catalog.db"));
    core.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, archived INTEGER);
      CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);`);
    catalog.exec(`CREATE TABLE local_thread_catalog(host_id TEXT,thread_id TEXT);
      CREATE TABLE local_thread_catalog_metadata(id INTEGER,catalog_revision INTEGER);
      INSERT INTO local_thread_catalog_metadata VALUES (1,42);`);
    paths = {};
    for (const id of ["root", "child", "unrelated"]) {
      paths[id] = path.join(dir, `${id}.jsonl`); fs.writeFileSync(paths[id], "{}\n");
      core.prepare("INSERT INTO threads VALUES (?,?,0)").run(id, paths[id]);
      catalog.prepare("INSERT INTO local_thread_catalog VALUES ('local',?)").run(id);
    }
    core.exec("INSERT INTO thread_spawn_edges VALUES ('root','child');");
    catalog.exec("INSERT INTO local_thread_catalog VALUES ('remote','root');");
    change = createThreadLifecycle({ stateDbPath: () => path.join(dir, "state.db"),
      catalogPath: path.join(dir, "catalog.db"), api, notify });
  });
  afterEach(() => { core.close(); catalog.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it("deletes root and known descendants, removes only their local desktop rows and bumps revision", async () => {
    api.deleteThread.mockImplementation(async () => {
      for (const id of ["root", "child"]) {
        core.prepare("DELETE FROM threads WHERE id=?").run(id); fs.unlinkSync(paths[id]);
      }
    });
    await change("root", "delete");
    expect(catalog.prepare("SELECT * FROM local_thread_catalog ORDER BY host_id").all()).toEqual([
      { host_id: "local", thread_id: "unrelated" }, { host_id: "remote", thread_id: "root" },
    ]);
    expect(catalog.prepare("SELECT catalog_revision AS n FROM local_thread_catalog_metadata").get()).toEqual({ n: 43 });
    expect(notify).toHaveBeenCalledWith(["root", "child"], "delete");
    expect(fs.existsSync(paths.unrelated)).toBe(true);
  });

  it("does not report success or hide the desktop row when a successful RPC left core data behind", async () => {
    await expect(change("root", "delete")).rejects.toThrow("删除未完成");
    expect(notify).not.toHaveBeenCalled();
    expect(catalog.prepare("SELECT count(*) AS n FROM local_thread_catalog").get()).toEqual({ n: 4 });
  });

  it("rejects a leftover rollout even when the state row was deleted", async () => {
    api.deleteThread.mockImplementation(async () => { core.exec("DELETE FROM threads WHERE id IN ('root','child')"); });
    await expect(change("root", "delete")).rejects.toThrow("历史文件");
  });

  it("verifies archived root and descendants, then allows restoring just the requested root", async () => {
    api.archiveThread.mockImplementation(async () => { core.exec("UPDATE threads SET archived=1 WHERE id IN ('root','child')"); });
    await change("root", "archive");
    expect(catalog.prepare("SELECT count(*) AS n FROM local_thread_catalog WHERE host_id='local'").get()).toEqual({ n: 1 });
    expect(fs.existsSync(paths.root)).toBe(true);
    api.unarchiveThread.mockImplementation(async () => { core.exec("UPDATE threads SET archived=0 WHERE id='root'"); });
    await change("root", "restore");
    expect(notify).toHaveBeenLastCalledWith(["root"], "restore");
    expect(core.prepare("SELECT archived FROM threads WHERE id='child'").get()).toEqual({ archived: 1 });
  });

  it("detects incomplete recursive archive instead of claiming all descendants succeeded", async () => {
    api.archiveThread.mockImplementation(async () => { core.exec("UPDATE threads SET archived=1 WHERE id='root'"); });
    await expect(change("root", "archive")).rejects.toThrow("未通过核验");
    expect(notify).not.toHaveBeenCalled();
  });

  it("repairs an orphaned desktop row on a delete retry without invoking a nonexistent core thread", async () => {
    core.exec("DELETE FROM threads WHERE id='root'; DELETE FROM thread_spawn_edges"); fs.unlinkSync(paths.root);
    await change("root", "delete");
    expect(api.deleteThread).not.toHaveBeenCalled();
    expect(catalog.prepare("SELECT count(*) AS n FROM local_thread_catalog WHERE host_id='local' AND thread_id='root'").get()).toEqual({ n: 0 });
  });

  it("does not swallow a desktop notification failure", async () => {
    api.archiveThread.mockImplementation(async () => { core.exec("UPDATE threads SET archived=1 WHERE id IN ('root','child')"); });
    notify.mockRejectedValue(new Error("IPC timeout"));
    await expect(change("root", "archive")).rejects.toThrow("IPC timeout");
  });
});

describe("desktop cache notification protocol", () => {
  it("initializes with its own identity, then sends the observed archive cache event", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ipc-test-"));
    const socketPath = path.join(dir, "ipc.sock");
    const seen: any[] = [];
    let done!: () => void;
    const delivered = new Promise<void>(resolve => { done = resolve; });
    const server = net.createServer(socket => {
      let buffer = Buffer.alloc(0);
      socket.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
          const length = buffer.readUInt32LE(0);
          const message = JSON.parse(buffer.subarray(4, length + 4).toString());
          buffer = buffer.subarray(length + 4); seen.push(message);
          if (message.method === "initialize") {
            const body = Buffer.from(JSON.stringify({ type: "response", requestId: message.requestId,
              resultType: "success", result: { clientId: "assigned-client" } }));
            const header = Buffer.alloc(4); header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body]));
          } else done();
        }
      });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    try {
      await notifyDesktopLifecycle(["selected-thread"], "delete", socketPath);
      await delivered;
      expect(seen[0]).toMatchObject({ params: { clientType: "codex-discord" } });
      expect(seen[1]).toMatchObject({ type: "broadcast", sourceClientId: "assigned-client",
        method: "thread-archived", version: 2, params: { hostId: "local", conversationId: "selected-thread" } });
      expect(seen.some(message => message.method === "tools/call")).toBe(false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
