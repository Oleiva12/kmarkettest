import express from 'express';
import { askBrain } from '../core/brain.js';
import { config } from '../config/settings.js';
import {
  getAllLeads, createLead, updateLead, getLeadById,
  getTopProducts, getTopCategories, getDashboardSummary, getActivityTimeline
} from '../core/cache.js';
import * as crypto from 'crypto';

const app = express();
app.use(express.json());

// ─── Archivos Estáticos (Landing Page) ───
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicPath = path.join(__dirname, '../../public');

app.use(express.static(publicPath));

// ─── CORS ───
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS');
  if (_req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Auth (hardcoded credentials) ───
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'kmart2024';
const tokens = new Set<string>();

function authMiddleware(req: any, res: any, next: any) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const token = auth.slice(7);
  if (!tokens.has(token)) {
    return res.status(401).json({ error: 'Token inválido' });
  }
  next();
}

// ─── Health Check ───
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'kmart-rag',
    timestamp: new Date().toISOString(),
  });
});

// ─── Auth Endpoints ───
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    tokens.add(token);
    return res.json({ token, user: username });
  }
  return res.status(401).json({ error: 'Credenciales inválidas' });
});

app.post('/api/auth/logout', authMiddleware, (req: any, res) => {
  const token = req.headers.authorization?.slice(7);
  if (token) tokens.delete(token);
  res.json({ ok: true });
});

// ─── Leads Endpoints ───
app.get('/api/leads', authMiddleware, (req, res) => {
  const { status, channel } = req.query as any;
  const leads = getAllLeads({ status, channel });
  res.json(leads);
});

app.post('/api/leads', authMiddleware, (req, res) => {
  const { first_name, last_name, email, phone, channel, notes } = req.body;
  if (!first_name) return res.status(400).json({ error: 'first_name es requerido' });
  const id = createLead({ first_name, last_name, email, phone, channel, notes });
  res.json({ id, message: 'Lead creado' });
});

app.get('/api/leads/:id', authMiddleware, (req, res) => {
  const lead = getLeadById(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  res.json(lead);
});

app.put('/api/leads/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id);
  const updated = updateLead(id, req.body);
  if (!updated) return res.status(404).json({ error: 'Lead no encontrado' });
  res.json({ ok: true, message: 'Lead actualizado' });
});

// ─── Analytics Endpoints ───
app.get('/api/analytics/summary', authMiddleware, (_req, res) => {
  res.json(getDashboardSummary());
});

app.get('/api/analytics/products', authMiddleware, (req, res) => {
  const limit = parseInt(req.query.limit as string) || 10;
  res.json(getTopProducts(limit));
});

app.get('/api/analytics/categories', authMiddleware, (req, res) => {
  const limit = parseInt(req.query.limit as string) || 10;
  res.json(getTopCategories(limit));
});

app.get('/api/analytics/timeline', authMiddleware, (req, res) => {
  const days = parseInt(req.query.days as string) || 30;
  res.json(getActivityTimeline(days));
});

// ─── Chat Endpoint ───
app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'El campo "message" es requerido y debe ser un string.' });
  }

  try {
    const userId = sessionId || `web-${Date.now()}`;
    const result = await askBrain(message, userId, 'web');

    res.json({
      response: result.response,
      sessionId: userId,
      timestamp: new Date().toISOString(),
      onboarding: result.onboarding || null,
    });
  } catch (error: any) {
    console.error('Error en /chat:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ─── Iniciar servidor ───
export function startWebServer() {
  app.listen(config.port, () => {
    console.log(`🌐 API REST escuchando en http://localhost:${config.port}`);
    console.log(`   POST /chat  — Enviar mensaje`);
    console.log(`   GET  /health — Health check`);
    console.log(`   GET  /admin.html — Dashboard CRM`);
  });
}

export { app };
