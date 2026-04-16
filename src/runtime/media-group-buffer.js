function mediaGroupKey(chatId, mediaGroupId) {
  return `${chatId}:${mediaGroupId}`;
}

export class MediaGroupBuffer {
  constructor({ quietPeriodMs }) {
    this.quietPeriodMs = quietPeriodMs;
    this.pendingMediaGroups = new Map();
  }

  hasPending() {
    return this.pendingMediaGroups.size > 0;
  }

  queue(session, message) {
    const mediaGroupId = message?.media_group_id;
    if (!mediaGroupId) {
      return session.handleAttachmentMessages([message]);
    }

    const key = mediaGroupKey(session.chatId, mediaGroupId);
    const existing = this.pendingMediaGroups.get(key);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const entry = existing ?? {
      session,
      messages: []
    };
    entry.messages.push(message);
    entry.timer = setTimeout(() => {
      void this.flush(key);
    }, this.quietPeriodMs);

    this.pendingMediaGroups.set(key, entry);
    return undefined;
  }

  async flush(key) {
    const entry = this.pendingMediaGroups.get(key);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    this.pendingMediaGroups.delete(key);
    await entry.session.handleAttachmentMessages(entry.messages);
  }

  clear() {
    for (const entry of this.pendingMediaGroups.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingMediaGroups.clear();
  }
}
