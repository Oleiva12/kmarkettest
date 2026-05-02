import express from 'express';
import { askBrain } from '../core/brain.js';

/**
 * WhatsApp Webhook Handler (Preparación)
 * 
 * Este módulo estructura el endpoint para recibir webhooks de WhatsApp 
 * Business API. Para activarlo necesitarás:
 * 
 * 1. Una cuenta de WhatsApp Business verificada
 * 2. Un token de acceso de la API de WhatsApp
 * 3. Configurar el webhook URL en la consola de Meta
 * 
 * La respuesta está formateada para ser compatible con:
 * - Plantillas de mensajes de WhatsApp
 * - Botones de acción rápida
 * - Listas interactivas
 */

// Formato de respuesta compatible con WhatsApp Business API
interface WhatsAppResponse {
  messaging_product: 'whatsapp';
  to: string;
  type: 'text' | 'interactive';
  text?: {
    body: string;
  };
  interactive?: {
    type: 'button' | 'list';
    body: { text: string };
    action: {
      buttons?: Array<{
        type: 'reply';
        reply: { id: string; title: string };
      }>;
    };
  };
}

function formatForWhatsApp(response: string, phoneNumber: string): WhatsAppResponse {
  // Convertir Markdown a formato WhatsApp
  let waText = response
    .replace(/\*\*/g, '*')  // WhatsApp usa * simple para negritas
    .replace(/•/g, '▸');     // Bullet points más visibles en WhatsApp

  return {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'text',
    text: {
      body: waText.substring(0, 4096), // Límite de WhatsApp
    },
  };
}

export function mountWhatsAppRoutes(app: express.Express) {
  // Verificación de webhook (Meta requiere esto)
  app.get('/webhook/whatsapp', (req, res) => {
    const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'kmart-verify-token';

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ WhatsApp webhook verificado');
      return res.status(200).send(challenge);
    }

    res.sendStatus(403);
  });

  // Recibir mensajes entrantes
  app.post('/webhook/whatsapp', async (req, res) => {
    try {
      const body = req.body;

      // Verificar que es un mensaje de WhatsApp
      if (body.object !== 'whatsapp_business_account') {
        return res.sendStatus(404);
      }

      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const message = changes?.value?.messages?.[0];

      if (!message || message.type !== 'text') {
        return res.sendStatus(200);
      }

      const phoneNumber = message.from;
      const userMessage = message.text.body;

      console.log(`📱 [WhatsApp] Mensaje de ${phoneNumber}: "${userMessage}"`);

      // Procesar con el cerebro RAG
      const result = await askBrain(userMessage, phoneNumber, 'whatsapp');

      // Formatear respuesta para WhatsApp
      const waResponse = formatForWhatsApp(result.response, phoneNumber);

      // TODO: Enviar respuesta via WhatsApp Cloud API
      // await sendWhatsAppMessage(waResponse);
      console.log('📱 Respuesta WhatsApp preparada:', JSON.stringify(waResponse, null, 2));

      res.sendStatus(200);
    } catch (error) {
      console.error('Error en webhook WhatsApp:', error);
      res.sendStatus(500);
    }
  });

  console.log('📱 Rutas WhatsApp montadas (webhook preparado)');
}
