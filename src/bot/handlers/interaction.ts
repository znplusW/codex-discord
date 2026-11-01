import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type TextChannel,
} from "discord.js";
import { isAllowedUser } from "../../security/guard.js";
import { sessionManager } from "../../codex/session-manager.js";
import { selectSession, getProject } from "../../db/database.js";
import { codexAppServer } from "../../codex/app-server-client.js";
import { getStoredThread } from "../../codex/storage.js";
import { L } from "../../utils/i18n.js";
import { openConversationThread } from "../conversation-threads.js";
import { withConversationLock } from "../conversation-lock.js";
import { showMode } from "../commands/switch.js";
import { handleConversationDeleteButton } from "../commands/conversation-lifecycle.js";
import { handleModelPickerButton, handleModelPickerSelect } from "../commands/model-picker.js";
import { importConversationHistory } from "../conversation-history.js";
import { showSessions } from "../commands/sessions.js";
import { getHub } from "../../db/channel-conversations.js";
import { openConversationChannel } from "../conversation-channels.js";
import { showNewSessionModal } from "../session-modal.js";
import { handleBatchInteraction } from "../commands/batch-lifecycle.js";

export async function handleButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: L("You are not authorized.", "권한이 없습니다."),
      ephemeral: true,
    });
    return;
  }

  if (await handleModelPickerButton(interaction)) return;
  if (await handleBatchInteraction(interaction)) return;
  if (await handleConversationDeleteButton(interaction)) return;

  const customId = interaction.customId;
  const colonIndex = customId.indexOf(":");
  const action = colonIndex === -1 ? customId : customId.slice(0, colonIndex);
  const requestId = colonIndex === -1 ? "" : customId.slice(colonIndex + 1);

  if (!requestId) {
    await interaction.reply({
      content: L("Invalid button interaction.", "잘못된 버튼 상호작용입니다."),
      ephemeral: true,
    });
    return;
  }

  if (action === "chat-mode" && (requestId === "threads" || requestId === "channel")) {
    await interaction.deferUpdate();
    await showMode(interaction, requestId);
    return;
  }

  if (action === "session-page" && /^\d+$/.test(requestId)) {
    await interaction.deferUpdate();
    await showSessions(interaction, Number(requestId));
    return;
  }

  if (action === "stop") {
    const stopped = await sessionManager.stopSession(requestId);
    await interaction.update({
      content: L("⏹️ Task has been stopped.", "⏹️ 작업이 중지되었습니다."),
      components: [],
    });
    if (!stopped) {
      await interaction.followUp({
        content: L("No active session.", "활성 세션이 없습니다."),
        ephemeral: true,
      });
    }
    return;
  }

  if (action === "queue-yes") {
    const confirmed = sessionManager.confirmQueue(requestId);
    if (!confirmed) {
      await interaction.update({
        content: L("⏳ Queue request has expired.", "⏳ 큐 요청이 만료되었습니다."),
        components: [],
      });
      return;
    }
    const queueSize = sessionManager.getQueueSize(requestId);
    await interaction.update({
      content: L(`📨 Message added to queue (${queueSize}/5). It will be processed after the current task.`, `📨 메시지가 큐에 추가되었습니다 (${queueSize}/5). 이전 작업 완료 후 자동으로 처리됩니다.`),
      components: [],
    });
    return;
  }

  if (action === "queue-no") {
    sessionManager.cancelQueue(requestId);
    await interaction.update({
      content: L("Cancelled.", "취소되었습니다."),
      components: [],
    });
    return;
  }

  if (action === "session-resume") {
    await openSelectedConversation(interaction, requestId);
    return;
  }

  if (action === "session-cancel") {
    await interaction.update({
      content: L("Cancelled.", "취소되었습니다."),
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "ask-opt") {
    const lastColon = requestId.lastIndexOf(":");
    const actualRequestId = requestId.slice(0, lastColon);
    const selectedLabel = ("label" in interaction.component ? interaction.component.label : null) ?? "Unknown";

    const resolved = sessionManager.resolveQuestion(actualRequestId, selectedLabel);
    if (!resolved) {
      await interaction.reply({ content: L("This question has expired.", "이 질문은 만료되었습니다."), ephemeral: true });
      return;
    }

    await interaction.update({
      content: L(`✅ Selected: **${selectedLabel}**`, `✅ 선택됨: **${selectedLabel}**`),
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "ask-other") {
    sessionManager.enableCustomInput(requestId, interaction.channelId);
    await interaction.update({
      content: L("✏️ Type your answer...", "✏️ 답변을 입력하세요..."),
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "queue-clear") {
    const cleared = sessionManager.clearQueue(requestId);
    await interaction.update({
      embeds: [
        {
          title: L("Queue Cleared", "큐 초기화됨"),
          description: L(`Cleared ${cleared} queued message(s).`, `${cleared}개의 대기 중이던 메시지를 취소했습니다.`),
          color: 0xff6600,
        },
      ],
      components: [],
    });
    return;
  }

  if (action === "queue-remove") {
    const lastColon = requestId.lastIndexOf(":");
    const channelId = requestId.slice(0, lastColon);
    const index = parseInt(requestId.slice(lastColon + 1), 10);
    const removed = sessionManager.removeFromQueue(channelId, index);

    if (!removed) {
      await interaction.update({
        content: L("This item is no longer in the queue.", "이 항목은 이미 큐에 없습니다."),
        embeds: [],
        components: [],
      });
      return;
    }

    const preview = removed.length > 60 ? removed.slice(0, 60) + "…" : removed;
    const queue = sessionManager.getQueue(channelId);
    if (queue.length === 0) {
      await interaction.update({
        embeds: [
          {
            title: L("Message Removed", "메시지 취소됨"),
            description: L(`Removed: ${preview}\n\nQueue is now empty.`, `취소됨: ${preview}\n\n큐가 비었습니다.`),
            color: 0xff6600,
          },
        ],
        components: [],
      });
      return;
    }

    const list = queue
      .map((item: { prompt: string }, idx: number) => {
        const p = item.prompt.length > 100 ? item.prompt.slice(0, 100) + "…" : item.prompt;
        return `**${idx + 1}.** ${p}`;
      })
      .join("\n\n");

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    const itemButtons = queue.map((_: unknown, idx: number) =>
      new ButtonBuilder()
        .setCustomId(`queue-remove:${channelId}:${idx}`)
        .setLabel(`❌ ${idx + 1}`)
        .setStyle(ButtonStyle.Secondary)
    );
    const clearButton = new ButtonBuilder()
      .setCustomId(`queue-clear:${channelId}`)
      .setLabel(L("Clear All", "모두 취소"))
      .setStyle(ButtonStyle.Danger);

    const allButtons = [...itemButtons.slice(0, 19), clearButton];
    for (let i = 0; i < allButtons.length; i += 5) {
      const chunk = allButtons.slice(i, i + 5);
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...chunk));
    }

    await interaction.update({
      embeds: [
        {
          title: L(`📋 Message Queue (${queue.length})`, `📋 메시지 큐 (${queue.length}개)`),
          description: `~~${preview}~~ ${L("removed", "취소됨")}\n\n${list}`,
          color: 0x5865f2,
        },
      ],
      components: rows,
    });
    return;
  }

  if (action === "session-delete") {
    await interaction.reply({ content: "请先恢复并进入这个会话，再使用 `/delete`。删除前会显示确认按钮。", ephemeral: true });
    return;
  }

  let decision: "approve" | "deny" | "approve-all";
  if (action === "approve") {
    decision = "approve";
  } else if (action === "deny") {
    decision = "deny";
  } else if (action === "approve-all") {
    decision = "approve-all";
  } else {
    return;
  }

  const resolved = sessionManager.resolveApproval(requestId, decision);
  if (!resolved) {
    await interaction.reply({
      content: L("This approval request has expired.", "이 승인 요청은 만료되었습니다."),
      ephemeral: true,
    });
    return;
  }

  const labels: Record<string, string> = {
    approve: L("✅ Approved", "✅ 승인됨"),
    deny: L("❌ Denied", "❌ 거부됨"),
    "approve-all": L("⚡ Auto-approve enabled for this channel", "⚡ 이 채널에서 자동 승인이 활성화되었습니다"),
  };

  await interaction.update({
    content: labels[decision],
    components: [],
  });
}

export async function handleSelectMenuInteraction(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: L("You are not authorized.", "권한이 없습니다."),
      ephemeral: true,
    });
    return;
  }

  if (await handleModelPickerSelect(interaction)) return;
  if (await handleBatchInteraction(interaction)) return;

  if (interaction.customId.startsWith("ask-select:")) {
    const askRequestId = interaction.customId.slice("ask-select:".length);
    const options = (interaction.component as any).options ?? [];
    const selectedLabels = interaction.values.map((val: string) => {
      const opt = options.find((o: any) => o.value === val);
      return opt?.label ?? val;
    });
    const answer = selectedLabels.join(", ");

    const resolved = sessionManager.resolveQuestion(askRequestId, answer);
    if (!resolved) {
      await interaction.reply({ content: L("This question has expired.", "이 질문은 만료되었습니다."), ephemeral: true });
      return;
    }

    await interaction.update({
      content: L(`✅ Selected: **${answer}**`, `✅ 선택됨: **${answer}**`),
      embeds: [],
      components: [],
    });
    return;
  }

  if (interaction.customId !== "session-select") return;

  const selectedSessionId = interaction.values[0];

  if (selectedSessionId === "__new_session__") {
    if (interaction.guildId && getHub(interaction.guildId)) {
      await showNewSessionModal(interaction);
      return;
    }
    await openSelectedConversation(interaction, null);
    return;
  }

  const project = getProject(interaction.channelId);
  const parent = project?.parent_channel_id ? getProject(project.parent_channel_id) : project;
  if ((interaction.guildId && getHub(interaction.guildId)) || project?.parent_channel_id || parent?.chat_mode === "threads") {
    await openSelectedConversation(interaction, selectedSessionId);
    return;
  }

  await interaction.deferUpdate();
  if (!project || getStoredThread(selectedSessionId)?.cwd !== project.project_path) {
    await interaction.editReply({ content: "该会话已不存在，或不属于当前项目。请重新打开 `/sessions`。", embeds: [], components: [] });
    return;
  }
  const thread = await codexAppServer.readThread(selectedSessionId, true);
  let lastMessage = "";
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        lastMessage = item.text.trim();
      }
    }
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`session-resume:${selectedSessionId}`)
      .setLabel(L("Resume", "재개"))
      .setStyle(ButtonStyle.Success)
      .setEmoji("▶️"),
    new ButtonBuilder()
      .setCustomId(`session-cancel:${selectedSessionId}`)
      .setLabel(L("Cancel", "취소"))
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({
    embeds: [
      {
        title: L("Codex Session", "Codex 세션"),
        description: [
          `ID: \`${selectedSessionId.slice(0, 8)}...\``,
          lastMessage ? `${L("Last response", "마지막 응답")}:\n> ${lastMessage.slice(0, 800)}` : L("No assistant response yet.", "아직 assistant 응답이 없습니다."),
        ].join("\n\n"),
        color: 0x5865f2,
      },
    ],
    components: [row],
  });
}

async function openSelectedConversation(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  sessionId: string | null,
): Promise<void> {
  if (interaction.guildId && getHub(interaction.guildId)) {
    await interaction.deferUpdate();
    try {
      if (!sessionId) throw new Error("请重新打开 /sessions 并选择创建新会话。");
      const guild = await interaction.client.guilds.fetch(interaction.guildId);
      const result = await openConversationChannel(guild, sessionId);
      await interaction.editReply({ content: `${result.reused ? "已打开对应会话频道" : "会话频道已建立"}：<#${result.channel.id}>。直接在频道聊天即可继续原会话。${result.warning ? `\n${result.warning}` : ""}`,
        embeds: [], components: [], allowedMentions: { parse: [] } });
    } catch (error) {
      await interaction.editReply({ content: `无法打开会话：${error instanceof Error ? error.message : String(error)}`, embeds: [], components: [], allowedMentions: { parse: [] } });
    }
    return;
  }
  const source = getProject(interaction.channelId);
  const project = source?.parent_channel_id ? getProject(source.parent_channel_id) : source;
  if (!project) {
    await interaction.reply({
      content: "请在已注册的频道或对应子区使用此菜单。",
      ephemeral: true,
    });
    return;
  }
  await interaction.deferUpdate();
  await withConversationLock(project.channel_id, async () => {
    const channelMode = !source?.parent_channel_id && getProject(project.channel_id)?.chat_mode === "channel";
    if (channelMode && (sessionManager.isActive(project.channel_id) || sessionManager.hasQueue(project.channel_id) || sessionManager.getQueueSize(project.channel_id) > 0)) {
      await interaction.editReply({ content: "当前会话仍有任务运行或排队，请完成或取消后再切换会话。", embeds: [], components: [] });
      return;
    }
    const stored = sessionId ? getStoredThread(sessionId) : null;
    if (sessionId && (!stored || !stored.cwd || stored.archived || (channelMode && stored.cwd !== project.project_path))) {
      await interaction.editReply({ content: "该会话已不存在，或不属于当前项目。请重新打开 `/sessions`。", embeds: [], components: [] });
      return;
    }
    if (channelMode) {
      selectSession(project.channel_id, sessionId);
      await interaction.editReply({ content: sessionId
        ? "已切换当前会话。直接在本频道发送消息即可继续。"
        : "已准备新会话。直接在本频道发送消息即可开始。", embeds: [], components: [] });
      return;
    }
    try {
      const channel = interaction.channelId === project.channel_id
        ? interaction.channel : await interaction.client.channels.fetch(project.channel_id);
      if (!channel || channel.type !== ChannelType.GuildText) throw new Error("无法访问对应主频道。");
      if (sessionId) {
        const result = await importConversationHistory(channel as TextChannel, interaction.user.id, sessionId);
        await interaction.editReply({ content: `${result.reused ? "已打开原会话子区" : "会话入口已创建"}：<#${result.thread.id}>。${result.synced ? `已同步 ${result.synced} 段最近对话。` : ""}\n${result.warning ?? result.notice ?? "进入子区发消息即可继续原 Codex 会话。"}`, embeds: [], components: [], allowedMentions: { parse: [] } });
      } else {
        const starter = await (channel as TextChannel).send({ content: "**Codex 新会话**\n进入此消息的子区发送第一条任务。", allowedMentions: { parse: [] } });
        const thread = await openConversationThread(starter, interaction.user.id, "Codex 新会话");
        await interaction.editReply({ content: `新会话已就绪：<#${thread.id}>。进入子区发送任务即可开始。`, embeds: [], components: [] });
      }
    } catch (error) {
      await interaction.editReply({ content: `无法打开会话：${error instanceof Error ? error.message : "请稍后重试。"}`, embeds: [], components: [], allowedMentions: { parse: [] } });
    }
  });
}
