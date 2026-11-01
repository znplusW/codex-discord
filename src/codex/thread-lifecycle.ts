import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { codexAppServer } from "./app-server-client.js";
import { findStateDbPath } from "./storage.js";

export type LifecycleAction = "archive" | "delete" | "restore";
type StoredState = { id: string; rollout_path: string; archived: number };
type LifecycleApi = Pick<typeof codexAppServer, "archiveThread" | "deleteThread" | "unarchiveThread">;
type Options = {
  stateDbPath: () => string | null;
  catalogPath: string;
  api: LifecycleApi;
  notify: (threadIds: string[], action: LifecycleAction) => Promise<void>;
};

function readStates(dbPath: string, threadId: string, descendants: boolean): StoredState[] {
  const db = new Database(dbPath, { readonly: true, timeout: 5000 });
  try {
    const hasEdges = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_spawn_edges'").get();
    if (descendants && hasEdges) {
      return db.prepare(`WITH RECURSIVE family(id) AS (
        SELECT ? UNION SELECT e.child_thread_id FROM thread_spawn_edges e JOIN family f ON e.parent_thread_id=f.id
      ) SELECT id, rollout_path, archived FROM threads WHERE id IN (SELECT id FROM family)`)
        .all(threadId) as StoredState[];
    }
    return db.prepare("SELECT id, rollout_path, archived FROM threads WHERE id=?").all(threadId) as StoredState[];
  } finally { db.close(); }
}

/** The desktop sidebar is a separate cache; core RPC success alone is insufficient. */
function removeCatalogEntries(catalogPath: string, ids: string[]): void {
  if (!fs.existsSync(catalogPath)) return; // Desktop has never populated a catalog.
  const db = new Database(catalogPath, { timeout: 5000 });
  try {
    const columns = db.pragma("table_info(local_thread_catalog)") as { name: string }[];
    if (!columns.some(c => c.name === "thread_id") || !columns.some(c => c.name === "host_id")) {
      throw new Error("桌面会话目录结构已变化，未能核验列表同步；请更新适配器。");
    }
    db.transaction(() => {
      const remove = db.prepare("DELETE FROM local_thread_catalog WHERE host_id='local' AND thread_id=?");
      let changes = 0;
      for (const id of ids) changes += remove.run(id).changes;
      if (changes) {
        const result = db.prepare("UPDATE local_thread_catalog_metadata SET catalog_revision=catalog_revision+1 WHERE id=1").run();
        if (result.changes !== 1) throw new Error("桌面列表修订号更新失败。");
      }
    })();
    const count = db.prepare("SELECT count(*) AS n FROM local_thread_catalog WHERE host_id='local' AND thread_id=?");
    if (ids.some(id => (count.get(id) as { n: number }).n !== 0)) throw new Error("桌面列表仍有残留会话，未完成同步。");
    if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("桌面会话目录校验失败。");
  } finally { db.close(); }
}

/** Uses the desktop's local IPC cache-invalidation broadcasts, without invoking app tools. */
export async function notifyDesktopLifecycle(
  threadIds: string[], action: LifecycleAction,
  socketPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "ipc", "ipc.sock"),
): Promise<void> {
  if (!fs.existsSync(socketPath)) return; // Closed desktop will read the corrected persistent state next time.
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Codex 桌面 IPC 的所有者或类型无效。");
  const frame = (data: unknown) => {
    const body = Buffer.from(JSON.stringify(data));
    const output = Buffer.alloc(4 + body.length);
    output.writeUInt32LE(body.length); body.copy(output, 4); return output;
  };
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let received = Buffer.alloc(0);
    const requestId = randomUUID();
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("桌面列表刷新超时，请稍后重试。")), 5000);
    socket.on("error", error => {
      // A stale socket is normal after the desktop closes; its next launch reads the repaired catalog.
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED" || (error as NodeJS.ErrnoException).code === "ENOENT") finish();
      else finish(error);
    });
    socket.on("connect", () => socket.write(frame({ type: "request", requestId,
      sourceClientId: "initializing-client", version: 0, method: "initialize", params: { clientType: "codex-discord" } })));
    socket.on("data", chunk => {
      received = Buffer.concat([received, chunk]);
      while (received.length >= 4) {
        const length = received.readUInt32LE(0);
        if (length > 8 * 1024 * 1024) { finish(new Error("桌面 IPC 返回过大的消息。")); return; }
        if (received.length < length + 4) return;
        let message: any;
        try { message = JSON.parse(received.subarray(4, length + 4).toString()); }
        catch { finish(new Error("桌面 IPC 返回无效消息。")); return; }
        received = received.subarray(length + 4);
        if (message.type !== "response" || message.requestId !== requestId) continue;
        if (message.resultType !== "success" || typeof message.result?.clientId !== "string") {
          finish(new Error("桌面 IPC 初始化失败。")); return;
        }
        const clientId = message.result.clientId;
        // The app exposes no thread-deleted IPC broadcast. Both archive and delete
        // invalidate the active-list/cache using thread-archived; core state determines
        // whether the thread exists in Archived. No deleted row is recreated.
        const method = action === "restore" ? "thread-unarchived" : "thread-archived";
        for (const id of threadIds) socket.write(frame({ type: "broadcast", method,
          sourceClientId: clientId, version: action === "restore" ? 1 : 2,
          params: { hostId: "local", conversationId: id } }));
        socket.end(() => finish());
        return;
      }
    });
    socket.on("close", () => { if (!finished) finish(new Error("桌面 IPC 在刷新列表前断开。")); });
  });
}

export function createThreadLifecycle(options: Options) {
  return async (threadId: string, action: LifecycleAction): Promise<void> => {
    if (!threadId.trim()) throw new Error("会话标识符为空。");
    const statePath = options.stateDbPath();
    if (!statePath) throw new Error("未找到 Codex 核心状态数据库，无法核验操作。");
    const before = readStates(statePath, threadId, action !== "restore");
    const root = before.find(row => row.id === threadId);
    if (!root && action !== "delete") throw new Error("Codex 会话已不存在，无法归档或恢复。");
    if (action === "delete") {
      // Idempotent retry also repairs a leftover desktop row from an earlier core deletion.
      if (root) await options.api.deleteThread(threadId);
      else for (const remaining of before) await options.api.deleteThread(remaining.id);
    } else if (action === "archive") {
      if (!root?.archived) await options.api.archiveThread(threadId);
    } else if (root?.archived) await options.api.unarchiveThread(threadId);

    const ids = new Set([threadId, ...before.map(row => row.id)]);
    for (const id of ids) {
      const current = readStates(statePath, id, false)[0];
      if (action === "delete") {
        if (current || before.some(row => row.id === id && row.rollout_path && fs.existsSync(row.rollout_path))) {
          throw new Error("核心会话或历史文件仍然存在，删除未完成。");
        }
      } else if (!current || current.archived !== (action === "archive" ? 1 : 0)
        || !current.rollout_path || !fs.existsSync(current.rollout_path)) {
        throw new Error("核心会话的归档状态或历史文件未通过核验。");
      }
    }
    if (action !== "restore") removeCatalogEntries(options.catalogPath, [...ids]);
    await options.notify([...ids], action);
    // Recheck after notifying: desktop cache activity must not resurrect a stale row.
    if (action !== "restore") removeCatalogEntries(options.catalogPath, [...ids]);
  };
}

export const changeThreadLifecycle = createThreadLifecycle({
  stateDbPath: findStateDbPath,
  catalogPath: path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sqlite", "codex.db"),
  api: codexAppServer,
  notify: notifyDesktopLifecycle,
});
