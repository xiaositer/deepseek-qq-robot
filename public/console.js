const state = {
  settings: null,
  status: null,
  logs: [],
  lastLogId: 0,
  busy: false
};

const $ = (id) => document.getElementById(id);
const pages = [...document.querySelectorAll('.page')];
const titles = {
  overview: '运行概览', access: 'QQ 接入', model: '模型配置', behavior: '聊天行为',
  persona: '角色卡', advanced: '高级设置', logs: '运行日志'
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {})
    }
  });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) throw new Error(body.error || `请求失败：${response.status}`);
  return body;
}

function showToast(message, error = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function setPage(name) {
  pages.forEach((page) => page.classList.toggle('active', page.dataset.page === name));
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === name));
  $('pageTitle').textContent = titles[name] ?? '控制台';
}

function idsFrom(text) {
  return [...new Set(text.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean))];
}

function number(id) { return Number($(id).value); }

function fillSettings(payload) {
  state.settings = payload;
  const { config, persona, secrets } = payload;
  $('onebotWsUrl').value = config.onebot.wsUrl ?? '';
  $('privateAllow').value = (config.allow.private ?? []).join('\n');
  $('groupAllow').value = (config.allow.groups ?? []).join('\n');
  $('groupReplyMode').value = config.chat.groupReplyMode ?? 'off';
  $('naturalReviewEvery').value = config.chat.naturalReviewEveryMessages ?? 3;
  $('naturalReviewOpenQuestions').checked = config.chat.naturalReviewOpenQuestions !== false;
  $('groupInputDebounce').value = config.chat.groupInputDebounceMs ?? 8000;
  $('groupMaxInputWait').value = config.chat.groupMaxInputWaitMs ?? 20000;
  $('deepseekBaseUrl').value = config.deepseek.baseUrl ?? '';
  $('deepseekModel').value = config.deepseek.model ?? '';
  $('deepseekTimeout').value = config.deepseek.timeoutMs ?? 45000;
  $('deepseekRetries').value = config.deepseek.maxRetries ?? 2;
  $('deepseekMaxTokens').value = config.deepseek.maxTokens ?? 600;
  $('inputDebounce').value = config.chat.inputDebounceMs ?? 1800;
  $('shortInputDebounce').value = config.chat.shortInputDebounceMs ?? 3000;
  $('maxInputWait').value = config.chat.maxInputWaitMs ?? 8000;
  $('maxReplyChars').value = config.chat.maxReplyChars ?? 500;
  $('maxReplyParts').value = config.chat.maxReplyParts ?? 3;
  $('sendGap').value = config.chat.sendGapMs ?? 700;
  $('contextMessages').value = config.chat.contextMessages ?? 24;
  $('perMinuteLimit').value = config.chat.perMinuteLimit ?? 8;
  $('globalPerMinuteLimit').value = config.chat.globalPerMinuteLimit ?? 30;
  $('personaPath').value = config.personaPath ?? 'persona/fixed.md';
  $('statePath').value = config.statePath ?? 'state/recent-context.json';
  $('consolePort').value = config.console?.port ?? 3100;
  $('autoStartChat').checked = Boolean(config.console?.autoStartChat);
  $('personaEditor').value = persona;
  $('personaCount').textContent = persona.length.toLocaleString();
  $('deepseekKeyState').textContent = secrets.hasDeepseekApiKey ? '当前已配置；留空不会覆盖。' : '当前未配置。';
  $('onebotTokenState').textContent = secrets.hasOnebotAccessToken ? '当前已配置；留空不会覆盖。' : '当前未配置。';
  $('deepseekBadge').textContent = secrets.hasDeepseekApiKey ? '已配置' : '未配置';
  $('deepseekBadge').classList.toggle('good', secrets.hasDeepseekApiKey);
  $('metricAllow').textContent = `${config.allow.private.length} / ${config.allow.groups.length}`;
  $('metricModel').textContent = config.deepseek.model;
  $('metricApi').textContent = new URL(config.deepseek.baseUrl).hostname;
}

function collectSettings() {
  const current = structuredClone(state.settings.config);
  current.onebot.wsUrl = $('onebotWsUrl').value.trim();
  current.allow.private = idsFrom($('privateAllow').value);
  current.allow.groups = idsFrom($('groupAllow').value);
  current.chat.groupReplyMode = $('groupReplyMode').value;
  current.chat.naturalReviewEveryMessages = number('naturalReviewEvery');
  current.chat.naturalReviewOpenQuestions = $('naturalReviewOpenQuestions').checked;
  current.chat.groupInputDebounceMs = number('groupInputDebounce');
  current.chat.groupMaxInputWaitMs = number('groupMaxInputWait');
  current.deepseek.baseUrl = $('deepseekBaseUrl').value.trim();
  current.deepseek.model = $('deepseekModel').value.trim();
  current.deepseek.timeoutMs = number('deepseekTimeout');
  current.deepseek.maxRetries = number('deepseekRetries');
  current.deepseek.maxTokens = number('deepseekMaxTokens');
  current.chat.inputDebounceMs = number('inputDebounce');
  current.chat.shortInputDebounceMs = number('shortInputDebounce');
  current.chat.maxInputWaitMs = number('maxInputWait');
  current.chat.maxReplyChars = number('maxReplyChars');
  current.chat.maxReplyParts = number('maxReplyParts');
  current.chat.sendGapMs = number('sendGap');
  current.chat.contextMessages = number('contextMessages');
  current.chat.perMinuteLimit = number('perMinuteLimit');
  current.chat.globalPerMinuteLimit = number('globalPerMinuteLimit');
  current.personaPath = $('personaPath').value.trim();
  current.statePath = $('statePath').value.trim();
  current.console = { port: number('consolePort'), autoStartChat: $('autoStartChat').checked };
  return {
    config: current,
    persona: $('personaEditor').value,
    secrets: {
      deepseekApiKey: $('deepseekApiKey').value,
      onebotAccessToken: $('onebotToken').value,
      clearDeepseekApiKey: $('clearDeepseekKey').checked,
      clearOnebotAccessToken: $('clearOnebotToken').checked
    },
    restartChat: Boolean(state.status?.chat?.running)
  };
}

function updateStatus(payload) {
  state.status = payload;
  const running = payload.chat.running;
  $('chatPill').classList.toggle('running', running);
  $('chatPill').querySelector('b').textContent = running ? '聊天运行中' : payload.chat.state === 'crashed' ? '聊天异常退出' : '聊天已停止';
  $('sideDot').classList.toggle('online', running);
  $('sideStatus').textContent = running ? '聊天运行中' : '控制台在线';
  $('metricChat').textContent = running ? '运行中' : payload.chat.state === 'crashed' ? '异常退出' : '已停止';
  $('metricPid').textContent = payload.chat.pid ? `PID ${payload.chat.pid}` : 'PID —';
  $('workerBadge').textContent = running ? '运行中' : payload.chat.state === 'crashed' ? '异常' : '已停止';
  $('workerBadge').classList.toggle('good', running);
  $('toggleChatButton').textContent = running ? '停止聊天' : '启动聊天';
  const snowOk = payload.snowluma.webSocket;
  $('metricSnow').textContent = snowOk ? '已连接' : '未连接';
  $('metricSnowDetail').textContent = `WS :${payload.snowluma.wsPort}`;
  $('snowBadge').textContent = snowOk ? '正常' : '离线';
  $('snowBadge').classList.toggle('good', snowOk);
}

function renderLogs() {
  const output = $('logOutput');
  const mini = $('miniLogs');
  if (!state.logs.length) {
    output.innerHTML = '<div class="empty">暂无日志</div>';
    mini.innerHTML = '<div class="empty">暂无运行日志</div>';
    return;
  }
  output.innerHTML = '';
  for (const entry of state.logs) {
    const row = document.createElement('div');
    row.className = `log-line ${entry.level}`;
    const time = document.createElement('time');
    time.textContent = new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false });
    const level = document.createElement('span');
    level.className = 'level';
    level.textContent = entry.level;
    const message = document.createElement('span');
    message.textContent = entry.message;
    row.append(time, level, message);
    output.append(row);
  }
  output.scrollTop = output.scrollHeight;
  mini.innerHTML = '';
  for (const entry of state.logs.slice(-5)) {
    const row = document.createElement('div');
    row.className = 'mini-log';
    const time = document.createElement('b');
    time.textContent = new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false });
    row.append(time, document.createTextNode(entry.message));
    mini.append(row);
  }
}

async function refreshStatus() {
  try { updateStatus(await api('/api/status')); } catch (error) { console.error(error); }
}

async function refreshLogs() {
  try {
    const payload = await api(`/api/logs?after=${state.lastLogId}`);
    if (payload.logs.length) {
      state.logs.push(...payload.logs);
      state.logs = state.logs.slice(-500);
      state.lastLogId = payload.logs.at(-1).id;
      renderLogs();
    }
  } catch (error) { console.error(error); }
}

async function setBusy(value) {
  state.busy = value;
  document.querySelectorAll('.header-actions button, #toggleChatButton').forEach((button) => { button.disabled = value; });
}

async function saveAll() {
  if (state.busy) return;
  await setBusy(true);
  try {
    const result = await api('/api/settings', { method: 'PUT', body: JSON.stringify(collectSettings()) });
    $('deepseekApiKey').value = '';
    $('onebotToken').value = '';
    $('clearDeepseekKey').checked = false;
    $('clearOnebotToken').checked = false;
    fillSettings(await api('/api/settings'));
    await refreshStatus();
    showToast(result.consoleRestartRequired ? '保存成功；控制台端口需手动重启后生效' : '配置已保存并应用');
  } catch (error) { showToast(error.message, true); }
  finally { await setBusy(false); }
}

async function chatAction(action) {
  if (state.busy) return;
  await setBusy(true);
  try {
    await api(`/api/chat/${action}`, { method: 'POST', body: '{}' });
    await refreshStatus();
    await refreshLogs();
    showToast(action === 'start' ? '聊天服务已启动' : action === 'stop' ? '聊天服务已停止' : '聊天服务已重启');
  } catch (error) { showToast(error.message, true); }
  finally { await setBusy(false); }
}

let pollingStarted = false;
function startPolling() {
  if (pollingStarted) return;
  pollingStarted = true;
  setInterval(refreshStatus, 3000);
  setInterval(refreshLogs, 2000);
}

async function bootstrap() {
  try {
    fillSettings(await api('/api/settings'));
    await Promise.all([refreshStatus(), refreshLogs()]);
    startPolling();
  } catch (error) { showToast(error.message, true); }
}

document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => setPage(item.dataset.page)));
document.querySelectorAll('[data-jump]').forEach((item) => item.addEventListener('click', () => setPage(item.dataset.jump)));
$('personaEditor').addEventListener('input', () => { $('personaCount').textContent = $('personaEditor').value.length.toLocaleString(); });
$('saveButton').addEventListener('click', saveAll);
$('restartButton').addEventListener('click', () => chatAction('restart'));
$('toggleChatButton').addEventListener('click', () => chatAction(state.status?.chat?.running ? 'stop' : 'start'));
$('clearLogsButton').addEventListener('click', () => { state.logs = []; renderLogs(); });

bootstrap();
