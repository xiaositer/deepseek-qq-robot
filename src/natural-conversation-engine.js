const DIRECT_NAME_PATTERN = /(?:小鲸鱼|鲸鱼|D指导|deepseek)/i;
const OPEN_QUESTION_PATTERN = /[?？]|(?:谁|有没有人|你们|大家).{0,12}(?:知道|觉得|推荐|来|说|看)/i;
const ACTIONS = new Set(['send', 'wait', 'read', 'stay']);

export function parseNaturalDecision(content) {
  const raw = String(content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { action: 'read', messages: [], invalid: true };
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    const action = ACTIONS.has(String(value.action).toLowerCase()) ? String(value.action).toLowerCase() : 'read';
    const messages = Array.isArray(value.messages)
      ? value.messages.map((item) => String(item).trim()).filter(Boolean).slice(0, 4)
      : [];
    return {
      action: action === 'send' && !messages.length ? 'read' : action,
      messages,
      topic: String(value.topic ?? '').trim().slice(0, 120),
      focusUserIds: Array.isArray(value.focusUserIds)
        ? [...new Set(value.focusUserIds.map(String).filter(Boolean))].slice(0, 10)
        : [],
      invalid: false
    };
  } catch {
    return { action: 'read', messages: [], invalid: true };
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
    let reason = directReason;
    if (!reason && state.phase !== 'sleeping') reason = `当前处于 ${state.phase} 状态，需要继续观察这个话题`;
    if (!reason && this.#reviewOpenQuestions && OPEN_QUESTION_PATTERN.test(message.content)) reason = '群里出现开放问题，值得查看但不代表必须回复';
    if (!reason && state.unreviewedMessages >= this.#reviewEveryMessages) reason = `已积累 ${state.unreviewedMessages} 条未审阅消息，进行一次语义查看`;
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
      state.lastSpokeAt = now;
      const ids = this.#botMessageIds.get(message.conversationId) ?? new Set();
      for (const id of messageIds.map(String).filter(Boolean)) ids.add(id);
      while (ids.size > 100) ids.delete(ids.values().next().value);
      this.#botMessageIds.set(message.conversationId, ids);
    } else if (decision.action === 'wait') {
      state.phase = 'waiting';
      if (!state.focusUserIds.length) state.focusUserIds = [String(message.senderId)];
    } else if (decision.action === 'stay') {
      state.phase = 'observing';
    } else {
      state.phase = 'sleeping';
      state.focusUserIds = [];
      state.topic = '';
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
      lastSpokeAt: state.lastSpokeAt
    };
  }

  #directReason(message) {
    if (message.mentionedSelf) return '对方明确 @ 了你';
    if (message.replyMessageId && this.#botMessageIds.get(message.conversationId)?.has(String(message.replyMessageId))) {
      return '对方引用回复了你发过的消息';
    }
    if (DIRECT_NAME_PATTERN.test(message.content)) return '对方在文字中点了你的名字';
    const state = this.#state(message.conversationId);
    if (state.focusUserIds.includes(String(message.senderId))) return '当前关注的群友继续发言';
    return '';
  }

  #state(conversationId) {
    let state = this.#states.get(conversationId);
    if (!state) {
      state = { phase: 'sleeping', focusUserIds: [], topic: '', unreviewedMessages: 0, lastSpokeAt: 0, lastDecisionAt: 0 };
      this.#states.set(conversationId, state);
    }
    return state;
  }
}
