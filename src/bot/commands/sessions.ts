import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getProject, getSession } from "../../db/database.js";
import { listStoredThreads } from "../../codex/storage.js";
import { L } from "../../utils/i18n.js";
import { getHub } from "../../db/channel-conversations.js";

interface SessionInfo {
  sessionId: string;
  preview: string;
  timestamp: string;
  source: string;
}

function isInternalSession(source: string): boolean {
  if (source === "subagent") return true;
  try {
    const parsed: unknown = JSON.parse(source);
    return Boolean(parsed && typeof parsed === "object" && "subagent" in parsed);
  } catch { return false; }
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = { vscode: "Codex 桌面/编辑器", cli: "Codex CLI", appServer: "Codex 连接", exec: "Codex 任务" };
  return labels[source] ?? "Codex 会话";
}

function menuText(value: string, limit: number): string {
  let result = "";
  for (const character of value.replace(/\s+/g, " ").trim()) {
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result;
}

export function findSessionDir(projectPath: string): string | null {
  const first = listStoredThreads(projectPath)[0];
  return first?.rollout_path ? path.dirname(first.rollout_path) : null;
}

export async function getLastAssistantMessage(filePath: string): Promise<string> {
  const full = await getLastAssistantMessageFull(filePath);
  if (full === "(no message)") return full;
  const lines = full.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] || full.slice(-200);
}

export async function getLastAssistantMessageFull(filePath: string): Promise<string> {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lastText = "";

  for await (const line of rl) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "response_item" && entry.payload?.type === "message") {
        const content = entry.payload?.content ?? [];
        const text = Array.isArray(content)
          ? content
              .map((item: { text?: string }) => item?.text ?? "")
              .join("")
              .trim()
          : "";
        if (text) lastText = text;
      }

      if (entry.type === "item_completed" && entry.item?.type === "agentMessage" && typeof entry.item.text === "string") {
        const text = entry.item.text.trim();
        if (text) lastText = text;
      }
    } catch {
      // skip malformed lines
    }
  }

  rl.close();
  stream.destroy();
  return lastText || "(no message)";
}

export async function listSessions(projectPath?: string): Promise<SessionInfo[]> {
  return listStoredThreads(projectPath).filter(thread => !isInternalSession(thread.source)).map((thread) => ({
    sessionId: thread.id,
    preview: thread.title || "(empty session)",
    timestamp: new Date(thread.updated_at * 1000).toISOString(),
    source: thread.source,
  }));
}

export const data = new SlashCommandBuilder()
  .setName("sessions")
  .setDescription("命名新建会话，或打开电脑历史会话的对应频道");

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await showSessions(interaction);
}

export async function showSessions(interaction: ChatInputCommandInteraction | ButtonInteraction, requestedPage = 0): Promise<void> {
  const channelId = interaction.channelId;
  const project = getProject(channelId);
  const hub = interaction.guildId ? getHub(interaction.guildId) : undefined;

  if (!project && !hub) {
    await interaction.editReply({
      content: "CodeX 尚未初始化，请稍后重试 /sessions。",
    });
    return;
  }

  const parentProject = project?.parent_channel_id ? getProject(project.parent_channel_id) : project;
  const importMode = Boolean(hub) || Boolean(project?.parent_channel_id) || parentProject?.chat_mode === "threads";
  const sessions = await listSessions(importMode ? undefined : project!.project_path);
  const pages = Math.max(1, Math.ceil(sessions.length / 24));
  const page = Math.max(0, Math.min(pages - 1, requestedPage));

  if (sessions.length === 0 && !hub) {
    await interaction.editReply({
      embeds: [
        {
          title: L("✨ New Session", "✨ 새 세션"),
          description: L(
            `No existing Codex sessions found for \`${project!.project_path}\`.\nSend a new task in this channel to start a conversation.`,
            `\`${project!.project_path}\`에 대한 기존 Codex 세션이 없습니다.\n새 세션이 준비되었습니다 — 다음 메시지부터 새로운 대화가 시작됩니다.`
          ),
          color: 0x00ff00,
        },
      ],
    });
    return;
  }

  const dbSession = getSession(channelId);
  const activeSessionId = dbSession?.session_id ?? null;

  const options: Array<{ label: string; description: string; value: string; default?: boolean }> = [
    {
      label: "✨ 创建新会话",
      description: hub ? "输入会话名，同时创建电脑会话和 CodeX 频道" : importMode ? "在主频道建立新入口和独立子区" : "在本频道开始新的 Codex 会话",
      value: "__new_session__",
    },
  ];

  for (const session of sessions.slice(page * 24, (page + 1) * 24)) {
    const preview = menuText(session.preview, 90);
    const date = new Date(session.timestamp).toLocaleString();
    options.push({
      label: preview || "(empty session)",
      description: menuText(`${sourceLabel(session.source)} • ${date}`, 100),
      value: session.sessionId,
      ...(activeSessionId === session.sessionId ? { default: true } : {}),
    });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("session-select")
    .setPlaceholder(hub ? "新建命名会话，或选择历史会话打开频道" : importMode ? "选择最近会话，打开子区并导入最近对话" : "选择要查看或继续的会话")
    .addOptions(options);

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const navigation = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`session-page:${Math.max(0, page - 1)}`).setLabel("上一页").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`session-page:${Math.min(pages - 1, page + 1)}`).setLabel("下一页").setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
  );

  await interaction.editReply({
    embeds: [
      {
        title: `最近 Codex 会话 · 第 ${page + 1}/${pages} 页`,
        description: `${importMode ? "范围：本机全部未归档会话，保留每个会话原来的工作目录。" : `项目：\`${project!.project_path}\``}\n共 ${sessions.length} 个会话。\n${hub
          ? "新建时输入会话名；选择历史会话会打开或创建 CodeX 同名频道，首次同步最近 20 轮。在频道内直接发消息即可继续。"
          : importMode
          ? "选择已有会话后，在主频道建立入口消息和对应子区，同步最近 20 轮对话；已有子区则直接打开。"
          : "选择会话查看最近回复，点击继续后在本频道聊天。"}\n删除或归档请在对应会话使用 /delete 或 /archive。`,
        color: 0x5865f2,
      },
    ],
    components: pages > 1 ? [row, navigation] : [row],
  });
}
