require('dotenv').config();

process.on('uncaughtException', (err) => {
  console.error('ERRO FATAL:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('PROMISE REJEITADA:', reason);
});

const express  = require('express');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const cors     = require('cors');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');

const db        = require('./db');
const meta      = require('./meta');
const wsManager = require('./ws-manager');

const app    = express();
const server = http.createServer(app);

wsManager.init(server);

const UPLOAD_DIR = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${uuidv4().slice(0,8)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_MB) || 25) * 1024 * 1024 },
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// ─── GOOGLE SHEETS AUTH ──────────────────────────────────────────────────────
function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getSheetRows(spreadsheetId, aba) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${aba}!A1:Z2000`,
  });
  const rows = res.data.values || [];
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = r[i] || '');
    return obj;
  });
}

function checkSecret(req, res, next) {
  const token = req.headers['x-webhook-secret'] || req.query.secret;
  if (token !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── UTILITÁRIO: normaliza nome do agente IA no resumo ───────────────────────
function normalizarResumo(texto) {
  if (!texto) return texto;
  return texto
    .replace(/\bAgente Lucas\b/gi, 'Flexo Pro IA')
    .replace(/\bLucas\b/g, 'Flexo Pro IA');
}

// ─── LOGIN ───────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ ok: false, error: 'email e senha obrigatórios' });
  try {
    const atendente = await db.getAtendenteByEmail(email);
    if (!atendente || atendente.senha !== senha) {
      return res.status(401).json({ ok: false, error: 'Email ou senha incorretos' });
    }
    res.json({ ok: true, data: { id: atendente.id, nome: atendente.nome, email: atendente.email, cor: atendente.cor } });
  } catch (e) {
    console.error('[POST /api/login]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── ATENDENTES ──────────────────────────────────────────────────────────────
app.get('/api/atendentes', async (req, res) => {
  try {
    const atendentes = await db.getAtendentes();
    res.json({ ok: true, data: atendentes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── CONTATOS ────────────────────────────────────────────────────────────────
app.get('/api/contatos', async (req, res) => {
  try {
    const contatos = await db.getAllContatos();
    res.json({ ok: true, data: contatos });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/contatos', async (req, res) => {
  const { telefone, nome, empresa } = req.body;
  if (!telefone || !nome) return res.status(400).json({ ok: false, error: 'telefone e nome obrigatórios' });
  try {
    const contato = await db.createContato({ telefone, nome, empresa });
    res.json({ ok: true, data: contato });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/contatos/:telefone', async (req, res) => {
  const { nome, empresa } = req.body;
  if (!nome) return res.status(400).json({ ok: false, error: 'nome obrigatório' });
  try {
    const contato = await db.updateContato({ telefone: req.params.telefone, nome, empresa });
    if (!contato) return res.status(404).json({ ok: false, error: 'Contato não encontrado' });
    res.json({ ok: true, data: contato });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── CONVERSAS ───────────────────────────────────────────────────────────────
app.get('/api/conversations', async (req, res) => {
  try {
    const { telefone } = req.query;
    let convs = await db.getPendingConversations();
    if (telefone) {
      const tel = String(telefone).replace(/\D/g, '');
      convs = convs.filter(c => String(c.telefone).replace(/\D/g, '') === tel);
    }
    res.json({ ok: true, data: convs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── GET CONVERSA POR ID — retorna resumo_ia do último atendimento anterior ──
app.get('/api/conversations/:id', async (req, res) => {
  try {
    const conv = await db.getConversationById(req.params.id);
    if (!conv) return res.status(404).json({ ok: false, error: 'Não encontrado' });

    const todoHistorico = await db.getHistoricoCompleto(conv.telefone);

    const ultimoComResumo = [...todoHistorico]
      .filter(a => a.id !== conv.id && a.resumo_ia && a.resumo_ia.trim())
      .sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em))[0];

    const resumo_ia_bruto = conv.resumo_ia && conv.resumo_ia.trim()
      ? conv.resumo_ia
      : (ultimoComResumo?.resumo_ia || '');

    const resumo_ia = normalizarResumo(resumo_ia_bruto);

    res.json({ ok: true, data: { ...conv, resumo_ia } });
  } catch (e) {
    console.error('[GET /api/conversations/:id]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/historico/:telefone', async (req, res) => {
  try {
    const historico = await db.getHistoricoCompleto(req.params.telefone);
    res.json({ ok: true, data: historico });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── HISTÓRICO IA (via Supabase — atendimentos_ia) ───────────────────────────
app.get('/api/historico-ia/:telefone', async (req, res) => {
  const tel = String(req.params.telefone).replace(/\D/g, '');

  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: atendimentos, error } = await supabase
      .from('atendimentos_ia')
      .select('*')
      .eq('telefone', tel)
      .order('data_inicio', { ascending: true });

    if (error) throw new Error(error.message);

    function normalizeHistorico(historico) {
      if (Array.isArray(historico)) {
        return historico.map(x => String(x || '').trim()).filter(Boolean);
      }

      if (typeof historico === 'string') {
        return historico.split('\n').map(x => x.trim()).filter(Boolean);
      }

      return [];
    }

    const conversas = [];

    (atendimentos || []).forEach(at => {
      const linhas = normalizeHistorico(at.historico_json);

      linhas.forEach(linha => {
        if (linha.startsWith('Cliente:')) {
          conversas.push({
            id: at.id,
            id_conversa: at.id,
            data_hora: at.data_inicio,
            historico_json: at.historico_json,
            mensagem_cliente: linha.replace(/^Cliente:\s*/, '').trim(),
            resposta_lucas: '',
            tag_gerada: at.tag_final || '',
            tag_final: at.tag_final || '',
            status: at.status || ''
          });
        } else if (
          linha.startsWith('IA:') ||
          linha.startsWith('Flexo PRO IA:') ||
          linha.startsWith('Lucas:')
        ) {
          const resposta = linha
            .replace(/^IA:\s*/, '')
            .replace(/^Flexo PRO IA:\s*/, '')
            .replace(/^Lucas:\s*/, '')
            .trim();

          const ultima = conversas[conversas.length - 1];

          if (ultima && ultima.id_conversa === at.id && !ultima.resposta_lucas) {
            ultima.resposta_lucas = resposta;
          } else {
            conversas.push({
              id: at.id,
              id_conversa: at.id,
              data_hora: at.data_inicio,
              historico_json: at.historico_json,
              mensagem_cliente: '',
              resposta_lucas: resposta,
              tag_gerada: at.tag_final || '',
              tag_final: at.tag_final || '',
              status: at.status || ''
            });
          }
        }
      });
    });

    res.json({ ok: true, data: { conversas, propostas: [] } });
  } catch (e) {
    console.error('[GET /api/historico-ia]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── ENVIO ───────────────────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  const { id, texto, atendente } = req.body;
  if (!id || !texto) return res.status(400).json({ ok: false, error: 'id e texto obrigatórios' });
  try {
    const conv = await db.getConversationById(id);
    if (!conv) return res.status(404).json({ ok: false, error: 'Conversa não encontrada' });
    await meta.sendText(conv.telefone, texto);
    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    const updated = await db.appendMessage(id, { de: 'humano', texto, hora, atendente: atendente || '' });
    wsManager.notifyConversation(id, { action: 'new_message', message: { de: 'humano', texto, hora, atendente: atendente || '' } });
    res.json({ ok: true, data: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/send-file', upload.single('file'), async (req, res) => {
  const { id, caption, atendente } = req.body;
  if (!id || !req.file) return res.status(400).json({ ok: false, error: 'id e arquivo obrigatórios' });
  try {
    const conv = await db.getConversationById(id);
    if (!conv) return res.status(404).json({ ok: false, error: 'Conversa não encontrada' });
    const filePath  = req.file.path;
    const mimeType  = req.file.mimetype;
    const fileName  = req.file.originalname;
    await meta.sendFile(conv.telefone, filePath, mimeType, caption || fileName);
    const fileUrl = `${process.env.PUBLIC_URL || ''}/uploads/${req.file.filename}`;
    const hora    = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    const updated = await db.appendMessage(id, {
      de: 'humano', texto: caption || `[arquivo] ${fileName}`,
      hora, atendente: atendente || '',
      arquivo: { nome: fileName, url: fileUrl, tipo: mimeType },
    });
    wsManager.notifyConversation(id, {
      action: 'new_message',
      message: { de: 'humano', texto: caption || `[arquivo] ${fileName}`, hora, atendente: atendente || '', arquivo: { nome: fileName, url: fileUrl } },
    });
    res.json({ ok: true, fileUrl, data: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── FINALIZAR ───────────────────────────────────────────────────────────────
app.post('/api/finish', async (req, res) => {
  const { id, tag } = req.body;
  if (!id) return res.status(400).json({ ok: false, error: 'id obrigatório' });
  try {
    const conv = await db.getConversationById(id);
    if (!conv) return res.status(404).json({ ok: false, error: 'Conversa não encontrada' });
    await db.setStatus(id, 'finalizado');
    if (tag) await db.setTag(id, tag);
    wsManager.notifyConversation(id, { action: 'finished' });
    wsManager.broadcast({ type: 'conv_finished', convId: id });
    res.json({ ok: true, message: 'Atendimento finalizado. IA liberada.' });
    if (process.env.N8N_FINALIZAR_WEBHOOK) {
      const payload = {
        id,
        telefone:         conv.telefone,
        nome:             conv.nome      || 'Cliente',
        empresa:          conv.empresa   || '',
        atendente:        conv.atendente || '',
        tag:              tag            || 'SEM_TAG',
        data_finalizacao: new Date().toISOString(),
      };
      const axios = require('axios');
      axios.post(process.env.N8N_FINALIZAR_WEBHOOK, payload, { timeout: 8000 })
        .catch(e => console.error('[finish webhook]', e.message));
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/set-atendente', async (req, res) => {
  const { id, atendente } = req.body;
  if (!id || !atendente) return res.status(400).json({ ok: false, error: 'id e atendente obrigatórios' });
  try {
    await db.setAtendente(id, atendente);
    await db.setStatus(id, 'em_atendimento');
    wsManager.broadcast({ type: 'conv_updated', convId: id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── WEBHOOKS ────────────────────────────────────────────────────────────────
app.post('/webhook/incoming', checkSecret, async (req, res) => {
  const { telefone, texto, hora, arquivo } = req.body;
  if (!telefone) return res.status(400).json({ ok: false, error: 'telefone obrigatório' });
  try {
    const conv = await db.getConversationByPhone(telefone);
    if (!conv) return res.json({ ok: false, message: 'Sem conversa ativa' });
    const horaFmt = hora || new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    await db.appendMessage(conv.id, { de: 'cliente', texto: texto || '[mídia]', hora: horaFmt, arquivo: arquivo || undefined });
    wsManager.notifyConversation(conv.id, { action: 'new_message', message: { de: 'cliente', texto: texto || '[mídia]', hora: horaFmt, arquivo } });
    wsManager.broadcast({ type: 'conv_updated', convId: conv.id });
    res.json({ ok: true, convId: conv.id });
  } catch (e) {
    console.error('[POST /webhook/incoming]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/webhook/new-conversation', checkSecret, async (req, res) => {
  const { telefone, nome, resumo_ia, historico } = req.body;
  if (!telefone) return res.status(400).json({ ok: false, error: 'telefone obrigatório' });
  try {
    const existing = await db.getConversationByPhone(telefone);
    if (existing) {
      if (resumo_ia && resumo_ia.trim() && !existing.resumo_ia) {
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        await supabase.from('atendimentos').update({ resumo_ia }).eq('id', existing.id);
      }
      return res.json({ ok: true, convId: existing.id, message: 'Conversa já existe' });
    }
    const id = uuidv4();
    await db.createConversation({ id, telefone, nome: nome || 'Cliente', resumo_ia: resumo_ia || '', historico: historico || [] });
    wsManager.broadcast({ type: 'new_conv', convId: id, nome: nome || 'Cliente', telefone });
    res.json({ ok: true, convId: id });
  } catch (e) {
    console.error('[POST /webhook/new-conversation]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── HEALTH ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), ts: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Flexo Inbox rodando na porta ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
