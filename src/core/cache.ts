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

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    channel TEXT DEFAULT 'web',
    status TEXT DEFAULT 'nuevo',
    notes TEXT DEFAULT '',
    session_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS product_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_name TEXT NOT NULL,
    user_id TEXT DEFAULT '',
    channel TEXT DEFAULT 'web',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS category_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_name TEXT NOT NULL,
    user_id TEXT DEFAULT '',
    channel TEXT DEFAULT 'web',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS onboarding_state (
    session_id TEXT PRIMARY KEY,
    step TEXT DEFAULT 'none',
    first_name TEXT DEFAULT '',
    last_name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    completed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
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

// ─── Leads CRUD ───

export function createLead(data: {
  first_name: string;
  last_name?: string;
  email?: string;
  phone?: string;
  channel?: string;
  session_id?: string;
  notes?: string;
}): number {
  const stmt = db.prepare(`
    INSERT INTO leads (first_name, last_name, email, phone, channel, session_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    data.first_name,
    data.last_name || '',
    data.email || '',
    data.phone || '',
    data.channel || 'web',
    data.session_id || '',
    data.notes || ''
  );
  return result.lastInsertRowid as number;
}

export function updateLead(id: number, data: Partial<{
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  status: string;
  notes: string;
}>): boolean {
  const fields: string[] = [];
  const values: any[] = [];

  if (data.first_name !== undefined) { fields.push('first_name = ?'); values.push(data.first_name); }
  if (data.last_name !== undefined) { fields.push('last_name = ?'); values.push(data.last_name); }
  if (data.email !== undefined) { fields.push('email = ?'); values.push(data.email); }
  if (data.phone !== undefined) { fields.push('phone = ?'); values.push(data.phone); }
  if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
  if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }

  if (fields.length === 0) return false;

  fields.push("updated_at = datetime('now')");
  values.push(id);

  const stmt = db.prepare(`UPDATE leads SET ${fields.join(', ')} WHERE id = ?`);
  const result = stmt.run(...values);
  return result.changes > 0;
}

export function getAllLeads(filters?: { status?: string; channel?: string }): any[] {
  let query = 'SELECT * FROM leads';
  const conditions: string[] = [];
  const params: any[] = [];

  if (filters?.status) { conditions.push('status = ?'); params.push(filters.status); }
  if (filters?.channel) { conditions.push('channel = ?'); params.push(filters.channel); }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC';

  return db.prepare(query).all(...params);
}

export function getLeadById(id: number): any {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
}

export function getLeadBySessionId(sessionId: string): any {
  return db.prepare('SELECT * FROM leads WHERE session_id = ?').get(sessionId);
}

// ─── Product & Category Tracking ───

export function logProductQuery(productName: string, userId: string = '', channel: string = 'web'): void {
  db.prepare('INSERT INTO product_queries (product_name, user_id, channel) VALUES (?, ?, ?)').run(productName, userId, channel);
}

export function logCategoryQuery(categoryName: string, userId: string = '', channel: string = 'web'): void {
  db.prepare('INSERT INTO category_queries (category_name, user_id, channel) VALUES (?, ?, ?)').run(categoryName, userId, channel);
}

export function getTopProducts(limit: number = 10): Array<{ product_name: string; count: number }> {
  return db.prepare(`
    SELECT product_name, COUNT(*) as count 
    FROM product_queries 
    GROUP BY product_name 
    ORDER BY count DESC 
    LIMIT ?
  `).all(limit) as any[];
}

export function getTopCategories(limit: number = 10): Array<{ category_name: string; count: number }> {
  return db.prepare(`
    SELECT category_name, COUNT(*) as count 
    FROM category_queries 
    GROUP BY category_name 
    ORDER BY count DESC 
    LIMIT ?
  `).all(limit) as any[];
}

export function getDashboardSummary(): {
  totalLeads: number;
  leadsToday: number;
  totalChats: number;
  chatsToday: number;
  totalProductQueries: number;
  totalCategoryQueries: number;
} {
  const totalLeads = (db.prepare('SELECT COUNT(*) as c FROM leads').get() as any).c;
  const leadsToday = (db.prepare("SELECT COUNT(*) as c FROM leads WHERE date(created_at) = date('now')").get() as any).c;
  const totalChats = (db.prepare('SELECT COUNT(*) as c FROM chat_sessions').get() as any).c;
  const chatsToday = (db.prepare("SELECT COUNT(*) as c FROM chat_sessions WHERE date(created_at) = date('now')").get() as any).c;
  const totalProductQueries = (db.prepare('SELECT COUNT(*) as c FROM product_queries').get() as any).c;
  const totalCategoryQueries = (db.prepare('SELECT COUNT(*) as c FROM category_queries').get() as any).c;

  return { totalLeads, leadsToday, totalChats, chatsToday, totalProductQueries, totalCategoryQueries };
}

export function getActivityTimeline(days: number = 30): Array<{ date: string; chats: number; leads: number; queries: number }> {
  return db.prepare(`
    WITH dates AS (
      SELECT date('now', '-' || n || ' days') as d
      FROM (SELECT 0 as n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
            UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9
            UNION SELECT 10 UNION SELECT 11 UNION SELECT 12 UNION SELECT 13 UNION SELECT 14
            UNION SELECT 15 UNION SELECT 16 UNION SELECT 17 UNION SELECT 18 UNION SELECT 19
            UNION SELECT 20 UNION SELECT 21 UNION SELECT 22 UNION SELECT 23 UNION SELECT 24
            UNION SELECT 25 UNION SELECT 26 UNION SELECT 27 UNION SELECT 28 UNION SELECT 29)
      WHERE n < ?
    )
    SELECT 
      dates.d as date,
      COALESCE((SELECT COUNT(*) FROM chat_sessions WHERE date(created_at) = dates.d), 0) as chats,
      COALESCE((SELECT COUNT(*) FROM leads WHERE date(created_at) = dates.d), 0) as leads,
      COALESCE((SELECT COUNT(*) FROM product_queries WHERE date(created_at) = dates.d), 0) as queries
    FROM dates
    ORDER BY dates.d ASC
  `).all(days) as any[];
}

// ─── Onboarding State ───

export type OnboardingStep = 'none' | 'ask_name' | 'ask_lastname' | 'ask_email' | 'ask_phone' | 'done';

export interface OnboardingData {
  session_id: string;
  step: OnboardingStep;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  completed: number;
}

export function getOnboardingState(sessionId: string): OnboardingData | null {
  return db.prepare('SELECT * FROM onboarding_state WHERE session_id = ?').get(sessionId) as OnboardingData | null;
}

export function setOnboardingState(sessionId: string, data: Partial<OnboardingData>): void {
  const existing = getOnboardingState(sessionId);
  if (!existing) {
    db.prepare(`
      INSERT INTO onboarding_state (session_id, step, first_name, last_name, email, phone, completed)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      data.step || 'ask_name',
      data.first_name || '',
      data.last_name || '',
      data.email || '',
      data.phone || '',
      data.completed || 0
    );
  } else {
    const fields: string[] = [];
    const values: any[] = [];
    if (data.step !== undefined) { fields.push('step = ?'); values.push(data.step); }
    if (data.first_name !== undefined) { fields.push('first_name = ?'); values.push(data.first_name); }
    if (data.last_name !== undefined) { fields.push('last_name = ?'); values.push(data.last_name); }
    if (data.email !== undefined) { fields.push('email = ?'); values.push(data.email); }
    if (data.phone !== undefined) { fields.push('phone = ?'); values.push(data.phone); }
    if (data.completed !== undefined) { fields.push('completed = ?'); values.push(data.completed); }
    if (fields.length > 0) {
      values.push(sessionId);
      db.prepare(`UPDATE onboarding_state SET ${fields.join(', ')} WHERE session_id = ?`).run(...values);
    }
  }
}

// ─── Cleanup ───
export function cleanExpiredCache(): void {
  db.prepare("DELETE FROM cached_responses WHERE expires_at <= datetime('now')").run();
}

export { db };
