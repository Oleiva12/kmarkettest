import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config/settings.js';

// ─── Inicializar SQLite ───
const dbPath = path.resolve(config.paths.sqliteDb);
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Crear tablas
db.exec(`
  CREATE TABLE IF NOT EXISTS cached_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_hash TEXT UNIQUE NOT NULL,
    query TEXT NOT NULL,
    response TEXT NOT NULL,
    hit_count INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
  );
`);

// ─── Funciones de Caché ───

function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ');
}

function hashQuery(query: string): string {
  const normalized = normalizeQuery(query);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function getCachedResponse(query: string): string | null {
  const hash = hashQuery(query);
  const stmt = db.prepare(`
    SELECT response FROM cached_responses 
    WHERE query_hash = ? AND expires_at > datetime('now')
  `);
  const row = stmt.get(hash) as { response: string } | undefined;

  if (row) {
    // Increment hit count
    db.prepare('UPDATE cached_responses SET hit_count = hit_count + 1 WHERE query_hash = ?').run(hash);
    console.log(`🎯 Cache HIT para: "${query.substring(0, 50)}..."`);
    return row.response;
  }

  return null;
}

export function setCachedResponse(query: string, response: string): void {
  const hash = hashQuery(query);
  const ttlMs = config.cache.ttlHours * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO cached_responses (query_hash, query, response, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(hash, query, response, expiresAt);
}

// ─── Funciones de Sesión ───

export function getOrCreateSession(userId: string, channel: string): string {
  // Soporte para IDs explícitos (como los de Web)
  if (userId.startsWith('web-')) {
    const existingById = db.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(userId) as { id: string } | undefined;
    if (existingById) {
      db.prepare('UPDATE chat_sessions SET updated_at = datetime(\'now\') WHERE id = ?').run(existingById.id);
      return existingById.id;
    }
    db.prepare('INSERT INTO chat_sessions (id, channel, user_id) VALUES (?, ?, ?)').run(userId, channel, userId);
    return userId;
  }

  const existing = db.prepare(
    'SELECT id FROM chat_sessions WHERE user_id = ? AND channel = ? ORDER BY updated_at DESC LIMIT 1'
  ).get(userId, channel) as { id: string } | undefined;

  if (existing) {
    db.prepare('UPDATE chat_sessions SET updated_at = datetime(\'now\') WHERE id = ?').run(existing.id);
    return existing.id;
  }

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO chat_sessions (id, channel, user_id) VALUES (?, ?, ?)').run(id, channel, userId);
  return id;
}

export function linkWebSessionToTelegram(telegramUserId: string, webSessionId: string): boolean {
  // Verifica si existe la sesión web
  const existing = db.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(webSessionId);
  if (!existing) return false;

  // Convierte la sesión web en la sesión activa de Telegram para este usuario
  db.prepare('UPDATE chat_sessions SET channel = ?, user_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run('telegram', telegramUserId, webSessionId);
  return true;
}

export function addMessage(sessionId: string, role: 'user' | 'assistant', content: string): void {
  db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)').run(sessionId, role, content);
}

export function getRecentMessages(sessionId: string, limit: number = 10): Array<{ role: string; content: string }> {
  return db.prepare(
    'SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(sessionId, limit) as Array<{ role: string; content: string }>;
}

// ─── Cleanup ───
export function cleanExpiredCache(): void {
  db.prepare("DELETE FROM cached_responses WHERE expires_at <= datetime('now')").run();
}

export { db };
