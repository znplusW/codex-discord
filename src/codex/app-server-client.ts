import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { resolveCodexCommand } from "./command-resolver.js";

export interface CodexTurn {
  id: string;
  status: string | { type: string };
  error?: { message?: string; additionalDetails?: string | null } | null;
  items: CodexThreadItem[];
}

export type CodexThreadItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "commandExecution"; id: string; command: string; cwd: string; status: string }
  | { type: "fileChange"; id: string; status: string; changes: Array<{ path: string; diff: string; kind: string }> }
  | { type: "userMessage"; id: string; content: unknown[] }
  | { type: string; id: string; [key: string]: unknown };

export interface ModelPreferences {
  model: string;
  reasoningEffort: string | null;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
}

export interface CodexThreadSummary {
  id: string;
  preview: string;
  cwd: string;
  source: string;
  updatedAt: number;
  createdAt: number;
  modelProvider: string;
  model?: string | null;
  reasoningEffort?: string | null;
  path: string | null;
  name: string | null;
  status: unknown;
  turns: CodexTurn[];
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface CodexRateLimitSnapshot {
  limitId?: string;
  limitName?: string;
  planType?: string;
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
}

export interface CodexRateLimitsResponse {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot>;
}

interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcServerRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shouldUseShell(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

export class CodexAppServerClient extends EventEmitter {
  private static readonly REQUEST_TIMEOUT_MS = 15_000;
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private initialized = false;
  private startPromise: Promise<void> | null = null;

  /** Close only this owned child and wait until its writer lease is released. */
  async close(): Promise<void> {
    if (this.startPromise) await this.startPromise.catch(() => {});
    const child = this.process;
    if (!child) return;
    await new Promise<void>((resolve, reject) => {
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      const timeout = setTimeout(() => { cleanup(); reject(new Error("Codex 运行连接未能关闭，请稍后重试。")); }, 8_000);
      const cleanup = () => { clearTimeout(killTimer); clearTimeout(timeout); child.off("exit", onExit); };
      const onExit = () => { cleanup(); resolve(); };
      child.once("exit", onExit);
      child.kill("SIGTERM");
    });
  }

  async ensureStarted(): Promise<void> {
    if (this.initialized) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(): Promise<void> {
    const codexCommand = resolveCodexCommand();
    this.process = spawn(codexCommand, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: shouldUseShell(codexCommand),
      windowsHide: true,
    });

    this.process.once("error", (error) => {
      const reason = new Error(`Failed to start Codex app-server via \`${codexCommand}\`: ${error.message}`);
      this.rejectPendingRequests(reason);
      this.initialized = false;
      this.process = null;
      this.emit("exit", reason);
    });

    this.process.once("exit", (code, signal) => {
      const reason = new Error(`Codex app-server exited (${code ?? "null"}${signal ? `, ${signal}` : ""})`);
      this.initialized = false;
      this.process = null;
      this.rejectPendingRequests(reason);
      this.emit("exit", reason);
    });

    const stdout = createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    stdout.on("line", (line) => this.handleStdoutLine(line));

    const stderr = createInterface({ input: this.process.stderr, crlfDelay: Infinity });
    stderr.on("line", (line) => {
      if (line.trim()) this.emit("stderr", line);
    });

    await this.requestWithProcess("initialize", {
      clientInfo: {
        name: "codex-discord",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    this.initialized = true;
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      this.emit("stderr", `Non-JSON app-server output: ${trimmed}`);
      return;
    }

    if (!isObject(payload)) return;

    if ("id" in payload && "method" in payload && "params" in payload) {
      this.emit("serverRequest", payload as unknown as JsonRpcServerRequest);
      return;
    }

    if ("method" in payload) {
      this.emit("notification", payload as unknown as JsonRpcNotification);
      return;
    }

    if ("id" in payload && "result" in payload) {
      const id = Number(payload.id);
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      pending.resolve(payload.result);
      return;
    }

    if ("id" in payload && "error" in payload) {
      const id = Number(payload.id);
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      const errorMessage =
        isObject(payload.error) && typeof payload.error.message === "string"
          ? payload.error.message
          : "Unknown app-server error";
      pending.reject(new Error(errorMessage));
    }
  }

  private requestWithProcess<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.process) throw new Error("Codex app-server is not running");

    const id = this.nextRequestId++;
    const response = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, CodexAppServerClient.REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
    });

    this.process.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );

    return response;
  }

  private rejectPendingRequests(reason: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      pending.reject(reason);
    }
  }

  async request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.ensureStarted();
    return this.requestWithProcess<T>(method, params);
  }

  async respond(requestId: number, result: Record<string, unknown>): Promise<void> {
    await this.ensureStarted();
    if (!this.process) throw new Error("Codex app-server is not running");
    this.process.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: requestId, result })}\n`,
    );
  }

  async listThreads(cwd: string): Promise<CodexThreadSummary[]> {
    const result = await this.request<{ data: CodexThreadSummary[] }>("thread/list", {
      cwd,
      sortKey: "updated_at",
      sourceKinds: ["vscode", "cli", "appServer", "exec"],
      limit: 100,
    });
    return result.data ?? [];
  }

  async readThread(threadId: string, includeTurns = false): Promise<CodexThreadSummary> {
    const result = await this.request<{ thread: CodexThreadSummary }>("thread/read", {
      threadId,
      includeTurns,
    });
    return result.thread;
  }

  async readRecentTurns(threadId: string, limit = 20, cursor?: string | null): Promise<{ turns: CodexTurn[]; hasMore: boolean; nextCursor: string | null }> {
    try {
      if (cursor?.startsWith("legacy-before:")) throw new Error("method not found: legacy cursor");
      const page = await this.request<{ data: CodexTurn[]; nextCursor?: string | null }>("thread/turns/list", {
        threadId, limit, sortDirection: "desc", itemsView: "full", ...(cursor ? { cursor } : {}),
      });
      if (cursor && page.nextCursor === cursor) throw new Error("历史分页位置没有前进，请稍后重试。");
      return { turns: [...(page.data ?? [])].reverse(), hasMore: Boolean(page.nextCursor), nextCursor: page.nextCursor || null };
    } catch (error) {
      // Older local versions only expose full history through thread/read.
      const message = error instanceof Error ? error.message : "";
      if (!/unknown (?:method|variant)|method not found|does not support.*(?:paginat|turn)|not supported.*(?:legacy|thread)/i.test(message)) throw error;
      const thread = await this.readThread(threadId, true);
      const before = cursor?.startsWith("legacy-before:") ? thread.turns.findIndex(turn => turn.id === cursor.slice(14)) : thread.turns.length;
      if (before < 0) throw new Error("历史分页位置已失效，请重新导入会话。");
      const turns = thread.turns.slice(Math.max(0, before - limit), before);
      const hasMore = before > limit;
      return { turns, hasMore, nextCursor: hasMore && turns[0] ? `legacy-before:${turns[0].id}` : null };
    }
  }

  async listModels(): Promise<CodexModel[]> {
    const models = new Map<string, CodexModel>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.request<{ data: CodexModel[]; nextCursor?: string | null }>("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      for (const model of page.data ?? []) {
        if (!model.hidden) models.set(model.model, model);
      }
      cursor = page.nextCursor || undefined;
      if (cursor && cursors.has(cursor)) throw new Error("Codex 模型目录分页异常，请稍后重试。");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...models.values()];
  }

  async readModelDefaults(cwd?: string, knownModels?: CodexModel[]): Promise<ModelPreferences> {
    const result = await this.request<{ config: { model?: unknown; model_reasoning_effort?: unknown } }>("config/read", {
      includeLayers: false,
      ...(cwd ? { cwd } : {}),
    });
    const models = knownModels ?? await this.listModels();
    const configuredModel = typeof result.config.model === "string" && result.config.model.trim()
      ? result.config.model : null;
    const fallback = models.find(model => model.isDefault);
    const model = configuredModel ?? fallback?.model;
    if (!model) throw new Error("Codex 没有返回默认模型，请先用 /model 选择模型。");
    const catalogModel = models.find(entry => entry.model === model);
    const reasoningEffort = typeof result.config.model_reasoning_effort === "string"
      ? result.config.model_reasoning_effort
      : catalogModel?.defaultReasoningEffort ?? null;
    return { model, reasoningEffort };
  }

  async setThreadModelSettings(threadId: string, preferences: ModelPreferences): Promise<void> {
    const params = { threadId, model: preferences.model, effort: preferences.reasoningEffort };
    try {
      await this.request("thread/settings/update", params);
    } catch (error) {
      // This endpoint only updates loaded threads. Resume without overrides so
      // the saved cwd, approval policy and sandbox remain the thread's own.
      const message = error instanceof Error ? error.message : "";
      if (message !== `thread not found: ${threadId}` && message !== `thread not loaded: ${threadId}`) throw error;
      await this.resumeThread(threadId);
      await this.request("thread/settings/update", params);
    }
    const updated = await this.readThread(threadId);
    if (updated.model !== preferences.model || updated.reasoningEffort !== preferences.reasoningEffort) {
      throw new Error("Codex 未确认所选模型和思考强度，设置可能仅部分生效；请重新打开菜单核对。");
    }
  }

  async startThread(cwd: string, preferences?: ModelPreferences): Promise<CodexThreadSummary> {
    const result = await this.request<{ thread: CodexThreadSummary }>("thread/start", {
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ...(preferences ? {
        model: preferences.model,
        config: { model_reasoning_effort: preferences.reasoningEffort },
      } : {}),
    });
    return result.thread;
  }

  async resumeThread(threadId: string): Promise<CodexThreadSummary> {
    const result = await this.request<{ thread: CodexThreadSummary }>("thread/resume", {
      threadId,
    });
    return result.thread;
  }

  async startTurn(threadId: string, prompt: string): Promise<{ id: string }> {
    const result = await this.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
    });
    return result.turn;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.request("thread/archive", { threadId });
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.request("thread/name/set", { threadId, name });
  }

  /** Empty threads are omitted from Codex's recent list until a user event exists. */
  async initializeNamedThread(threadId: string, name: string): Promise<void> {
    const stored = await this.readThread(threadId, true);
    if (stored.turns?.some(turn => turn.items?.some(item => item.type === "userMessage"))) return;
    let timer: NodeJS.Timeout;
    let onNotification: (message: { method: string; params?: Record<string, unknown> }) => void;
    const completion = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("创建确认暂未完成，将保留会话并重试。")), 60_000);
      onNotification = message => {
        if (message.method !== "turn/completed" || message.params?.threadId !== threadId) return;
        const turn = message.params.turn as { status?: string; error?: { message?: string } } | undefined;
        if (turn?.status === "failed") reject(new Error(turn.error?.message ?? "创建确认失败"));
        else resolve();
      };
      this.on("notification", onNotification);
    });
    // Attach a rejection handler before the start request, which can itself fail.
    void completion.catch(() => {});
    try {
      await this.startTurn(threadId, `从 Discord 创建会话「${name}」。请只回复“会话已创建”，不要调用工具或执行其他任务，等待我的后续消息。`);
      await completion;
    } finally { clearTimeout(timer!); this.off("notification", onNotification!); }
  }

  async unarchiveThread(threadId: string): Promise<void> {
    await this.request("thread/unarchive", { threadId });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.request("thread/delete", { threadId });
  }

  async readRateLimits(): Promise<CodexRateLimitsResponse> {
    return this.request<CodexRateLimitsResponse>("account/rateLimits/read", {});
  }
}

/** Runtime writers are isolated so exiting one conversation never closes another. */
export class CodexAppServerPool extends CodexAppServerClient {
  private runtimes = new Map<string, CodexAppServerClient>();
  private closing = new Map<string, Promise<void>>();
  private responseOwners = new Map<number, { client: CodexAppServerClient; id: number }>();
  private nextServerRequestId = 1;

  constructor(private readonly createRuntime = () => new CodexAppServerClient()) { super(); }

  private createWriter(): CodexAppServerClient {
    const client = this.createRuntime();
    client.on("notification", message => this.emit("notification", message));
    client.on("stderr", line => this.emit("stderr", line));
    client.on("serverRequest", (message: JsonRpcServerRequest) => {
      const id = this.nextServerRequestId++;
      this.responseOwners.set(id, { client, id: message.id });
      this.emit("serverRequest", { ...message, id });
    });
    client.on("exit", () => {
      for (const [threadId, owner] of this.runtimes) if (owner === client) {
        this.runtimes.delete(threadId);
        this.emit("notification", { method: "thread/closed", params: { threadId } });
      }
      for (const [id, owner] of this.responseOwners) if (owner.client === client) this.responseOwners.delete(id);
    });
    return client;
  }

  private async writer(threadId: string): Promise<CodexAppServerClient> {
    await this.closing.get(threadId);
    let client = this.runtimes.get(threadId);
    if (!client) { client = this.createWriter(); this.runtimes.set(threadId, client); }
    return client;
  }

  override async startThread(cwd: string, preferences?: ModelPreferences): Promise<CodexThreadSummary> {
    const client = this.createWriter();
    try {
      const thread = await client.startThread(cwd, preferences);
      this.runtimes.set(thread.id, client);
      return thread;
    } catch (error) { await client.close(); throw error; }
  }

  override async resumeThread(threadId: string): Promise<CodexThreadSummary> {
    const client = await this.writer(threadId);
    try { return await client.resumeThread(threadId); }
    catch (error) { await this.releaseThread(threadId); throw error; }
  }

  override async startTurn(threadId: string, prompt: string): Promise<{ id: string }> {
    return (await this.writer(threadId)).startTurn(threadId, prompt);
  }

  override async interruptTurn(threadId: string, turnId: string): Promise<void> {
    return (await this.writer(threadId)).interruptTurn(threadId, turnId);
  }

  override async setThreadModelSettings(threadId: string, preferences: ModelPreferences): Promise<void> {
    const client = await this.writer(threadId);
    try { await client.setThreadModelSettings(threadId, preferences); }
    catch (error) { await this.releaseThread(threadId); throw error; }
  }

  override async respond(id: number, result: Record<string, unknown>): Promise<void> {
    const owner = this.responseOwners.get(id);
    if (!owner) return; // The owning runtime has already exited; stale approvals are inert.
    try { await owner.client.respond(owner.id, result); }
    finally { this.responseOwners.delete(id); }
  }

  async releaseThread(threadId: string): Promise<void> {
    const pending = this.closing.get(threadId);
    if (pending) return pending;
    const client = this.runtimes.get(threadId);
    if (!client) return;
    const closing = client.close();
    this.closing.set(threadId, closing);
    try {
      await closing;
      if (this.runtimes.get(threadId) === client) this.runtimes.delete(threadId);
    }
    finally {
      this.closing.delete(threadId);
    }
  }

  override async archiveThread(threadId: string): Promise<void> {
    const client = this.runtimes.get(threadId);
    if (client) { await client.archiveThread(threadId); await this.releaseThread(threadId); }
    else await super.archiveThread(threadId);
  }

  override async setThreadName(threadId: string, name: string): Promise<void> {
    const client = this.runtimes.get(threadId);
    if (client) await client.setThreadName(threadId, name);
    else await super.setThreadName(threadId, name);
  }

  override async initializeNamedThread(threadId: string, name: string): Promise<void> {
    const client = await this.writer(threadId);
    await client.resumeThread(threadId);
    await client.initializeNamedThread(threadId, name);
  }

  override async deleteThread(threadId: string): Promise<void> {
    const client = this.runtimes.get(threadId);
    if (client) { await client.deleteThread(threadId); await this.releaseThread(threadId); }
    else await super.deleteThread(threadId);
  }

  override async unarchiveThread(threadId: string): Promise<void> {
    const client = await this.writer(threadId);
    try { await client.unarchiveThread(threadId); }
    finally { await this.releaseThread(threadId); }
  }

  override async close(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map(id => this.releaseThread(id)));
    await super.close();
  }
}

export const codexAppServer = new CodexAppServerPool();
