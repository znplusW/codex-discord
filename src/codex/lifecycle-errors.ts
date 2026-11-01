export function isWriterConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\balready has an active writer\b/i.test(message);
}

/** A retry cannot release another app's writer. Give the required condition. */
export function describeLifecycleFailure(error: unknown): string {
  if (isWriterConflict(error)) {
    return "会话仍被 Codex 桌面端或其他应用占用，操作未完成。请先退出占用该会话的应用；释放后后台会自动续办。Discord 的 /exit 只能释放机器人自身的占用。";
  }
  return error instanceof Error ? error.message : String(error);
}
