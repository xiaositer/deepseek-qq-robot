import { readFile } from 'node:fs/promises';
import path from 'node:path';

const GROUP_REPLY_MODES = new Set(['off', 'mention', 'natural', 'all']);

function asPositiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return parsed;
}

function asNonNegativeInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} 必须是非负整数`);
  }
  return parsed;
}

function asPercentage(value, fallback, name) {
  const parsed = asNonNegativeInteger(value, fallback, name);
  if (parsed > 100) throw new Error(`${name} 必须是 0-100 之间的整数`);
  return parsed;
}

function asIdList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} 必须是数组`);
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

export async function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const configPath = path.resolve(cwd, 'config.json');
  let file;
  try {
    file = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`缺少配置文件：${configPath}（请复制 config.example.json 为 config.json）`);
    }
    if (error instanceof SyntaxError) throw new Error(`config.json 不是有效 JSON：${error.message}`);
    throw error;
  }

  const apiKey = String(env.DEEPSEEK_API_KEY ?? file.deepseek?.apiKey ?? '').trim();
  if (!apiKey) throw new Error('缺少 DeepSeek API Key（请设置环境变量或 deepseek.apiKey）');

  const rootDir = path.dirname(configPath);
  const groupReplyMode = String(file.chat?.groupReplyMode ?? 'off');
  if (!GROUP_REPLY_MODES.has(groupReplyMode)) {
    throw new Error('chat.groupReplyMode 必须是 off、mention、natural 或 all');
  }

  const wsUrl = String(file.onebot?.wsUrl ?? 'ws://127.0.0.1:3001').trim();
  const baseUrl = String(file.deepseek?.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  try {
    const parsed = new URL(wsUrl);
    if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error();
  } catch {
    throw new Error('onebot.wsUrl 必须是有效的 ws:// 或 wss:// 地址');
  }
  try {
    const parsed = new URL(baseUrl);
    const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !localHttp) {
      throw new Error();
    }
  } catch {
    throw new Error('deepseek.baseUrl 必须是有效的 HTTPS 地址（本机测试可使用 HTTP）');
  }

  const model = String(file.deepseek?.model ?? 'deepseek-v4-flash').trim();
  if (!model) throw new Error('deepseek.model 不能为空');

  return {
    rootDir,
    onebot: {
      wsUrl,
      accessToken: String(file.onebot?.accessToken ?? '').trim()
    },
    deepseek: {
      apiKey,
      baseUrl,
      model,
      timeoutMs: asPositiveInteger(file.deepseek?.timeoutMs, 45_000, 'deepseek.timeoutMs'),
      maxRetries: asNonNegativeInteger(file.deepseek?.maxRetries, 2, 'deepseek.maxRetries'),
      maxTokens: asPositiveInteger(file.deepseek?.maxTokens, 600, 'deepseek.maxTokens')
    },
    allow: {
      private: asIdList(file.allow?.private, 'allow.private'),
      groups: asIdList(file.allow?.groups, 'allow.groups')
    },
    chat: {
      groupReplyMode,
      naturalActiveWindowMs: asPositiveInteger(file.chat?.naturalActiveWindowMs, 120_000, 'chat.naturalActiveWindowMs'),
      naturalCooldownMs: asPositiveInteger(file.chat?.naturalCooldownMs, 20_000, 'chat.naturalCooldownMs'),
      naturalReplyChancePercent: asPercentage(file.chat?.naturalReplyChancePercent, 12, 'chat.naturalReplyChancePercent'),
      inputDebounceMs: asPositiveInteger(file.chat?.inputDebounceMs, 1_800, 'chat.inputDebounceMs'),
      shortInputDebounceMs: asPositiveInteger(file.chat?.shortInputDebounceMs, 3_000, 'chat.shortInputDebounceMs'),
      maxInputWaitMs: asPositiveInteger(file.chat?.maxInputWaitMs, 8_000, 'chat.maxInputWaitMs'),
      contextMessages: asPositiveInteger(file.chat?.contextMessages, 24, 'chat.contextMessages'),
      maxReplyChars: asPositiveInteger(file.chat?.maxReplyChars, 500, 'chat.maxReplyChars'),
      maxReplyParts: asPositiveInteger(file.chat?.maxReplyParts, 3, 'chat.maxReplyParts'),
      sendGapMs: asPositiveInteger(file.chat?.sendGapMs, 700, 'chat.sendGapMs'),
      perMinuteLimit: asPositiveInteger(file.chat?.perMinuteLimit, 8, 'chat.perMinuteLimit'),
      globalPerMinuteLimit: asPositiveInteger(file.chat?.globalPerMinuteLimit, 30, 'chat.globalPerMinuteLimit')
    },
    personaPath: path.resolve(rootDir, String(file.personaPath ?? 'persona/fixed.md')),
    statePath: path.resolve(rootDir, String(file.statePath ?? 'state/recent-context.json'))
  };
}
