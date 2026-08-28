# QQ Persona Companion

一个带本地 Web 控制台的 QQ 人格聊天程序：通过 SnowLuma 提供的 OneBot v11 WebSocket 接收 QQ 文本消息，固定使用“小鲸鱼”角色卡，并直接调用 DeepSeek 官方 API 回复。

当前版本只做文本聊天，不使用 DSH，也不包含主动聊天、长期记忆、人格切换、图片、语音、表情包、搜索或通用 Agent 工具。

连续短消息会先进入输入缓冲：普通消息在短暂静默后处理，短且没有结束标点的片段会多等一会儿，最多等待 8 秒。比如连续发送“你现在”和“在干什么”，会合并成同一轮，只请求一次 DeepSeek。

对于“嗯、哦、知道了、哈哈”等没有问题或继续意图的自然收尾，模型可以选择本轮不发送消息，避免为了回应而回应。

## 环境要求

- Windows；
- Node.js 22.13 或更高版本；
- 已能正常登录的 SnowLuma / OneBot v11 服务；
- DeepSeek 官方 API Key；
- 建议使用专门测试 QQ 账号。

项目没有第三方 npm 运行依赖，因此不需要执行 `npm install`。

## 启动控制台

首次运行前复制配置示例：

PowerShell 示例：

```powershell
Copy-Item -LiteralPath config.example.json -Destination config.json
npm start
```

启动日志会显示本地控制台地址 `http://127.0.0.1:3100/`。控制台只监听 `127.0.0.1`，无需登录令牌。打开后可以管理：

- 聊天服务启动、停止和重启；
- SnowLuma WebSocket 地址与 Token；
- 私聊和群聊白名单；
- DeepSeek API Key、地址、模型、超时、重试和输出长度；
- 连续消息等待、上下文、分条回复与限流；
- 完整固定角色卡；
- 项目内路径、控制台端口和自动启动；
- 最近 500 条聊天服务运行日志。

已有 API Key 和 OneBot Token 不会发送到浏览器，页面只显示是否已经配置。密钥输入框留空表示保留原值。`config.json` 被 `.gitignore` 排除。

## 群聊模式

`chat.groupReplyMode` 支持：

- `off`：完全不处理群聊，默认值；
- `mention`：只有明确 `@` 机器人时回复；
- `natural`：消息先进入本地收件箱；被点名、被回复、开放问题或累计一定消息时唤醒模型查看，由模型自主选择发送、等待、已读或继续观察；
- `all`：处理白名单群内所有文本消息。

拟真聊天建议使用 `natural`。`all` 主要用于调试，日常群聊可能回复得过于频繁。自然模式建议把 `naturalReviewEveryMessages` 设为 `1`：每个经过静默窗口合并后的群聊话轮都会进入语义观察，但模型仍可选择等待、继续观察或已读，不会强制回复。该模式没有固定插话概率、冷却或“活跃窗口”：回复后继续处于观察状态，直到模型根据话题语义选择退出。模型生成期间如果用户继续输入，尚未发送的旧回复会自动取消，避免抢话。

## 直接启动聊天进程

```powershell
npm run chat
```

一般不需要直接启动，建议通过控制台管理。近期上下文保存在 `state/recent-context.json`。

## 测试

```powershell
npm test
npm run check
```

测试不会连接真实 QQ，也不会请求 DeepSeek。

## 文件说明

- `persona/fixed.md`：唯一固定角色卡；
- `src/qq-adapter.js`：OneBot WebSocket 收发；
- `src/deepseek-client.js`：DeepSeek 官方 API 直连；
- `src/chat-controller.js`：消息队列和聊天主流程；
- `src/natural-conversation-engine.js`：自然群聊收件箱状态、语义唤醒和自主动作协议；
- `src/message-batcher.js`：连续短消息合并和最长等待控制；
- `src/recent-context-store.js`：有限近期上下文；
- `src/control-center.js`：本地控制台 API 与访问控制；
- `src/chat-process-manager.js`：聊天子进程启停与日志；
- `src/settings-store.js`：配置校验、密钥保护和原子保存；
- `public/`：本地控制台前端；
- `docs/DEVELOPMENT.md`：范围、架构和验收标准。

## 安全与风险

白名单为空时程序不会处理任何 QQ 会话。程序在接收和发送前都会校验目标，并进行基础限流。

第三方普通 QQ 账号接入存在平台风控风险。测试阶段请使用小号、少量白名单联系人和保守消息频率。
