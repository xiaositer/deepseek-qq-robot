const DIRECT_NAME_PATTERN = /(?:小鲸鱼|鲸鱼|D指导|deepseek)/i;
const OPEN_QUESTION_PATTERN = /[?？]|(?:谁|有没有人|你们|大家).{0,12}(?:知道|觉得|推荐|来|说|看)/i;
const ACTIONS = new Set(['send', 'wait', 'read', 'stay']);

function normalizeDecision(value, extra = {}) {
  const requestedAction = String(value.action ?? '').toLowerCase();
  const action = ACTIONS.has(requestedAction) ? requestedAction : 'read';
  const messages = Array.isArray(value.messages)
    ? value.messages.map((item) => String(item).trim()).filter(Boolean).slice(0, 4)
    : [value.messages, value.message, value.reply, value.content]
      .find((item) => typeof item === 'string' && item.trim())
      ?.split(/\r?\n+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 4) ?? [];
  const invalid = !ACTIONS.has(requestedAction) || (action === 'send' && !messages.length);
  return {
    action: action === 'send' && !messages.length ? 'read' : action,
    messages,
    topic: String(value.topic ?? '').trim().slice(0, 120),
    focusUserIds: Array.isArray(value.focusUserIds)
      ? [...new Set(value.focusUserIds.map(String).filter(Boolean))].slice(0, 10)
      : [],
    invalid,
    ...extra
  };
}

function decodeLooseString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

function parseLooseDecision(raw) {
  const action = raw.match(/"action"\s*:\s*"(send|wait|read|stay)"/i)?.[1]?.toLowerCase();
  if (!action) return null;

  const body = raw.match(/"messages"\s*:\s*\[([\s\S]*?)\]\s*(?=,\s*"(?:topic|focusUserIds)"\s*:|\s*})/)?.[1]?.trim();
  if (body === undefined) return null;
  let messages = [];
  if (body) {
    if (!body.startsWith('"') || !body.endsWith('"')) return null;
    messages = body.slice(1, -1).split(/"\s*,\s*"/).map(decodeLooseString);
  }

  const topicMatch = raw.match(/"topic"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const focusMatch = raw.match(/"focusUserIds"\s*:\s*(\[[^\]]*\])/);
  let focusUserIds = [];
  if (focusMatch) {
    try {
      const parsed = JSON.parse(focusMatch[1]);
      if (Array.isArray(parsed)) focusUserIds = parsed;
    } catch {
      return null;
    }
  }
  return {
    action,
    messages,
    topic: topicMatch ? decodeLooseString(topicMatch[1]) : '',
    focusUserIds
  };
}

export function parseNaturalDecision(content) {
  const raw = String(content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { action: 'read', messages: [], invalid: true };
  try {
    return normalizeDecision(JSON.parse(raw.slice(start, end + 1)));
  } catch {
    const repaired = parseLooseDecision(raw.slice(start, end + 1));
    return repaired
      ? normalizeDecision(repaired, { repaired: true })
      : { action: 'read', messages: [], invalid: true };
  }
}

export class NaturalConversationEngine {
  #reviewEveryMessages;
  #reviewOpenQuestions;
  #states = new Map();
  #botMessageIds = new Map();

  constructor({ reviewEveryMessages = 4, reviewOpenQuestions = true } = {}) {
    this.#reviewEveryMessages = reviewEveryMessages;
    this.#reviewOpenQuestions = reviewOpenQuestions;
  }

  observe(message) {
    const state = this.#state(message.conversationId);
    state.unreviewedMessages += Math.max(1, Number(message.batchSize) || 1);
    const directReason = this.#directReason(message);
    if (!directReason && state.focusUserIds.length && !state.focusUserIds.includes(String(message.senderId))) {
      state.focusUserIds = [];
      state.focusTurnsRemaining = 0;
      state.phase = 'sleeping';
      state.topic = '';
    }
    if (!directReason && this.#isAddressedElsewhere(message)) {
      state.focusUserIds = state.focusUserIds.filter((id) => id !== String(message.senderId));
      if (!state.focusUserIds.length) {
        state.phase = 'sleeping';
        state.topic = '';
        state.focusTurnsRemaining = 0;
      }
      return {
        review: false,
        reason: '本条消息明确回复或 @ 了其他群友，程序直接旁听',
        state: this.snapshot(message.conversationId)
      };
    }
    let reason = directReason;
    if (!reason && this.#reviewOpenQuestions && OPEN_QUESTION_PATTERN.test(message.content)) reason = '群里出现开放问题，值得查看但不代表必须回复';
    if (!reason && state.unreviewedMessages >= this.#reviewEveryMessages) {
      reason = this.#reviewEveryMessages === 1
        ? '新的群聊话轮，像普通群成员一样看看是否有自然参与点'
        : `已积累 ${state.unreviewedMessages} 条未审阅消息，进行一次语义查看`;
    }
    return { review: Boolean(reason), reason: reason || '消息已进入收件箱，继续旁听', state: this.snapshot(message.conversationId) };
  }

  applyDecision(message, decision, { messageIds = [], now = Date.now() } = {}) {
    const state = this.#state(message.conversationId);
    state.unreviewedMessages = 0;
    state.lastDecisionAt = now;
    if (decision.topic) state.topic = decision.topic;
    if (decision.focusUserIds?.length) state.focusUserIds = decision.focusUserIds;

    if (decision.action === 'send') {
      state.phase = 'observing';
      state.focusUserIds = decision.focusUserIds?.length ? decision.focusUserIds : [String(message.senderId)];
      state.focusTurnsRemaining = 1;
      state.lastSpokeAt = now;
      const ids = this.#botMessageIds.get(message.conversationId) ?? new Set();
      for (const id of messageIds.map(String).filter(Boolean)) ids.add(id);
      while (ids.size > 100) ids.delete(ids.values().next().value);
      this.#botMessageIds.set(message.conversationId, ids);
    } else if (decision.action === 'wait') {
      state.phase = 'waiting';
      if (!state.focusUserIds.length) state.focusUserIds = [String(message.senderId)];
      state.focusTurnsRemaining = 2;
    } else if (decision.action === 'stay') {
      state.phase = 'observing';
      state.focusTurnsRemaining = state.focusUserIds.length ? 1 : 0;
    } else {
      state.phase = 'sleeping';
      state.focusUserIds = [];
      state.topic = '';
      state.focusTurnsRemaining = 0;
    }
    return this.snapshot(message.conversationId);
  }

  snapshot(conversationId) {
    const state = this.#state(conversationId);
    return {
      phase: state.phase,
      focusUserIds: [...state.focusUserIds],
      topic: state.topic,
      unreviewedMessages: state.unreviewedMessages,
      lastSpokeAt: state.lastSpokeAt,
      focusTurnsRemaining: state.focusTurnsRemaining
    };
  }

  #directReason(message) {
    if (message.mentionedSelf) return '对方明确 @ 了你';
    if (message.replyTarget?.isSelf) return '对方引用回复了你发过的消息';
    if (message.replyMessageId && this.#botMessageIds.get(message.conversationId)?.has(String(message.replyMessageId))) {
      return '对方引用回复了你发过的消息';
    }
    if (DIRECT_NAME_PATTERN.test(message.content)) return '对方在文字中点了你的名字';
    const state = this.#state(message.conversationId);
    if (
      state.focusTurnsRemaining > 0
      && state.focusUserIds.includes(String(message.senderId))
      && !message.replyMessageId
      && !(message.mentionedUserIds ?? []).some((id) => String(id) !== String(message.selfId ?? ''))
    ) {
      state.focusTurnsRemaining -= 1;
      return '刚与你对话的群友继续说了一句，查看是否仍在接你的话';
    }
    return '';
  }

  #isAddressedElsewhere(message) {
    const mentionsOther = (message.mentionedUserIds ?? [])
      .some((id) => String(id) !== String(message.selfId ?? ''));
    if (mentionsOther && !message.mentionedSelf) return true;
    if (message.replyTarget) return !message.replyTarget.isSelf;
    if (!message.replyMessageId) return false;
    return !this.#botMessageIds.get(message.conversationId)?.has(String(message.replyMessageId));
  }

  #state(conversationId) {
    let state = this.#states.get(conversationId);
    if (!state) {
      state = {
        phase: 'sleeping', focusUserIds: [], focusTurnsRemaining: 0,
        topic: '', unreviewedMessages: 0, lastSpokeAt: 0, lastDecisionAt: 0
      };
      this.#states.set(conversationId, state);
    }
    return state;
  }
}
