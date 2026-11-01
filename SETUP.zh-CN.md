# 安装配置指南

[English](SETUP.md) | **简体中文** | [项目说明](README.zh-CN.md)

本指南用于安装“频道即会话”版本。机器人必须运行在能够访问目标工作目录、且已经登录 Codex 的电脑上。

## 1. 准备 Codex 和 Node.js

安装 Node.js 20 或更高版本及 Codex CLI，然后登录：

```bash
node --version
codex --version
codex login
codex login status
```

机器人使用本机 Codex 登录状态。正常安装不需要把 OpenAI API Key 写入 `.env`。

## 2. 创建 Discord 应用

1. 打开 <https://discord.com/developers/applications> 并创建应用。
2. 进入 **Bot**，创建机器人账号并复制令牌。
3. 打开 **Message Content Intent** 并保存。
4. 进入 **OAuth2 → URL Generator**。
5. 勾选 `bot` 和 `applications.commands`。
6. 授予：查看频道、发送消息、读取历史、嵌入链接、附加文件、使用应用命令、管理频道、管理子区。
7. 打开生成的邀请链接，把机器人加入服务器。

不需要授予管理员或管理身份组权限。机器人会创建私密会话类别；在活动、归档和已删除类别之间移动频道时，会保留频道原来的权限覆盖设置。

## 3. 复制 Discord ID

先打开 **Discord 设置 → 高级 → 开发者模式**，然后复制：

- 服务器 ID，填写到 `DISCORD_GUILD_ID`；
- 你自己的用户 ID，填写到 `ALLOWED_USER_IDS`。

可以用英文逗号填写多个允许账号。即使其他人能看见频道，只要不在白名单中，机器人也会拒绝其操作。

## 4. 安装

### 使用 Release 安装包

从 [Releases](https://github.com/znplusW/codex-discord/releases) 下载并解压 `.zip` 或 `.tar.gz`，然后运行：

```bash
./install-release.sh
```

发布包已经包含构建后的 JavaScript。安装脚本会检查 Node/Codex、安装生产依赖，并在不存在时从示例创建 `.env`，不会覆盖已有 `.env`。

### 从源码安装

```bash
git clone https://github.com/znplusW/codex-discord.git
cd codex-discord
./install.sh
```

## 5. 配置 `.env`

```env
DISCORD_BOT_TOKEN=机器人令牌
DISCORD_GUILD_ID=123456789012345678
ALLOWED_USER_IDS=111111111111111111
BASE_PROJECT_DIR=/新建会话使用的绝对路径
RATE_LIMIT_PER_MINUTE=10
SHOW_COST=false
```

`BASE_PROJECT_DIR` 是从 Discord 新建会话时使用的工作目录。通过 `/sessions` 导入的电脑旧会话会保留其原工作目录。请填写运行机器人账号有权访问的绝对路径。

不要提交 `.env`。仓库和发布脚本都会排除令牌、数据库、日志、上传内容及本机运行文件。

## 6. 启动

前台检查：

```bash
npm start
```

macOS：

```bash
./mac-start.sh
./mac-start.sh --status
```

Linux：

```bash
./linux-start.sh
./linux-start.sh --status
```

第一次成功启动会注册 16 条命令，建立私密 `CodeX` 类别和默认 `#助理` 频道。直接在频道发送普通消息即可测试连接。

## 7. 建议的首次检查

1. 输入 `/status`，确认默认会话存在。
2. 在 `#助理` 发送“只回复：连接成功”。
3. 输入 `/sessions`，创建一个命名会话，确认出现同名频道。
4. 不填参数发送 `/model`，确认先后出现模型和思考强度菜单。
5. 测试会话完成后输入 `/exit`，再从其他本地客户端打开同一会话。

## 8. 更新

替换安装目录前备份 `.env` 和 `data.db`。升级 Release 时保留这两个本机文件，替换源码和构建文件，再安装依赖：

```bash
npm ci --omit=dev
```

替换后重启对应平台的后台服务。数据库迁移会在启动时自动执行。

## 9. 常见问题

### 看不到斜杠命令

- 确认邀请机器人时勾选了 `applications.commands`。
- 确认 `DISCORD_GUILD_ID` 是当前服务器。
- 重启机器人，日志中应出现 `Registered 16 slash commands`。
- 如果 iPhone 仍缓存旧命令，彻底关闭并重开 Discord。

### 普通消息没有回复

- 在 Discord 开发者门户打开 Message Content Intent。
- 确认你的用户 ID 在 `ALLOWED_USER_IDS` 中。
- 请在 `CodeX` 下受管理的会话频道发送消息。
- 确认 Mac 保持登录、唤醒、联网，并且 Codex 已登录。

### 无法创建或移动频道

授予机器人“管理频道”权限。不需要管理员或管理身份组。“管理子区”用于迁移及保留的子区流程。

### 归档或删除提示 active writer

另一个 Codex 应用仍然占用该会话。`/exit` 只能释放机器人自己的占用。退出真正持有该会话的应用后，已经确认的操作会保留并在后台重试；只有电脑端 Codex 状态核验成功后，机器人才能调整 Discord 频道。

### 导入历史不完整

首次只同步最近最多 20 轮可见对话。每次输入 `/sync history` 可以继续加载更早一页。内部推理和工具日志不会同步。
