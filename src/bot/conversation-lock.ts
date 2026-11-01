const pending = new Map<string, Promise<unknown>>();

export async function withConversationLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  pending.set(key, current);
  try {
    return await current;
  } finally {
    if (pending.get(key) === current) pending.delete(key);
  }
}
