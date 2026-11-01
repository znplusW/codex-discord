import { Message, ChannelType, Attachment, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { getProject, getSession } from "../../db/database.js";
import { openConversationThread, type ConversationChannel } from "../conversation-threads.js";
import { withConversationLock } from "../conversation-lock.js";
import { isAllowedUser, checkRateLimit } from "../../security/guard.js";
import { sessionManager } from "../../codex/session-manager.js";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { L } from "../../utils/i18n.js";
import { getHub, getManagedConversation } from "../../db/channel-conversations.js";
import { openConversationChannel } from "../conversation-channels.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".msi", ".scr", ".pif",
  ".dll", ".sys", ".drv",
  ".vbs", ".vbe", ".wsf", ".wsh",
]);
const MAX_FILE_SIZE = 25 * 1024 * 1024;

async function downloadAttachment(
  attachment: Attachment,
  projectPath: string,
): Promise<{ filePath: string; isImage: boolean } | { skipped: string } | null> {
  const ext = path.extname(attachment.name ?? "").toLowerCase();

  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { skipped: L(`Blocked: \`${attachment.name}\` (dangerous file type)`, `차단됨: \`${attachment.name}\` (위험한 파일 형식)`) };
  }

  if (attachment.size > MAX_FILE_SIZE) {
    const sizeMB = (attachment.size / 1024 / 1024).toFixed(1);
    return { skipped: L(`Skipped: \`${attachment.name}\` (${sizeMB}MB exceeds 25MB limit)`, `건너뜀: \`${attachment.name}\` (${sizeMB}MB, 25MB 제한 초과)`) };
  }

  const uploadDir = path.join(projectPath, ".codex-uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const fileName = `${Date.now()}-${attachment.name}`;
  const filePath = path.join(uploadDir, fileName);

  try {
    const response = await fetch(attachment.url);
    if (!response.ok || !response.body) {
      return { skipped: L(`Failed to download: \`${attachment.name}\``, `다운로드 실패: \`${attachment.name}\``) };
    }

    const fileStream = fs.createWriteStream(filePath);
    await pipeline(Readable.fromWeb(response.body as never), fileStream);
  } catch (e) {
    console.warn(`[download] Failed to download attachment ${attachment.name}:`, e instanceof Error ? e.message : e);
    return { skipped: L(`Failed to download: \`${attachment.name}\``, `다운로드 실패: \`${attachment.name}\``) };
  }

  return { filePath, isImage: IMAGE_EXTENSIONS.has(ext) };
}

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot || message.system || !message.guild) return;

  const isThread = message.channel.isThread();
  const parentId = isThread ? message.channel.parentId : message.channelId;
  if (!parentId || !getProject(parentId)) return;
  if (!isThread && message.channel.type !== ChannelType.GuildText) return;

  if (!isAllowedUser(message.author.id)) {
    await message.reply(L("You are not authorized to use this bot.", "이 봇을 사용할 권한이 없습니다."));
    return;
  }

  if (!checkRateLimit(message.author.id)) {
    await message.reply(L("Rate limit exceeded. Please wait a moment.", "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요."));
    return;
  }

  // A root message becomes a thread with the same ID. Serialize its initial
  // prompt and quick follow-ups while keeping different conversations parallel.
  const key = isThread || getProject(parentId)?.chat_mode === "channel" ? message.channelId : message.id;
  await withConversationLock(key, () => processMessage(message));
}

async function processMessage(message: Message): Promise<void> {
  const project = getProject(message.channelId);
  if (!project) return; // Ignore unrelated, manually-created threads.
  const isThread = message.channel.isThread();
  if (getHub(message.guild!.id) && !project.fixed_session) {
    const sessionId = getSession(message.channelId)?.session_id;
    let target = sessionId ? getManagedConversation(message.guild!.id, sessionId)?.channel_id : null;
    if (sessionId && !target) {
      try { target = (await openConversationChannel(message.guild!, sessionId)).channel.id; }
      catch { /* Archived/deleted legacy chats are not silently restored. */ }
    }
    await message.reply({ content: target ? `此会话已迁移，请进入 <#${target}> 继续聊天。`
      : "会话现在使用 CodeX 下的独立频道。请使用 /sessions 新建或打开会话。", allowedMentions: { parse: [] } });
    return;
  }
  if (isThread && project.parent_channel_id !== message.channel.parentId) return;
  if ((isThread || project.fixed_session) && project.conversation_state !== "active") {
    await message.reply(project.conversation_state === "archived"
      ? "这个会话已归档。可用 `/restore` 恢复后继续。"
      : "这个会话已删除。请回到主频道新建会话。");
    return;
  }
  const createThread = !isThread && project.chat_mode === "threads";
  // A replayed root event must not submit the initial task a second time.
  if (createThread && getSession(message.id)?.session_id) return;

  if (sessionManager.hasPendingCustomInput(message.channelId)) {
    const text = message.content.trim();
    if (text) {
      sessionManager.resolveCustomInput(message.channelId, text);
      await message.react("✅");
    }
    return;
  }

  let prompt = message.content.trim();
  const imagePaths: string[] = [];
  const filePaths: string[] = [];
  const skippedMessages: string[] = [];

  for (const [, attachment] of message.attachments) {
    const result = await downloadAttachment(attachment, project.project_path);
    if (!result) continue;
    if ("skipped" in result) {
      skippedMessages.push(result.skipped);
      continue;
    }
    if (result.isImage) {
      imagePaths.push(result.filePath);
    } else {
      filePaths.push(result.filePath);
    }
  }

  if (skippedMessages.length > 0) {
    await message.reply(skippedMessages.join("\n"));
  }

  if (imagePaths.length > 0) {
    prompt += `\n\n[Attached images - inspect these local files]\n${imagePaths.join("\n")}`;
  }
  if (filePaths.length > 0) {
    prompt += `\n\n[Attached files - inspect these local files]\n${filePaths.join("\n")}`;
  }

  if (!prompt) return;

  const channel: ConversationChannel = createThread
    ? await openConversationThread(message, message.author.id, message.content || message.attachments.first()?.name || "Codex 新会话")
    : message.channel as ConversationChannel;
  const channelId = channel.id;

  if (sessionManager.isActive(channelId)) {
    if (sessionManager.hasQueue(channelId)) {
      await message.reply(L("⏳ A message is already waiting to be queued. Please press the button first.", "⏳ 이미 큐 추가 대기 중인 메시지가 있습니다. 버튼을 먼저 눌러주세요."));
      return;
    }
    if (sessionManager.isQueueFull(channelId)) {
      await message.reply(L("⏳ Queue is full (max 5). Please wait for the current task to finish.", "⏳ 큐가 가득 찼습니다 (최대 5개). 현재 작업 완료를 기다려주세요."));
      return;
    }

    sessionManager.setPendingQueue(channelId, channel, prompt);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`queue-yes:${channelId}`)
        .setLabel(L("Add to Queue", "큐에 추가"))
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅"),
      new ButtonBuilder()
        .setCustomId(`queue-no:${channelId}`)
        .setLabel(L("Cancel", "취소"))
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("❌"),
    );

    await message.reply({
      content: L("⏳ A previous task is in progress. Process this automatically when done?", "⏳ 이전 작업이 진행 중입니다. 완료 후 자동으로 처리할까요?"),
      components: [row],
    });
    return;
  }

  await sessionManager.sendMessage(channel, prompt);
}
