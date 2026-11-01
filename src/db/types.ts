export type SessionStatus = "online" | "offline" | "waiting" | "idle";

export interface ModelPreferences {
  model: string;
  reasoningEffort: string | null;
}

export interface Project {
  channel_id: string;
  project_path: string;
  guild_id: string;
  auto_approve: number;
  parent_channel_id: string | null;
  chat_mode: "threads" | "channel";
  conversation_state: "active" | "archived" | "deleted";
  fixed_session?: number;
  created_at: string;
}

export interface Session {
  id: string;
  channel_id: string;
  session_id: string | null; // Codex thread ID
  status: SessionStatus;
  last_activity: string | null;
  created_at: string;
}
