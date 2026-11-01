import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Collection,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type Interaction,
} from "discord.js";
import { getConfig } from "../utils/config.js";
import { handleMessage } from "./handlers/message.js";
import { handleButtonInteraction, handleSelectMenuInteraction } from "./handlers/interaction.js";
import { isAllowedUser } from "../security/guard.js";
import { L } from "../utils/i18n.js";
import * as statusCmd from "./commands/status.js";
import * as stopCmd from "./commands/stop.js";
import * as autoApproveCmd from "./commands/auto-approve.js";
import * as sessionsCmd from "./commands/sessions.js";
import * as multiDeleteCmd from "./commands/multi-delete.js";
import * as multiArchiveCmd from "./commands/multi-archive.js";
import * as lastCmd from "./commands/last.js";
import * as queueCmd from "./commands/queue.js";
import * as usageCmd from "./commands/usage.js";
import * as archiveCmd from "./commands/archive.js";
import * as deleteCmd from "./commands/delete.js";
import * as modelCmd from "./commands/model.js";
import * as reasoningCmd from "./commands/reasoning.js";
import * as syncCmd from "./commands/sync.js";
import * as exitCmd from "./commands/exit.js";
import * as restoreCmd from "./commands/restore.js";
import { initializeConversationHub, migrateLegacyConversations } from "./conversation-channels.js";
import { startManagedSync } from "./managed-sync.js";
import { handleSessionModal } from "./session-modal.js";
import { detachManagedChannel, getManagedChannel, getHub, getManagedConversation } from "../db/channel-conversations.js";
import { unregisterProject, getProject, getSession } from "../db/database.js";
import { sessionManager } from "../codex/session-manager.js";

export const commands = [statusCmd, stopCmd, autoApproveCmd, sessionsCmd, multiDeleteCmd, multiArchiveCmd, lastCmd, queueCmd, usageCmd, archiveCmd, deleteCmd, modelCmd, reasoningCmd, syncCmd, exitCmd, restoreCmd];
const commandMap = new Collection<
  string,
  {
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
    autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
  }
>();

for (const cmd of commands) {
  commandMap.set(cmd.data.name, cmd);
}

export async function startBot(): Promise<Client> {
  const config = getConfig();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once("ready", async () => {
    console.log(`Bot logged in as ${client.user?.tag}`);
    try {
      const rest = new REST({ version: "10" }).setToken(config.DISCORD_BOT_TOKEN);
      const commandData = await Promise.all(commands.map(c =>
        c.data.name === "model" ? modelCmd.registrationData() : c.data.toJSON(),
      ));
      await rest.put(
        Routes.applicationGuildCommands(
          (await rest.get(Routes.currentApplication()) as { id: string }).id,
          config.DISCORD_GUILD_ID,
        ),
        { body: commandData },
      );
      console.log(`Registered ${commandData.length} slash commands`);
    } catch (error) {
      console.error("Failed to register slash commands:", error);
    }
    let stopSync: (() => void) | undefined;
    const initialize = async () => {
      try {
        await initializeConversationHub(client, config.DISCORD_GUILD_ID);
        stopSync?.();
        stopSync = startManagedSync(client, config.DISCORD_GUILD_ID);
        console.log("[channels] CodeX hub ready; lifecycle checks every 10 seconds");
        await migrateLegacyConversations(client, config.DISCORD_GUILD_ID);
      } catch (error) {
        console.error("[channels] Initialization pending:", error instanceof Error ? error.message : String(error));
        const retry = setTimeout(() => void initialize(), 30_000);
        retry.unref();
      }
    };
    void initialize();
  });

  client.on("interactionCreate", async (interaction: Interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        if (!isAllowedUser(interaction.user.id)) {
          await interaction.respond([]);
          return;
        }
        const command = commandMap.get(interaction.commandName);
        if (command?.autocomplete) {
          await command.autocomplete(interaction);
        } else {
          await interaction.respond([]);
        }
        return;
      }

      if (interaction.isModalSubmit()) {
        await handleSessionModal(interaction);
      } else if (interaction.isChatInputCommand()) {
        if (!isAllowedUser(interaction.user.id)) {
          await interaction.reply({
            content: L("You are not authorized to use this bot.", "이 봇을 사용할 권한이 없습니다."),
            flags: ["Ephemeral"],
          });
          return;
        }

        await interaction.deferReply({ flags: ["Ephemeral"] });

        if (interaction.guildId && getHub(interaction.guildId) && !getProject(interaction.channelId)?.fixed_session
          && !["sessions", "status", "usage", "multi-delete", "multi-archive"].includes(interaction.commandName)) {
          const id = getSession(interaction.channelId)?.session_id;
          const channel = id ? getManagedConversation(interaction.guildId, id)?.channel_id : undefined;
          await interaction.editReply({ content: channel ? `请进入对应会话频道 <#${channel}> 使用此命令。` : "请先用 /sessions 打开一个会话频道，再操作该会话。", allowedMentions: { parse: [] } });
          return;
        }

        const command = commandMap.get(interaction.commandName);
        if (command) {
          await command.execute(interaction);
        }
      } else if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
      } else if (interaction.isStringSelectMenu()) {
        await handleSelectMenuInteraction(interaction);
      }
    } catch (error) {
      console.error("Interaction error:", error);
      const content = L("An error occurred while processing your command.", "명령을 처리하는 중 오류가 발생했습니다.");
      try {
        if (interaction.isRepliable()) {
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content, flags: ["Ephemeral"] });
          } else {
            await interaction.reply({ content, flags: ["Ephemeral"] });
          }
        }
      } catch {
        // ignore
      }
    }
  });

  client.on("messageCreate", async (message) => {
    try {
      await handleMessage(message);
    } catch (error) {
      console.error("messageCreate error:", error);
      try {
        if (message.channel.isSendable()) {
          await message.reply(L("An error occurred while processing your message.", "메시지를 처리하는 중 오류가 발생했습니다."));
        }
      } catch {
        // ignore
      }
    }
  });

  client.on("channelDelete", async channel => {
    if (!getManagedChannel(channel.id)) return;
    try {
      await sessionManager.exitSession(channel.id);
      detachManagedChannel(channel.id);
      unregisterProject(channel.id);
    } catch (error) { console.warn("[channels] Detached channel cleanup pending:", String(error)); }
  });

  client.on("error", (error) => {
    console.error("Discord client error:", error);
  });
  client.on("warn", (warning) => {
    console.warn("Discord warning:", warning);
  });
  client.on("shardDisconnect", (event, shardId) => {
    console.warn(`Shard ${shardId} disconnected (code ${event.code}). Reconnecting...`);
  });
  client.on("shardReconnecting", (shardId) => {
    console.log(`Shard ${shardId} reconnecting...`);
  });
  client.on("shardResume", (shardId, replayedEvents) => {
    console.log(`Shard ${shardId} resumed (${replayedEvents} events replayed)`);
  });
  client.on("shardError", (error, shardId) => {
    console.error(`Shard ${shardId} error:`, error);
  });

  await loginWithRetry(client, config.DISCORD_BOT_TOKEN);
  return client;
}

async function loginWithRetry(client: Client, token: string): Promise<void> {
  const delays = [5, 10, 15, 30, 30, 30];
  let attempt = 0;

  while (true) {
    try {
      await client.login(token);
      if (attempt > 0) {
        console.log(`Discord login successful after ${attempt} retries`);
      }
      return;
    } catch (error) {
      attempt++;
      const delay = delays[Math.min(attempt - 1, delays.length - 1)];
      console.error(`Discord login attempt ${attempt} failed: ${(error as Error).message}`);
      console.error(`Retrying in ${delay}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    }
  }
}
