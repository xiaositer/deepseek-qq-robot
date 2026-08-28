import { loadConfig } from './config.js';
import { loadFixedPersona } from './fixed-persona-loader.js';
import { RecentContextStore } from './recent-context-store.js';
import { DeepSeekClient } from './deepseek-client.js';
import { SafetyGuard } from './safety-guard.js';
import { QQAdapter } from './qq-adapter.js';
import { ChatController } from './chat-controller.js';
import { MessageBatcher } from './message-batcher.js';
import { GroupParticipationPolicy } from './group-participation-policy.js';

async function main() {
  const config = await loadConfig();
  const persona = await loadFixedPersona(config.personaPath);
  const store = new RecentContextStore({
    filePath: config.statePath,
    maxMessages: config.chat.contextMessages
  });
  await store.init();

  const deepseek = new DeepSeekClient(config.deepseek);
  const safety = new SafetyGuard({
    allow: config.allow,
    perMinuteLimit: config.chat.perMinuteLimit,
    globalPerMinuteLimit: config.chat.globalPerMinuteLimit
  });
  const qq = new QQAdapter(config.onebot);
  const participation = new GroupParticipationPolicy({
    activeWindowMs: config.chat.naturalActiveWindowMs,
    cooldownMs: config.chat.naturalCooldownMs,
    ambientChancePercent: config.chat.naturalReplyChancePercent
  });
  const controller = new ChatController({
    qq,
    deepseek,
    persona,
    store,
    safety,
    participation,
    config: config.chat
  });
  const batcher = new MessageBatcher({
    onBatch: (message) => controller.handle(message),
    quietMs: config.chat.inputDebounceMs,
    shortQuietMs: config.chat.shortInputDebounceMs,
    maxWaitMs: config.chat.maxInputWaitMs
  });

  qq.on('message', (message) => {
    if (controller.accepts(message)) {
      controller.noteIncoming(message);
      batcher.add(message);
    }
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.info(`[app] 收到 ${signal}，正在退出`);
    await qq.close();
    await batcher.close({ flush: false });
    await controller.flush();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('message', (message) => {
    if (message?.type === 'shutdown') void shutdown('CONTROL_CENTER');
  });

  console.info(`[app] 固定角色卡已加载（${persona.length} 字符）`);
  console.info(`[app] 私聊白名单 ${config.allow.private.length} 个，群聊白名单 ${config.allow.groups.length} 个`);
  await qq.connect();
  console.info('[app] QQ Persona Companion 已启动');
}

main().catch((error) => {
  console.error('[app] 启动失败：', error.message ?? error);
  process.exitCode = 1;
});
