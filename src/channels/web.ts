import express from 'express';
import { askBrain } from '../core/brain.js';
import { config } from '../config/settings.js';
import {
  getAllLeads, createLead, updateLead, getLeadById,
  getTopProducts, getTopCategories, getDashboardSummary, getActivityTimeline,
  getAllChatSessions, getChatMessages, getNewMessages,
  takeOverSession, releaseSession, addMessage, isSessionTakenOver,
  getPendingAlerts, dismissAlert, dismissAlertsBySession, getPendingAlertCount
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

// ─── Public endpoint for web clients to poll admin messages ───
app.get('/api/chats-public/:id/poll', (req, res) => {
  const afterId = parseInt(req.query.after as string) || 0;
  const messages = getNewMessages(req.params.id, afterId);
  // Only return admin messages for security
  const adminMsgs = messages.filter(m => m.role === 'admin');
  res.json(adminMsgs);
});

// ─── Chat Sessions (Admin Live Chat) ───
app.get('/api/chats', authMiddleware, (_req, res) => {
  res.json(getAllChatSessions());
});

app.get('/api/chats/:id/messages', authMiddleware, (req, res) => {
  const messages = getChatMessages(req.params.id);
  res.json(messages);
});

app.get('/api/chats/:id/poll', authMiddleware, (req, res) => {
  const afterId = parseInt(req.query.after as string) || 0;
  const messages = getNewMessages(req.params.id, afterId);
  res.json(messages);
});

app.post('/api/chats/:id/takeover', authMiddleware, (req, res) => {
  const ok = takeOverSession(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Sesión no encontrada' });
  // Auto-dismiss alerts for this session
  dismissAlertsBySession(req.params.id);
  res.json({ ok: true, message: 'Sesión tomada' });
});

app.post('/api/chats/:id/release', authMiddleware, (req, res) => {
  const ok = releaseSession(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Sesión no encontrada o no tomada' });
  res.json({ ok: true, message: 'Sesión liberada' });
});

app.post('/api/chats/:id/send', authMiddleware, (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message es requerido' });
  
  const sessionId = req.params.id;
  if (!isSessionTakenOver(sessionId)) {
    return res.status(400).json({ error: 'Debes tomar control del chat primero' });
  }

  addMessage(sessionId, 'admin', message);

  // Send admin message to the correct channel
  try {
    // Try Telegram
    import('../channels/telegram.js').then(({ sendTelegramMessage }) => {
      sendTelegramMessage(sessionId, message);
    }).catch(() => {});
    // Try WhatsApp
    import('../channels/whatsapp.js').then(({ sendWhatsAppAdminMessage }) => {
      // sessionId for WhatsApp is the phone number
      sendWhatsAppAdminMessage(sessionId, message);
    }).catch(() => {});
  } catch (e) {}

  res.json({ ok: true });
});

// ─── Agent Alerts ───
app.get('/api/alerts', authMiddleware, (_req, res) => {
  res.json(getPendingAlerts());
});

app.get('/api/alerts/count', authMiddleware, (_req, res) => {
  res.json({ count: getPendingAlertCount() });
});

app.post('/api/alerts/:id/dismiss', authMiddleware, (req, res) => {
  dismissAlert(parseInt(req.params.id));
  res.json({ ok: true });
});

// ─── Chat Endpoint (User) ───
app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'El campo "message" es requerido y debe ser un string.' });
  }

  try {
    const userId = sessionId || `web-${Date.now()}`;
    const result = await askBrain(message, userId, 'web');

    // If admin took over, don't send AI response — admin responds via dashboard
    if (result.response === '__ADMIN_TAKEOVER__') {
      return res.json({
        response: null,
        sessionId: userId,
        timestamp: new Date().toISOString(),
        adminTakeover: true,
      });
    }

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
