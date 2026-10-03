import { it, expect } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
it('isolates persisted photos by conversation and retains at most four recent images', () => {
  const w = new WorkspaceStore(':memory:', 'owner');
  try {
    const dot = w.dots()[0];
    w.bindThread('one', dot.id, 'One');
    w.bindThread('two', dot.id, 'Two');
    for (let n = 0; n < 6; n++)
      w.saveTelegramImage('one', 'image/png', Buffer.from([n]));
    expect(w.telegramImages('one')).toHaveLength(4);
    expect(w.telegramImages('two')).toEqual([]);
    expect(() => w.telegramImages('unowned')).toThrow();
  } finally {
    w.close();
  }
});
it('binds approval to its chat/user scope, rechecks grants and saves exactly once', () => {
  const w = new WorkspaceStore(':memory:', 'owner');
  try {
    const dot = w.dots()[0];
    w.bindThread('thread', dot.id, 'Review');
    const draft = {
      title: 'Document',
      content: 'Reviewed content',
      spaceId: dot.spaceId,
    };
    const id = w.createTelegramReview('codex:bot:chat:user', 'thread', draft);
    expect(() => w.resolveTelegramReview(id, 'other-chat', true)).toThrow();
    expect(w.pages.list(dot.spaceId)).toEqual([]);
    const page = w.resolveTelegramReview(id, 'codex:bot:chat:user', true);
    expect(page?.content).toBe('Reviewed content');
    expect(() =>
      w.resolveTelegramReview(id, 'codex:bot:chat:user', true),
    ).toThrow();
    expect(w.pages.list(dot.spaceId)).toHaveLength(1);
    const denied = w.createTelegramReview('scope', 'thread', {
      ...draft,
      spaceId: 'not-authorized',
    });
    expect(() => w.resolveTelegramReview(denied, 'scope', true)).toThrow();
    expect(w.resolveTelegramReview(denied, 'scope', false)).toBeUndefined();
    const declined = w.createTelegramReview('scope', 'thread', draft);
    expect(() => w.createTelegramReview('scope', 'thread', draft)).toThrow(
      'pending',
    );
    expect(w.resolveTelegramReview(declined, 'scope', false)).toBeUndefined();
    expect(w.pages.list(dot.spaceId)).toHaveLength(1);
  } finally {
    w.close();
  }
});
