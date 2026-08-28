# QQ Persona Companion

一个最小化的 QQ 人格聊天程序：通过 SnowLuma 提供的 OneBot v11 WebSocket 接收 QQ 文本消息，固定使用“小鲸鱼”角色卡，并直接调用 DeepSeek 官方 API 回复。

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

## 配置

1. 复制 `config.example.json` 为 `config.json`；
2. 将自己的 QQ 号写入 `allow.private`；
3. 确认 SnowLuma WebSocket 地址，默认是 `ws://127.0.0.1:3001`；
4. 在当前 PowerShell 会话设置 DeepSeek API Key，或写入本地 `config.json` 的 `deepseek.apiKey`；
5. 启动 SnowLuma 后再启动本项目。

PowerShell 示例：

```powershell
Copy-Item -LiteralPath config.example.json -Destination config.json
$env:DEEPSEEK_API_KEY = "你的 API Key"
npm start
```

环境变量优先级高于 `config.json`。如果按本地配置方式保存 Key，`config.json` 已被 `.gitignore` 排除，仍不要复制到公开位置或提交到 Git。

## 群聊模式

`chat.groupReplyMode` 支持：

- `off`：完全不处理群聊，默认值；
- `mention`：只有明确 `@` 机器人时回复；
- `all`：处理白名单群内所有文本消息。

第一版建议先使用私聊。`all` 只表示不要求 `@`，目前不会智能判断群内某句话是否适合插话，开启后可能回复得过于频繁。

## 启动

```powershell
npm start
```

停止程序使用 `Ctrl+C`。近期上下文保存在 `state/recent-context.json`。

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
- `src/message-batcher.js`：连续短消息合并和最长等待控制；
- `src/recent-context-store.js`：有限近期上下文；
- `docs/DEVELOPMENT.md`：范围、架构和验收标准。

## 安全与风险

白名单为空时程序不会处理任何 QQ 会话。程序在接收和发送前都会校验目标，并进行基础限流。

第三方普通 QQ 账号接入存在平台风控风险。测试阶段请使用小号、少量白名单联系人和保守消息频率。
