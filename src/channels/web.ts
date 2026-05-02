import express from 'express';
import { askBrain } from '../core/brain.js';
import { config } from '../config/settings.js';

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
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (_req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Health Check ───
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'kmart-rag',
    timestamp: new Date().toISOString(),
  });
});

// ─── Chat Endpoint ───
app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'El campo "message" es requerido y debe ser un string.' });
  }

  try {
    const userId = sessionId || `web-${Date.now()}`;
    const response = await askBrain(message, userId, 'web');

    res.json({
      response,
      sessionId: userId,
      timestamp: new Date().toISOString(),
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
  });
}

export { app };
