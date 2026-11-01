# v0.2.0-channel.1

[English](#english) | [简体中文](#简体中文)

## English

The first release of the channel-per-conversation fork.

### Highlights

- Private `CodeX` categories where every text channel is permanently bound to one Codex conversation.
- Named creation and import of existing desktop conversations through `/sessions`.
- Recent 20-round history import and durable earlier-history pagination.
- Model and reasoning-effort menus, isolated per-conversation writers, and `/exit` handoff.
- Verified archive, restore, delete, multi-archive, and multi-delete workflows.
- Desktop-first lifecycle reconciliation without treating temporary read failures as deletion.
- Bilingual English/Chinese documentation and prebuilt installable `.zip`/`.tar.gz` assets.

### Known limitations

- A writer held by Codex Desktop prevents this independent bot process from archiving or deleting the conversation until that writer is released.
- Messages added later from Codex Desktop are not continuously mirrored into Discord.
- The new channel lifecycle is tested on macOS; Windows files are retained from upstream but this release has not been device-tested on Windows.

## 简体中文

这是“频道即会话”社区版本的第一个 Release。

### 主要功能

- 自动建立私密 `CodeX` 类别，每个文字频道永久绑定一个 Codex 会话。
- 通过 `/sessions` 命名新建会话或导入电脑端已有会话。
- 首次同步最近 20 轮，并持久记录向前翻页位置。
- 模型和思考强度菜单、每会话独立 writer，以及用于交接的 `/exit`。
- 经过电脑端核验的归档、恢复、删除、批量归档和批量删除。
- 电脑端先操作后的状态同步；临时读取失败不会被误判为删除。
- 中英文文档和包含预构建文件的 `.zip`/`.tar.gz` 安装包。

### 已知限制

- Codex 桌面端仍持有 writer 时，独立机器人进程必须等待占用释放后才能归档或删除。
- 电脑端后来新增的消息不会持续实时镜像到 Discord。
- 新频道生命周期已在 macOS 验证；仓库保留原版 Windows 文件，但本 Release 尚未在 Windows 真机验证。
