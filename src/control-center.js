import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore } from './settings-store.js';
import { ChatProcessManager } from './chat-process-manager.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const STATE_DIR = path.join(ROOT_DIR, 'state');
const TOKEN_PATH = path.join(STATE_DIR, 'console-token.txt');
const MAX_BODY_BYTES = 200_000;

async function ensureToken() {
  await mkdir(STATE_DIR, { recursive: true });
  try {
    const token = (await readFile(TOKEN_PATH, 'utf8')).trim();
    if (token.length >= 32) return token;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('hex');
  await writeFile(TOKEN_PATH, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

function authorized(request, token) {
  const value = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const left = Buffer.from(value);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('请求必须使用 application/json'), { statusCode: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('请求体过大'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求体不是有效 JSON'), { statusCode: 400 }); }
}

async function staticFile(response, name, contentType) {
  const content = await readFile(path.join(PUBLIC_DIR, name));
  response.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  });
  response.end(content);
}

function probePort(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function main() {
  const settings = new SettingsStore({ rootDir: ROOT_DIR });
  const raw = await settings.readRawConfig();
  const token = await ensureToken();
  const manager = new ChatProcessManager({ rootDir: ROOT_DIR });
  const port = Number(raw.console?.port ?? 3100);
  const host = '127.0.0.1';

  const server = createServer(async (request, response) => {
    try {
      const hostHeader = String(request.headers.host ?? '').split(':')[0].toLowerCase();
      if (!['127.0.0.1', 'localhost'].includes(hostHeader)) return json(response, 403, { error: '只允许本机访问' });
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === 'GET' && url.pathname === '/') return staticFile(response, 'console.html', 'text/html; charset=utf-8');
      if (request.method === 'GET' && url.pathname === '/console.css') return staticFile(response, 'console.css', 'text/css; charset=utf-8');
      if (request.method === 'GET' && url.pathname === '/console.js') return staticFile(response, 'console.js', 'text/javascript; charset=utf-8');
      if (!url.pathname.startsWith('/api/')) return json(response, 404, { error: 'Not found' });
      if (!authorized(request, token)) return json(response, 401, { error: '控制台令牌无效' });

      if (request.method === 'GET' && url.pathname === '/api/status') {
        const config = await settings.readRawConfig();
        let wsPort = 3001;
        try { wsPort = Number(new URL(config.onebot?.wsUrl ?? 'ws://127.0.0.1:3001').port || 80); } catch {}
        const [webUi, httpApi, webSocket] = await Promise.all([
          probePort('127.0.0.1', 5099),
          probePort('127.0.0.1', 3000),
          probePort('127.0.0.1', wsPort)
        ]);
        return json(response, 200, {
          chat: manager.status(),
          snowluma: { webUi, httpApi, webSocket, wsPort },
          updatedAt: new Date().toISOString()
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/settings') {
        return json(response, 200, await settings.readPublicSettings());
      }
      if (request.method === 'PUT' && url.pathname === '/api/settings') {
        const body = await readJson(request);
        const result = await settings.apply(body);
        if (body.restartChat && manager.status().running) await manager.restart();
        return json(response, 200, { ok: true, ...result, chat: manager.status() });
      }
      if (request.method === 'GET' && url.pathname === '/api/logs') {
        const after = Number(url.searchParams.get('after') ?? 0);
        return json(response, 200, { logs: manager.logs(Number.isFinite(after) ? after : 0) });
      }
      if (request.method === 'POST' && url.pathname === '/api/chat/start') {
        return json(response, 200, { ok: true, chat: await manager.start() });
      }
      if (request.method === 'POST' && url.pathname === '/api/chat/stop') {
        return json(response, 200, { ok: true, chat: await manager.stop() });
      }
      if (request.method === 'POST' && url.pathname === '/api/chat/restart') {
        return json(response, 200, { ok: true, chat: await manager.restart() });
      }
      return json(response, 404, { error: 'API not found' });
    } catch (error) {
      console.error('[console] request failed:', error.message ?? error);
      return json(response, error.statusCode ?? 400, { error: error.message ?? '请求失败' });
    }
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await manager.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  server.listen(port, host, () => {
    const url = `http://${host}:${port}/#token=${token}`;
    console.info(`[console] 控制台已启动：${url}`);
    if (raw.console?.autoStartChat) {
      manager.start().catch((error) => console.error('[console] 自动启动聊天服务失败：', error.message ?? error));
    }
  });
}

main().catch((error) => {
  console.error('[console] 启动失败：', error.message ?? error);
  process.exitCode = 1;
});
