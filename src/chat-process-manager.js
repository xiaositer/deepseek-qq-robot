import { fork } from 'node:child_process';
import path from 'node:path';

function linesFrom(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onLine(line);
  });
  stream.on('end', () => { if (buffer.trim()) onLine(buffer); });
}

export class ChatProcessManager {
  #rootDir;
  #child = null;
  #state = 'stopped';
  #logs = [];
  #sequence = 0;
  #expectedExit = false;

  constructor({ rootDir }) {
    this.#rootDir = rootDir;
  }

  status() {
    return {
      state: this.#state,
      pid: this.#child?.pid ?? null,
      running: Boolean(this.#child && this.#state === 'running')
    };
  }

  logs(after = 0) {
    return this.#logs.filter((entry) => entry.id > after);
  }

  async start() {
    if (this.#child) return this.status();
    this.#state = 'starting';
    this.#expectedExit = false;
    this.#log('system', '正在启动聊天服务');
    const child = fork(path.join(this.#rootDir, 'src', 'index.js'), [], {
      cwd: this.#rootDir,
      env: { ...process.env },
      silent: true
    });
    this.#child = child;
    linesFrom(child.stdout, (line) => this.#log('stdout', line));
    linesFrom(child.stderr, (line) => this.#log('stderr', line));
    child.once('spawn', () => {
      if (this.#child === child) this.#state = 'running';
      this.#log('system', `聊天服务已启动 PID=${child.pid}`);
    });
    child.once('error', (error) => this.#log('stderr', `启动失败：${error.message}`));
    child.once('exit', (code, signal) => {
      if (this.#child === child) this.#child = null;
      this.#state = this.#expectedExit ? 'stopped' : 'crashed';
      this.#log(this.#expectedExit ? 'system' : 'stderr', `聊天服务已退出 code=${code ?? '-'} signal=${signal ?? '-'}`);
      this.#expectedExit = false;
    });
    return this.status();
  }

  async stop() {
    const child = this.#child;
    if (!child) {
      this.#state = 'stopped';
      return this.status();
    }
    this.#state = 'stopping';
    this.#expectedExit = true;
    this.#log('system', '正在停止聊天服务');
    try { child.send({ type: 'shutdown' }); } catch {}
    await new Promise((resolve) => {
      let done = false;
      let timer;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      child.once('exit', finish);
      timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish();
      }, 5_000);
      timer.unref?.();
    });
    return this.status();
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  async close() {
    await this.stop();
  }

  #log(source, message) {
    const level = source === 'stderr' ? 'error' : source === 'system' ? 'system' : 'info';
    this.#logs.push({ id: ++this.#sequence, time: new Date().toISOString(), level, source, message: String(message) });
    if (this.#logs.length > 500) this.#logs.splice(0, this.#logs.length - 500);
  }
}
