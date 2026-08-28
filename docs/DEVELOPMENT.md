# QQ Persona Companion 开发文档

> 文档版本：0.2  
> 当前阶段：最小聊天版本  
> 项目目标：通过普通 QQ 账号，以固定的“小鲸鱼”人设调用 DeepSeek 官方 API 与用户聊天。

## 1. 已确定的技术方向

- QQ 接入使用 SnowLuma / OneBot；
- 模型只调用 DeepSeek 官方 API；
- 不使用 DSH；
- 不复制 `qq-bridge` 的整体架构；
- 参考 `qq-bridge` 的 QQ 接入和拟真聊天思路；
- 固定使用一个“小鲸鱼”人设；
- 当前只实现收消息、生成回复、发送消息这一条主链路。

## 2. 当前版本范围

### 必须实现

1. 连接 OneBot WebSocket；
2. 接收允许会话中的 QQ 文本消息；
3. 加载固定角色卡 `persona/fixed.md`；
4. 保存每个会话必要的近期对话，用于多轮聊天；
5. 在短暂静默窗口内合并用户连续发送的消息片段；
6. 允许模型对低信息的自然收尾选择静默；
7. 直接请求 DeepSeek Chat Completions API；
8. 将 DeepSeek 的文本回复发送到原 QQ 会话；
9. 不同私聊或群聊的上下文互相隔离；
10. 提供白名单、超时、有限重试和基础发送限流；
11. API Key 只从环境变量或本地忽略配置读取，不写入代码或日志。

近期上下文只是多轮聊天的必要组成，不属于长期记忆功能。第一版只保留有限条最近消息，超出限制后直接裁剪。

### 当前不实现

- 人格创建、编辑、切换和删除；
- 长期记忆、向量检索和关系成长；
- 主动找人聊天和定时唤醒；
- 已读不回、稍后回复等复杂行为状态；
- 图片理解、语音、表情包和合并转发；
- 联网搜索和外部工具调用；
- MCP、通用 Agent、Shell 和进程控制；
- 自动学习群聊黑话；
- 多模型供应商插件系统。

## 3. 最小架构

```text
QQ 普通账号
    ↓
SnowLuma / OneBot WebSocket
    ↓
QQ Adapter
    ↓
Chat Controller
    ├── Fixed Persona Loader
    ├── Recent Context Store
    └── Safety Guard
    ↓
DeepSeek Client
    ↓
DeepSeek 官方 API
```

项目另有一个仅监听 `127.0.0.1` 的本地控制中枢，负责编辑配置与角色卡、保护密钥、启停聊天子进程和汇总运行日志。控制台本身不参与消息生成。

这不是一个通用 Agent 中枢。每个模块只承担完成 QQ 文本聊天所必需的职责。

## 4. 模块职责

### 4.1 QQ Adapter

- 建立和维护 OneBot WebSocket 连接；
- 将私聊、群聊文本事件转换成统一内部消息；
- 把文本回复发送回指定会话；
- 处理连接中断和重连；
- 不包含模型和人设逻辑。

### 4.2 Chat Controller

- 校验消息来源和白名单；
- 使用 `conversationId` 找到独立上下文；
- 将同一会话的请求串行执行，避免回复乱序；
- 组装固定人设、近期上下文和最新消息；
- 调用 DeepSeek Client；
- 校验并发送回复；
- 只在发送成功后记录 assistant 消息。

### 4.3 Fixed Persona Loader

- 启动时读取 `persona/fixed.md`；
- 人设文件缺失或为空时拒绝启动聊天服务；
- 运行时不提供人格切换接口；
- 修改角色卡后通过重启程序生效。

### 4.4 Recent Context Store

- 私聊键：`private:<QQ号>`；
- 群聊键：`group:<群号>`；
- 每个键只保存有限数量的最近 user/assistant 文本消息；
- 不进行事实提取、总结、向量化或跨会话共享；
- 使用本地 JSON 原子写入，防止异常退出导致文件损坏。

### 4.5 DeepSeek Client

- 使用 Node.js 原生 `fetch`；
- 请求 `https://api.deepseek.com/chat/completions`；
- 从 `DEEPSEEK_API_KEY` 读取密钥；
- 普通聊天默认关闭思考模式，以降低响应时间；
- 设置请求超时；
- 只对超时、限流和临时服务错误有限重试；
- 不保存或输出模型的推理内容；
- 返回最终文本和 token 用量。

### 4.6 Safety Guard

- 白名单为空时默认拒绝发送；
- 接收时和发送前都校验目标会话；
- 每个会话独立限流，并设置一个全局上限；
- 限制单条回复长度；
- 日志隐藏 API Key、鉴权 token 和敏感配置；
- 提供一个本地紧急停止开关。

## 5. 内部消息模型

```ts
type ChatMessage = {
  id: string;
  conversationId: string;
  kind: "private" | "group";
  senderId: string;
  senderName?: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};
```

`conversationId` 必须包含会话类型，不能只使用裸 QQ 号或群号。

## 6. 提示词组装

每次调用按以下顺序发送：

1. 固定安全边界；
2. `persona/fixed.md` 的固定“小鲸鱼”人设；
3. 当前会话类型、当前时间和发送者昵称；
4. 该会话最近的聊天记录；
5. 最新收到的消息。

角色卡固定放在上下文前部。模型只输出最终聊天文本，不输出分析过程、工具调用、Markdown 标题或动作说明。

第一版允许模型用换行表示自然分成多条 QQ 消息，程序最多发送三条，并过滤空行。除此之外不实现复杂的消息行为协议。

## 7. 固定角色卡

角色卡文件固定为：

```text
persona/fixed.md
```

初始内容以 `qq-bridge/roles/小鲸鱼.md` 为参考，保留：

- DeepSeek 小鲸鱼的 AI 自我认知；
- 群友式短句和去客服腔；
- 傲娇、嘴硬、会接梗但不过度表演；
- “蓝色大肥鱼”等角色雷点；
- AI 味表达黑名单；
- 典型聊天示例。

删除以下原项目专属内容：

- DSH、reserved2 和 MCP 工具说明；
- `[SILENT]` 控制指令；
- 搜索、图片、转发、戳一戳和表情包工具；
- 主动唤醒、等待消息和潜水状态机；
- 轻量记忆工具；
- 依赖空格切分消息的旧协议。

## 8. 建议目录结构

```text
qq-persona-companion/
├── docs/
│   └── DEVELOPMENT.md
├── persona/
│   └── fixed.md
├── src/
│   ├── qq-adapter.js
│   ├── chat-controller.js
│   ├── message-batcher.js
│   ├── deepseek-client.js
│   ├── fixed-persona-loader.js
│   ├── recent-context-store.js
│   ├── safety-guard.js
│   ├── config.js
│   └── index.js
├── state/                 # 运行时生成，不提交 Git
├── test/
├── .env.example
├── .gitignore
├── config.example.json
├── package.json
└── README.md
```

在规模变大前不继续拆分目录，避免为尚不存在的功能提前构建复杂框架。

## 9. 最小运行流程

```text
收到 OneBot 文本消息
  → 规范化并检查白名单
  → 等待静默窗口并合并连续消息片段
  → 进入该 conversationId 的串行队列
  → 保存 user 消息
  → 读取固定角色卡和该会话近期上下文
  → 调用 DeepSeek 官方 API
  → 校验最终文本
  → 按换行拆成最多三条消息
  → 再次校验目标并发送
  → 保存成功发送的 assistant 消息
```

任一步骤失败都不得向其他会话发送消息，也不得无限重试。

## 10. 开发顺序

### M1：项目骨架和 DeepSeek

- 初始化 Node.js 项目；
- 配置加载和环境变量校验；
- 固定角色卡加载；
- DeepSeek Client 及单元测试；
- 使用模拟消息完成一次多轮文本对话。

### M2：QQ 最小闭环

- OneBot WebSocket 接收文本消息；
- 私聊白名单；
- 真实 QQ 私聊回复；
- 断线重连和基础错误日志。

### M3：上下文和稳定性

- 不同会话上下文隔离；
- 同一会话串行队列；
- 本地近期上下文原子存储；
- 回复长度、频率和重复发送保护；
- 连续运行测试。

群聊只在私聊闭环稳定后启用，并复用同一文本聊天流程，不增加主动发言或群聊行为状态机。

## 11. 验收标准

1. QQ 文本消息可以稳定完成接收、生成和回复；
2. 请求直接发送到 DeepSeek 官方 API，不经过 DSH；
3. 始终加载唯一的“小鲸鱼”角色卡；
4. 多轮聊天能够理解有限的近期上下文；
5. 不同联系人或群聊的上下文不会串线；
6. 同一会话快速连续发消息时不会出现回复顺序错乱；
7. API 超时或临时错误不会无限重试或重复发送；
8. 白名单为空或配置无效时不会向 QQ 发送消息；
9. 日志和仓库中不出现真实 API Key；
10. 角色回复保持短句、口语化，不输出工具名、控制指令或分析过程；
11. 重启后能够安全读取近期上下文；
12. 使用专门测试 QQ 号完成持续运行验证。

## 12. 风险说明

普通 QQ 账号通过第三方协议运行存在账号风控风险。开发阶段应使用专门测试账号、少量白名单联系人和保守的发送频率。程序级限制只能降低异常行为风险，不能保证账号不会被平台限制。

`qq-bridge` 当前仓库未提供明确的根目录许可证文件。角色卡只作为本地开发参考；如果未来公开发布、分发或商业使用，需要先确认原内容的授权范围，或将角色卡改写为完全独立版本。

## 13. 后续原则

当前版本完成之前，不加入主动聊天、长期记忆、人格管理、媒体理解或通用 Agent 功能。新增需求统一进入后续版本清单，不进入最小聊天主链路。
