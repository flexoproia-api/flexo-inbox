require('dotenv').config();

const express  = require('express');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const cors     = require('cors');
const { v4: uuidv4 } = require('uuid');

const sheets    = require('./sheets');
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

function checkSecret(req, res, next) {
  const token = req.headers['x-webhook-secret'] || req.query.secret;
  if (token !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/conversations', async (req, res) => {
  try {
    const convs = await sheets.getPendingConversations();
    res.json({ ok: true, data: convs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/conversations/:id', async (req, res) => {
  try {
    const conv = await sheets.getConversationById(req.params.id);
    if (!conv) return res.status(404).json({ ok: false, error: 'Não encontrado' });
    res.json({ ok: true, data: conv });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/send', async (req, res) => {
  const { id, texto, atendente } = req.body;
  if (!id || !texto) return res.status(400).json({ ok: false, error: 'id e texto obrigatórios' });
  try {
    const conv = await sheets.getConversationById(id);
    if (!conv) return res.status(404).json({ ok: false, error: 'Conversa não encontrada' });
    await meta.sendText(conv.telefone, texto);
    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const updated = await sheets.appendMessage(id, { de: 'humano', texto, hora, atendente: atendente || '' });
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
    const conv = await sheets.getConversationById(id);
    if (!conv) return res.status(404).json({ ok: false, error: 'Conversa não encontrada' });
    const filePath = req.file.path;
    const mimeType = req.file.mimetype;
    const fileName = req.file.originalname;
    await meta.sendFile(conv.telefone, filePath, mimeType, caption || fileName);
    const fileUrl = `${process.env.PUBLIC_URL || ''}/uploads/${req.file.filename}`;
    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const updated = await sheets.appendMessage(id, {
      de: 'humano',
      texto: caption || `[arquivo] ${fileName}`,
      hora,
      atendente: atendente || '',
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

app.post('/api/finish', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ ok: false, error: 'id obrigatório' });
  try {
    const conv = await sheets.getConversationById(id);
    if (!conv) return res.status(404).json({ ok: false, error: 'Conversa não encontrada' });
    await sheets.setStatus(id, 'finalizado');
    wsManager.notifyConversation(id, { action: 'finished' });
    wsManager.broadcast({ type: 'conv_finished', convId: id });
    res.json({ ok: true, message: 'Atendimento finalizado. IA liberada.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/set-atendente', async (req, res) => {
  const { id, atendente } = req.body;
  if (!id || !atendente) return res.status(400).json({ ok: false, error: 'id e atendente obrigatórios' });
  try {
    await sheets.setAtendente(id, atendente);
    wsManager.broadcast({ type: 'conv_updated', convId: id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/webhook/incoming', checkSecret, async (req, res) => {
  const { telefone, texto, hora, arquivo } = req.body;
  if (!telefone) return res.status(400).json({ ok: false, error: 'telefone obrigatório' });
  try {
    const conv = await sheets.getConversationByPhone(telefone);
    if (!conv) return res.json({ ok: false, message: 'Sem conversa ativa para esse número' });
    const horaFmt = hora || new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    await sheets.appendMessage(conv.id, {
      de: 'cliente',
      texto: texto || '[mídia]',
      hora: horaFmt,
      arquivo: arquivo || undefined,
    });
    wsManager.notifyConversation(conv.id, {
      action: 'new_message',
      message: { de: 'cliente', texto: texto || '[mídia]', hora: horaFmt, arquivo },
    });
    wsManager.broadcast({ type: 'conv_updated', convId: conv.id });
    res.json({ ok: true, convId: conv.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/webhook/new-conversation', checkSecret, async (req, res) => {
  const { telefone, nome, resumo_ia, historico } = req.body;
  if (!telefone) return res.status(400).json({ ok: false, error: 'telefone obrigatório' });
  try {
    const existing = await sheets.getConversationByPhone(telefone);
    if (existing) return res.json({ ok: true, convId: existing.id, message: 'Conversa já existe' });
    const id = uuidv4();
    await sheets.createConversation({ id, telefone, nome: nome || 'Cliente', resumo_ia: resumo_ia || '', historico: historico || [] });
    wsManager.broadcast({ type: 'new_conv', convId: id, nome: nome || 'Cliente', telefone });
    res.json({ ok: true, convId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
