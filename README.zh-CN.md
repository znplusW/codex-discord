# Codex Discord——频道即会话版

[English](README.md) | **简体中文**

这是一个在本机运行、通过 Discord 远程控制 Codex 会话的社区版本。它把 Discord 左侧频道列表变成手机端会话列表：每个受管理的文字频道永久对应一个 Codex 会话 ID 和该会话原来的工作目录。

> 本项目修改自 [chadingTV/codex-discord](https://github.com/chadingTV/codex-discord)，是独立维护的社区 fork，不是 OpenAI 官方产品。

## 使用逻辑

第一次启动时，机器人会建立私密的 `CodeX` 类别和默认的 `#助理` 会话频道。在频道内直接发送普通消息，就会继续对应的 Codex 会话，无需 @机器人，也无需先输入 `/sessions`。

- 一个 Discord 文字频道固定对应一个 Codex 会话 ID。
- 切换 Discord 频道，就是切换 Codex 会话。
- `/sessions` 可以输入名称新建会话，也可以选择电脑上已有的会话并建立同名频道。
- 首次导入会同步最近 20 轮可见对话；每次 `/sync history` 再向前加载最多 20 轮。
- `/model` 和 `/reasoning` 支持发送前参数菜单，同时保留发送后的选择菜单。
- `/exit` 只释放机器人对当前会话的写入占用，方便其他本地客户端接管。
- `/archive`、`/restore`、`/delete` 会先核验电脑端 Codex 状态，再移动或删除 Discord 频道。
- `/multi-archive` 和 `/multi-delete` 只列出 Discord 上当前存在且已经绑定的频道，必须先多选、预览，再确认执行。
- 一个类别达到 50 个频道后，会自动继续使用 `CodeX-2`、`CodeX-3` 等类别。

机器人注册 16 条指令：`/sessions`、`/model`、`/reasoning`、`/sync`、`/exit`、`/archive`、`/restore`、`/delete`、`/multi-archive`、`/multi-delete`、`/status`、`/last`、`/stop`、`/queue`、`/usage`、`/auto-approve`。

## 与原版的差异

| 原版 `chadingTV/codex-discord` | 本 fork |
|---|---|
| 先注册项目频道，再在频道里切换当前会话 | 每个受管理频道永久绑定一个 Codex 会话 |
| 使用 `/register`、`/unregister` 管理项目频道 | 自动建立私密 `CodeX` 类别和会话频道 |
| `/sessions` 在共享频道里切换当前会话 | `/sessions` 新建或打开一个独立的会话频道 |
| `/clear-sessions` 清理保存的会话 | `/multi-delete`、`/multi-archive` 提供多选、预览和确认流程 |
| 基础会话控制 | 增加模型/思考强度菜单、历史分页、`/exit`、经过核验的归档/删除/恢复，以及电脑端先操作后的状态同步 |

本 fork 不再注册 `/register`、`/unregister`、`/switch`、`/clear-sessions`。

## 运行要求

- macOS 或 Linux：后台启动脚本已经过测试。仓库保留原版 Windows 启动文件，但本 fork 的频道生命周期还没有在 Windows 真机验证。
- Node.js 20 或更高版本。
- 已安装 Codex CLI，并完成 `codex login`。
- Discord 应用已打开 **Message Content Intent**。
- 机器人权限：查看频道、发送消息、读取历史、嵌入链接、附加文件、使用应用命令、管理频道、管理子区。不需要管理员权限。

## 从 Release 安装

1. 从 [Releases](https://github.com/znplusW/codex-discord/releases) 下载 `.zip` 或 `.tar.gz` 安装包。
2. 解压并进入目录。
3. 运行：

```bash
./install-release.sh
```

4. 填写生成的 `.env`：

```env
DISCORD_BOT_TOKEN=机器人令牌
DISCORD_GUILD_ID=Discord服务器ID
ALLOWED_USER_IDS=允许使用机器人的Discord账号ID
BASE_PROJECT_DIR=/新会话使用的绝对路径
RATE_LIMIT_PER_MINUTE=10
SHOW_COST=false
```

5. 启动：

```bash
npm start
```

macOS 后台常驻和菜单栏安装可运行 `./mac-start.sh`；Linux 可运行 `./linux-start.sh`。Release 已包含预构建的 JavaScript，安装时只需安装生产依赖。

## 从源码安装

```bash
git clone https://github.com/znplusW/codex-discord.git
cd codex-discord
./install.sh
```

也可以手动构建：

```bash
npm ci
npm test
npm run build
```

Discord 应用创建和运行细节见 [SETUP.zh-CN.md](SETUP.zh-CN.md)。

## 会话生命周期与已知限制

电脑端 Codex 的真实状态是最终依据。机器人会在启动后、约每 10 秒以及提交任务前检查绑定会话。电脑先归档、恢复或确认删除会话后，机器人会同步调整对应频道，不会偷偷建立替代会话。

目前存在一个重要限制：如果 Codex 桌面端仍持有某个会话的 writer，这个独立运行的机器人进程不能归档或删除该会话。已经确认的操作会保留为待执行状态，等占用释放后重试；Codex 操作核验成功前，Discord 频道不会被移动或删除。`/exit` 只能释放机器人自己的占用。桌面端完成一轮回复或关闭标签页，并不保证立刻释放 writer。

历史导入只同步用户与助手可见的对话，不展示内部推理和工具日志。电脑端后来新增消息的持续实时镜像尚未实现；机器人继续原会话时，Codex 仍然使用该会话的完整上下文。

## 安全建议

- 不要公开 `.env`、Discord 机器人令牌、数据库和日志；这些内容不会进入源码或 Release 包。
- `ALLOWED_USER_IDS` 只填写可信账号。
- 使用私密 Discord 类别；除非理解影响，否则保持自动审批关闭。
- 机器人使用本机 Codex 登录状态，正常配置不需要在 `.env` 中填写 OpenAI API Key。

## 验证情况

首个 Release 通过 270 项自动测试、TypeScript 类型检查、生产构建和发布包内容检查。真实本地 app-server 测试覆盖机器人持有时归档/删除成功、其他应用占用时拒绝，以及释放后重试成功。开发期间还通过真实 Discord API 验证了频道创建、类别移动、恢复和删除。

## 许可证和署名

本项目遵循仓库中的 [MIT License with Attribution Requirement](LICENSE)。原项目为 [chadingTV/codex-discord](https://github.com/chadingTV/codex-discord)，修改署名见 [NOTICE.md](NOTICE.md)。
