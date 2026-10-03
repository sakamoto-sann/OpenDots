import { ComputerStore } from './computer-store.js';
import { Pages } from './pages.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateLearningSettings } from '../shared/learning.js';
import type { CallReceipt, Conversation, Dot, Space } from '../shared/types.js';
export class WorkspaceStore {
  private db: DatabaseSync;
  readonly pages: Pages;
  readonly computers: ComputerStore;
  constructor(
    path: string,
    readonly ownerId: string,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_threads(chatId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_local_turns(id INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL, prompt TEXT NOT NULL, reply TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_images(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_reviews(id TEXT PRIMARY KEY, scope TEXT NOT NULL, threadId TEXT NOT NULL, draft TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, pageId TEXT);
      CREATE TABLE IF NOT EXISTS local_dot_skills(dotId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, files TEXT NOT NULL, PRIMARY KEY(dotId,name));
      CREATE TABLE IF NOT EXISTS local_runtime_threads(threadId TEXT PRIMARY KEY, backend TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_state(botId TEXT PRIMARY KEY, nextOffset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    for (const [table, column, definition] of [
      ['dots', 'learningContainerId', 'TEXT'],
      ['dots', 'skillDeliveryEnabled', 'INTEGER NOT NULL DEFAULT 0'],
      ['thread_bindings', 'learningContainerId', 'TEXT'],
    ]) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    // Migrate only once: restarting must never restore a revoked grant.
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='dot_spaces'",
        )
        .get()
    ) {
      this.db.exec(`BEGIN;
        CREATE TABLE dot_spaces(dotId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(dotId, spaceId));
        INSERT INTO dot_spaces SELECT id, spaceId FROM dots;
        COMMIT;`);
    }
    this.computers = new ComputerStore(this.db);
    this.pages = new Pages(this.db, (id) =>
      this.spaces().some((space) => space.id === id),
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(calls)')
        .all()
        .some((column) => column.name === 'anchorMessageId')
    )
      this.db.exec('ALTER TABLE calls ADD COLUMN anchorMessageId TEXT');
    if (!this.spaces().length) {
      const space = this.createSpace(
        'Everyday',
        'A little space for your day.',
      );
      this.createDot(
        space.id,
        'Dot',
        'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
        true,
        true,
      );
    }
  }
  close() {
    this.db.close();
  }
  spaces(): Space[] {
    return this.db
      .prepare('SELECT * FROM spaces ORDER BY createdAt')
      .all() as unknown as Space[];
  }
  createSpace(name: string, description: string): Space {
    const space = {
      id: randomUUID(),
      name,
      description,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)')
      .run(space.id, name, description, space.createdAt);
    return space;
  }
  dots(): Dot[] {
    return this.db
      .prepare('SELECT * FROM dots ORDER BY createdAt')
      .all()
      .map((row) => ({
        ...row,
        spaceIds: this.db
          .prepare(
            'SELECT spaceId FROM dot_spaces WHERE dotId=? ORDER BY spaceId',
          )
          .all(String(row.id))
          .map((grant) => String(grant.spaceId)),
        researchAllowed: !!row.researchAllowed,
        memoryAllowed: !!row.memoryAllowed,
        skillDeliveryEnabled: !!row.skillDeliveryEnabled,
      })) as unknown as Dot[];
  }
  dot(id: string) {
    return this.dots().find((dot) => dot.id === id);
  }
  createDot(
    spaceId: string,
    name: string,
    instructions: string,
    researchAllowed: boolean,
    memoryAllowed: boolean,
    spaceIds: string[] = [spaceId],
    learningContainerId: string | null = null,
    skillDeliveryEnabled = false,
  ): Dot {
    this.validateSpaceAccess(spaceId, spaceIds);
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    const dot: Dot = {
      id: randomUUID(),
      spaceId,
      spaceIds: [...new Set(spaceIds)].sort(),
      name,
      instructions,
      researchAllowed,
      memoryAllowed,
      learningContainerId,
      skillDeliveryEnabled,
      createdAt: Date.now(),
    };
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, learningContainerId, skillDeliveryEnabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          dot.id,
          spaceId,
          name,
          instructions,
          +researchAllowed,
          +memoryAllowed,
          dot.createdAt,
          learningContainerId,
          +skillDeliveryEnabled,
        );
      for (const id of dot.spaceIds)
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(dot.id, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return dot;
  }
  canAccessSpace(dotId: string, spaceId: string) {
    return !!this.db
      .prepare('SELECT 1 FROM dot_spaces WHERE dotId=? AND spaceId=?')
      .get(dotId, spaceId);
  }
  private validateSpaceAccess(defaultSpace: string, spaceIds: string[]) {
    if (
      !spaceIds.includes(defaultSpace) ||
      spaceIds.some((id) => !this.spaces().some((space) => space.id === id))
    )
      throw new Error('Space access must include a valid default destination.');
  }
  updateDot(
    id: string,
    patch: Pick<
      Dot,
      'name' | 'instructions' | 'researchAllowed' | 'memoryAllowed'
    > & {
      spaceId?: string;
      spaceIds?: string[];
      learningContainerId?: string | null;
      skillDeliveryEnabled?: boolean;
    },
  ): Dot {
    const current = this.dot(id);
    if (!current) throw new Error('Dot not found.');
    const defaultSpace = patch.spaceId ?? current.spaceId;
    const spaceIds = patch.spaceIds ?? current.spaceIds;
    this.validateSpaceAccess(defaultSpace, spaceIds);
    const learningContainerId =
      patch.learningContainerId === undefined
        ? (current.learningContainerId ?? null)
        : patch.learningContainerId;
    const skillDeliveryEnabled =
      patch.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false;
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'UPDATE dots SET name=?, instructions=?, researchAllowed=?, memoryAllowed=?, learningContainerId=?, skillDeliveryEnabled=? WHERE id=?',
        )
        .run(
          patch.name,
          patch.instructions,
          +patch.researchAllowed,
          +patch.memoryAllowed,
          learningContainerId,
          +skillDeliveryEnabled,
          id,
        );
      this.db
        .prepare('UPDATE dots SET spaceId=? WHERE id=?')
        .run(defaultSpace, id);
      this.db.prepare('DELETE FROM dot_spaces WHERE dotId=?').run(id);
      for (const space of new Set(spaceIds))
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(id, space);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.dot(id)!;
  }
  conversations(): Conversation[] {
    return this.db
      .prepare(
        'SELECT * FROM thread_bindings WHERE ownerId=? ORDER BY createdAt DESC',
      )
      .all(this.ownerId) as unknown as Conversation[];
  }
  bindThread(id: string, dotId: string, title: string): Conversation {
    const dot = this.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    const value: Conversation = {
      id,
      dotId,
      ownerId: this.ownerId,
      title,
      createdAt: Date.now(),
      learningContainerId: dot.learningContainerId ?? null,
    };
    this.db
      .prepare(
        'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, learningContainerId) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        dotId,
        this.ownerId,
        title,
        value.createdAt,
        value.learningContainerId ?? null,
      );
    return value;
  }
  localSkills(dotId: string) {
    if (!this.dot(dotId)) throw new Error('Dot unavailable');
    return this.db
      .prepare(
        'SELECT name,description FROM local_dot_skills WHERE dotId=? ORDER BY name LIMIT 50',
      )
      .all(dotId) as Array<{ name: string; description: string }>;
  }
  saveLocalSkill(
    dotId: string,
    name: string,
    description: string,
    files: Record<string, string>,
  ) {
    if (!this.dot(dotId)) throw new Error('Dot unavailable');
    if (JSON.stringify(files).length > 80000)
      throw new Error('Skill size limit');
    this.db
      .prepare(
        'INSERT INTO local_dot_skills VALUES (?,?,?,?) ON CONFLICT(dotId,name) DO UPDATE SET description=excluded.description,files=excluded.files',
      )
      .run(dotId, name, description, JSON.stringify(files));
    return { name, description };
  }
  readLocalSkill(dotId: string, name: string, path = 'SKILL.md') {
    if (!this.dot(dotId)) throw new Error('Dot unavailable');
    const row = this.db
      .prepare('SELECT files FROM local_dot_skills WHERE dotId=? AND name=?')
      .get(dotId, name) as { files: string } | undefined;
    const value = row ? JSON.parse(row.files)[path] : undefined;
    if (typeof value !== 'string')
      throw new Error('Local skill file unavailable');
    return { name, path, content: value };
  }
  localRuntime(threadId: string, backend?: string) {
    this.requireThread(threadId);
    if (backend)
      this.db
        .prepare(
          'INSERT INTO local_runtime_threads VALUES (?,?) ON CONFLICT(threadId) DO UPDATE SET backend=excluded.backend',
        )
        .run(threadId, backend);
    return (
      this.db
        .prepare('SELECT backend FROM local_runtime_threads WHERE threadId=?')
        .get(threadId) as { backend: string } | undefined
    )?.backend;
  }
  saveTelegramImage(threadId: string, mime: string, bytes: Uint8Array) {
    this.requireThread(threadId);
    if (!['image/png', 'image/jpeg'].includes(mime) || bytes.length > 5000000)
      throw new Error('Image limit');
    this.db
      .prepare('INSERT INTO telegram_images VALUES (?,?,?,?,?)')
      .run(randomUUID(), threadId, mime, bytes, Date.now());
    this.db
      .prepare(
        'DELETE FROM telegram_images WHERE threadId=? AND id NOT IN (SELECT id FROM telegram_images WHERE threadId=? ORDER BY createdAt DESC,rowid DESC LIMIT 4)',
      )
      .run(threadId, threadId);
  }
  telegramImages(threadId: string) {
    this.requireThread(threadId);
    return this.db
      .prepare(
        'SELECT mime,bytes FROM telegram_images WHERE threadId=? ORDER BY createdAt,rowid',
      )
      .all(threadId) as unknown as Array<{
      mime: 'image/png' | 'image/jpeg';
      bytes: Uint8Array;
    }>;
  }
  pendingTelegramReview(threadId: string) {
    this.requireThread(threadId);
    return !!this.db
      .prepare(
        "SELECT id FROM telegram_reviews WHERE threadId=? AND status='pending' AND createdAt>?",
      )
      .get(threadId, Date.now() - 86400000);
  }
  createTelegramReview(scope: string, threadId: string, draft: unknown) {
    this.requireThread(threadId);
    if (this.pendingTelegramReview(threadId))
      throw new Error('Await the pending review');
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO telegram_reviews VALUES (?,?,?,?,?,?,NULL)')
      .run(id, scope, threadId, JSON.stringify(draft), 'pending', Date.now());
    return id;
  }
  resolveTelegramReview(id: string, scope: string, approve: boolean) {
    const row = this.db
      .prepare('SELECT * FROM telegram_reviews WHERE id=? AND scope=?')
      .get(id, scope) as
      | {
          threadId: string;
          draft: string;
          status: string;
          createdAt: number;
          pageId: string | null;
        }
      | undefined;
    if (
      !row ||
      row.status !== 'pending' ||
      Date.now() - row.createdAt > 86400000
    )
      throw new Error('Review expired or unavailable');
    const thread = this.requireThread(row.threadId),
      dot = this.dot(thread.dotId);
    if (!dot) throw new Error('Dot unavailable');
    const draft = JSON.parse(row.draft) as {
      spaceId: string;
      title: string;
      content: string;
    };
    if (approve && !this.canAccessSpace(dot.id, draft.spaceId))
      throw new Error('Space access denied');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db
        .prepare(
          "UPDATE telegram_reviews SET status=? WHERE id=? AND scope=? AND status='pending'",
        )
        .run(approve ? 'approved' : 'declined', id, scope).changes;
      if (changed !== 1) throw new Error('Review already resolved');
      const page = approve
        ? this.pages.create(draft.spaceId, {
            title: draft.title,
            content: draft.content,
          })
        : undefined;
      if (page)
        this.db
          .prepare('UPDATE telegram_reviews SET pageId=? WHERE id=?')
          .run(page.id, id);
      this.db.exec('COMMIT');
      return page;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  localTelegramHistory(
    threadId: string,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    this.requireThread(threadId);
    const rows = this.db
      .prepare(
        'SELECT prompt, reply FROM telegram_local_turns WHERE threadId=? ORDER BY id DESC LIMIT 12',
      )
      .all(threadId) as Array<{ prompt: string; reply: string }>;
    return rows.reverse().flatMap((row) => [
      { role: 'user' as const, content: row.prompt },
      { role: 'assistant' as const, content: row.reply },
    ]);
  }
  saveLocalTelegramTurn(threadId: string, prompt: string, reply: string) {
    this.requireThread(threadId);
    this.db
      .prepare(
        'INSERT INTO telegram_local_turns(threadId, prompt, reply) VALUES (?, ?, ?)',
      )
      .run(threadId, prompt, reply);
  }
  telegramThread(chatId: string): string | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM telegram_threads WHERE chatId=?')
      .get(chatId) as { threadId: string } | undefined;
    return row?.threadId;
  }
  telegramOffset(botId: string): number | undefined {
    const row = this.db
      .prepare('SELECT nextOffset FROM telegram_state WHERE botId=?')
      .get(botId) as { nextOffset: number } | undefined;
    return row?.nextOffset;
  }
  setTelegramOffset(botId: string, nextOffset: number) {
    this.db
      .prepare(
        'INSERT INTO telegram_state (botId, nextOffset) VALUES (?, ?) ON CONFLICT(botId) DO UPDATE SET nextOffset=excluded.nextOffset',
      )
      .run(botId, nextOffset);
  }
  bindTelegramThread(chatId: string, threadId: string, dotId: string) {
    this.requireThread(threadId, dotId);
    this.db
      .prepare('INSERT INTO telegram_threads (chatId, threadId) VALUES (?, ?)')
      .run(chatId, threadId);
  }
  requireThread(id: string, dotId?: string): Conversation {
    const thread = this.conversations().find((thread) => thread.id === id);
    if (!thread || (dotId && thread.dotId !== dotId))
      throw new Error('Conversation does not belong to this Dot and owner.');
    return thread;
  }
  bindTask(taskId: string, threadId: string) {
    this.requireThread(threadId);
    this.db
      .prepare('INSERT INTO task_threads VALUES (?, ?)')
      .run(taskId, threadId);
  }
  taskThread(taskId: string): string | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM task_threads WHERE taskId=?')
      .get(taskId);
    return typeof row?.threadId === 'string' ? row.threadId : undefined;
  }
  calls(threadId?: string): CallReceipt[] {
    if (threadId) this.requireThread(threadId);
    return this.db
      .prepare(
        `SELECT * FROM calls ${threadId ? 'WHERE threadId=?' : ''} ORDER BY startedAt DESC`,
      )
      .all(...(threadId ? [threadId] : [])) as unknown as CallReceipt[];
  }
  createCall(threadId: string): CallReceipt {
    this.requireThread(threadId);
    const call: CallReceipt = {
      id: randomUUID(),
      threadId,
      startedAt: Date.now(),
      endedAt: null,
      status: 'connecting',
      transcript: '',
      error: null,
    };
    this.db
      .prepare(
        'INSERT INTO calls(id, threadId, startedAt, endedAt, status, transcript, error) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
      )
      .run(call.id, threadId, call.startedAt, call.status, '');
    return call;
  }
  call(id: string): CallReceipt {
    const call = this.calls().find((call) => call.id === id);
    if (!call) throw new Error('Call not found.');
    this.requireThread(call.threadId);
    return call;
  }
  setCall(
    id: string,
    status: CallReceipt['status'],
    transcript: string,
    error: string | null = null,
  ) {
    const call = this.call(id);
    if (call.endedAt) return call;
    this.db
      .prepare(
        'UPDATE calls SET status=?, transcript=?, error=?, endedAt=? WHERE id=?',
      )
      .run(
        status,
        transcript,
        error,
        status === 'ended' || status === 'failed' ? Date.now() : null,
        id,
      );
    return this.call(id);
  }
  saveLateTranscript(id: string, transcript: string) {
    this.call(id);
    return (
      this.db
        .prepare(
          "UPDATE calls SET transcript=? WHERE id=? AND transcript='' AND endedAt IS NOT NULL",
        )
        .run(transcript, id).changes > 0
    );
  }
  anchorCall(id: string, anchor: string | undefined) {
    this.call(id);
    this.db
      .prepare('UPDATE calls SET anchorMessageId=? WHERE id=?')
      .run(anchor ?? null, id);
  }
  setCallError(id: string, error: string | null) {
    this.call(id);
    this.db.prepare('UPDATE calls SET error=? WHERE id=?').run(error, id);
  }
  saveCapture(threadId: string, value: unknown) {
    this.requireThread(threadId);
    this.db
      .prepare(
        'INSERT INTO captures VALUES (?, ?) ON CONFLICT(threadId) DO UPDATE SET value=excluded.value',
      )
      .run(threadId, JSON.stringify(value));
  }
  capture(threadId: string): unknown {
    this.requireThread(threadId);
    const row = this.db
      .prepare('SELECT value FROM captures WHERE threadId=?')
      .get(threadId);
    return typeof row?.value === 'string' ? JSON.parse(row.value) : null;
  }
}
