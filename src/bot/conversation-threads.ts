import { randomUUID } from "node:crypto";
import { ChannelType, ThreadAutoArchiveDuration, type Message, type TextChannel, type ThreadChannel } from "discord.js";
import { findSessionThread, getProject, getSession, registerThreadProject, upsertSession } from "../db/database.js";

export type ConversationChannel = TextChannel | ThreadChannel;

export function conversationName(text: string): string {
  return Array.from(text.replace(/<@!?\d+>/g, "").replace(/\s+/g, " ").trim())
    .slice(0, 90).join("") || "Codex 新会话";
}

/** The starter message ID is also the Discord thread ID, so retries can recover it. */
export async function openConversationThread(
  message: Message,
  userId: string,
  title: string,
  sessionId: string | null = null,
  originalProjectPath?: string,
): Promise<ThreadChannel> {
  const parent = getProject(message.channelId);
  if (!parent || parent.parent_channel_id || message.channel.type !== ChannelType.GuildText) {
    throw new Error("请在已注册的主频道创建会话。");
  }

  const mappedThreadId = sessionId ? findSessionThread(message.channelId, sessionId) : undefined;
  let thread: ThreadChannel | null = null;
  try {
    thread = await message.channel.threads.fetch(mappedThreadId ?? message.id);
  } catch (error) {
    if ((error as { code?: number }).code !== 10003) throw error; // Unknown Channel
  }
  if (!thread) {
    thread = await message.startThread({
      name: conversationName(title),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: "独立 Codex 会话",
    });
  }
  registerThreadProject(thread.id, message.channelId, originalProjectPath);
  if (!getSession(thread.id)) {
    upsertSession(randomUUID(), thread.id, sessionId, "idle");
    console.log(`[conversation] Bound Discord thread ${thread.id} to project channel ${message.channelId}`);
  }
  if (thread.archived && !thread.locked) await thread.setArchived(false);
  // Membership makes the conversation easier to find in the mobile thread list.
  await thread.members.add(userId).catch((error: unknown) => {
    console.warn(`[conversation] Could not add member to thread ${thread!.id}:`, error instanceof Error ? error.message : error);
  });
  return thread;
}
