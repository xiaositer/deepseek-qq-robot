import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const GROUP_MODES = new Set(['off', 'mention', 'natural', 'all']);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
  return value;
}

function text(value, name, { min = 0, max = 500, trim = true } = {}) {
  const result = trim ? String(value ?? '').trim() : String(value ?? '');
  if (result.length < min || result.length > max) throw new Error(`${name} 长度必须在 ${min}-${max} 之间`);
  return result;
}

function integer(value, name, { min, max }) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${name} 必须是 ${min}-${max} 之间的整数`);
  }
  return result;
}

function ids(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} 必须是数组`);
  const result = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (result.some((item) => !/^\d{5,20}$/.test(item))) throw new Error(`${name} 只能包含数字 ID`);
  return result;
}

function localPath(value, name) {
  const result = text(value, name, { min: 1, max: 200 });
  if (path.isAbsolute(result) || result.split(/[\\/]+/).includes('..')) {
    throw new Error(`${name} 必须是项目内的相对路径`);
  }
  return result.replace(/\\/g, '/');
}

function validateWebSocketUrl(value) {
  const result = text(value, 'onebot.wsUrl', { min: 1, max: 300 });
  let parsed;
  try { parsed = new URL(result); } catch { throw new Error('onebot.wsUrl 不是有效 URL'); }
  if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error('onebot.wsUrl 必须使用 ws:// 或 wss://');
  return result;
}

function validateApiBaseUrl(value) {
  const result = text(value, 'deepseek.baseUrl', { min: 1, max: 300 }).replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(result); } catch { throw new Error('deepseek.baseUrl 不是有效 URL'); }
  const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) throw new Error('模型 API 必须使用 HTTPS（本机地址可用 HTTP）');
  return result;
}

async function writeAtomic(filePath, content, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode });
  await rename(temporaryPath, filePath);
}

export function mergeAndValidateSettings(current, submitted, secrets = {}) {
  const input = object(submitted, 'config');
  const onebot = object(input.onebot, 'onebot');
  const deepseek = object(input.deepseek, 'deepseek');
  const allow = object(input.allow, 'allow');
  const chat = object(input.chat, 'chat');
  const consoleConfig = object(input.console ?? {}, 'console');
  const groupReplyMode = text(chat.groupReplyMode, 'chat.groupReplyMode', { min: 1, max: 20 });
  if (!GROUP_MODES.has(groupReplyMode)) throw new Error('群聊模式必须是 off、mention、natural 或 all');

  const next = {
    ...current,
    onebot: {
      ...(current.onebot ?? {}),
      wsUrl: validateWebSocketUrl(onebot.wsUrl),
      accessToken: String(current.onebot?.accessToken ?? '')
    },
    deepseek: {
      ...(current.deepseek ?? {}),
      apiKey: String(current.deepseek?.apiKey ?? ''),
      baseUrl: validateApiBaseUrl(deepseek.baseUrl),
      model: text(deepseek.model, 'deepseek.model', { min: 1, max: 100 }),
      timeoutMs: integer(deepseek.timeoutMs, 'deepseek.timeoutMs', { min: 1_000, max: 180_000 }),
      maxRetries: integer(deepseek.maxRetries, 'deepseek.maxRetries', { min: 0, max: 10 }),
      maxTokens: integer(deepseek.maxTokens, 'deepseek.maxTokens', { min: 32, max: 32_768 })
    },
    allow: {
      private: ids(allow.private, 'allow.private'),
      groups: ids(allow.groups, 'allow.groups')
    },
    chat: {
      ...(current.chat ?? {}),
      groupReplyMode,
      naturalReviewEveryMessages: integer(chat.naturalReviewEveryMessages ?? 3, 'chat.naturalReviewEveryMessages', { min: 1, max: 100 }),
      naturalReviewOpenQuestions: chat.naturalReviewOpenQuestions !== false,
      groupInputDebounceMs: integer(chat.groupInputDebounceMs ?? 8_000, 'chat.groupInputDebounceMs', { min: 500, max: 60_000 }),
      groupMaxInputWaitMs: integer(chat.groupMaxInputWaitMs ?? 20_000, 'chat.groupMaxInputWaitMs', { min: 1_000, max: 120_000 }),
      inputDebounceMs: integer(chat.inputDebounceMs, 'chat.inputDebounceMs', { min: 100, max: 30_000 }),
      shortInputDebounceMs: integer(chat.shortInputDebounceMs, 'chat.shortInputDebounceMs', { min: 100, max: 30_000 }),
      maxInputWaitMs: integer(chat.maxInputWaitMs, 'chat.maxInputWaitMs', { min: 500, max: 120_000 }),
      contextMessages: integer(chat.contextMessages, 'chat.contextMessages', { min: 2, max: 500 }),
      maxReplyChars: integer(chat.maxReplyChars, 'chat.maxReplyChars', { min: 20, max: 5_000 }),
      maxReplyParts: integer(chat.maxReplyParts, 'chat.maxReplyParts', { min: 1, max: 10 }),
      sendGapMs: integer(chat.sendGapMs, 'chat.sendGapMs', { min: 50, max: 30_000 }),
      perMinuteLimit: integer(chat.perMinuteLimit, 'chat.perMinuteLimit', { min: 1, max: 120 }),
      globalPerMinuteLimit: integer(chat.globalPerMinuteLimit, 'chat.globalPerMinuteLimit', { min: 1, max: 1_000 })
    },
    console: {
      port: integer(consoleConfig.port ?? current.console?.port ?? 3100, 'console.port', { min: 1024, max: 65_535 }),
      autoStartChat: Boolean(consoleConfig.autoStartChat)
    },
    personaPath: localPath(input.personaPath, 'personaPath'),
    statePath: localPath(input.statePath, 'statePath')
  };

  delete next.chat.naturalActiveWindowMs;
  delete next.chat.naturalCooldownMs;
  delete next.chat.naturalReplyChancePercent;

  const deepseekApiKey = String(secrets.deepseekApiKey ?? '').trim();
  const onebotAccessToken = String(secrets.onebotAccessToken ?? '').trim();
  if (secrets.clearDeepseekApiKey) next.deepseek.apiKey = '';
  else if (deepseekApiKey) next.deepseek.apiKey = deepseekApiKey;
  if (secrets.clearOnebotAccessToken) next.onebot.accessToken = '';
  else if (onebotAccessToken) next.onebot.accessToken = onebotAccessToken;
  return next;
}

export class SettingsStore {
  #rootDir;
  #configPath;

  constructor({ rootDir }) {
    this.#rootDir = rootDir;
    this.#configPath = path.join(rootDir, 'config.json');
  }

  async readRawConfig() {
    return JSON.parse(await readFile(this.#configPath, 'utf8'));
  }

  async readPublicSettings() {
    const raw = await this.readRawConfig();
    const personaPath = path.resolve(this.#rootDir, raw.personaPath ?? 'persona/fixed.md');
    const persona = await readFile(personaPath, 'utf8');
    const config = structuredClone(raw);
    if (!config.console) config.console = { port: 3100, autoStartChat: false };
    const hasDeepseekApiKey = Boolean(config.deepseek?.apiKey);
    const hasOnebotAccessToken = Boolean(config.onebot?.accessToken);
    if (config.deepseek) delete config.deepseek.apiKey;
    if (config.onebot) delete config.onebot.accessToken;
    return {
      config,
      persona,
      secrets: { hasDeepseekApiKey, hasOnebotAccessToken }
    };
  }

  async apply({ config, persona, secrets }) {
    const current = await this.readRawConfig();
    const next = mergeAndValidateSettings(current, config, secrets);
    const personaText = text(persona, '角色卡', { min: 1, max: 50_000, trim: false });
    const personaPath = path.resolve(this.#rootDir, next.personaPath);
    if (!personaPath.startsWith(`${this.#rootDir}${path.sep}`)) throw new Error('角色卡路径超出项目目录');
    await writeAtomic(personaPath, personaText);
    await writeAtomic(this.#configPath, `${JSON.stringify(next, null, 2)}\n`);
    return {
      consoleRestartRequired: Number(current.console?.port ?? 3100) !== next.console.port
    };
  }
}
