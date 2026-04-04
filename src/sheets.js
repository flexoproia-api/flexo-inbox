const axios = require('axios');

const API  = 'https://sheets.googleapis.com/v4/spreadsheets';
const KEY  = () => process.env.GOOGLE_API_KEY;
const SID  = () => process.env.SHEETS_ID;
const TAB  = () => process.env.SHEETS_TAB || 'atendimentos';

// ─── LEITURA (via API Key pública) ───────────────────────────────────────────

async function getAllRows() {
  const range = encodeURIComponent(`${TAB()}!A2:G1000`);
  const url   = `${API}/${SID()}/values/${range}?key=${KEY()}`;
  const res   = await axios.get(url);
  return (res.data.values || []).map((r, i) => ({
    _row:          i + 2,
    id:            r[0] || '',
    telefone:      r[1] || '',
    nome:          r[2] || 'Cliente',
    status:        r[3] || '',
    resumo_ia:     r[4] || '',
    historico:     safeJSON(r[5] || '[]'),
    atualizado_em: r[6] || '',
  }));
}

async function getPendingConversations() {
  const rows = await getAllRows();
  return rows.filter(r => r.status === 'aguardando' || r.status === 'em_atendimento');
}

async function getConversationByPhone(telefone) {
  const rows = await getAllRows();
  return rows.find(r =>
    r.telefone === telefone &&
    (r.status === 'aguardando' || r.status === 'em_atendimento')
  ) || null;
}

async function getConversationById(id) {
  const rows = await getAllRows();
  return rows.find(r => r.id === id) || null;
}

// ─── ESCRITA (via N8N webhook) ────────────────────────────────────────────────
// O app chama o N8N, e o N8N escreve na planilha.
// Configure o webhook no N8N conforme o README.

const N8N_SHEETS = () => process.env.N8N_SHEETS_WEBHOOK;

async function n8nWrite(payload) {
  if (!N8N_SHEETS()) throw new Error('N8N_SHEETS_WEBHOOK não configurado');
  const res = await axios.post(N8N_SHEETS(), payload, {
    headers: { 'Content-Type': 'application/json' },
  });
  return res.data;
}

async function createConversation({ id, telefone, nome, resumo_ia, historico }) {
  await n8nWrite({
    acao:      'criar',
    id,
    telefone,
    nome:      nome || 'Cliente',
    status:    'aguardando',
    resumo_ia: resumo_ia || '',
    historico: JSON.stringify(historico || []),
    atualizado_em: new Date().toISOString(),
  });
}

async function updateConversation(id, fields) {
  await n8nWrite({
    acao: 'atualizar',
    id,
    ...fields,
    historico: fields.historico ? JSON.stringify(fields.historico) : undefined,
    atualizado_em: new Date().toISOString(),
  });
}

async function appendMessage(id, mensagem) {
  const conv = await getConversationById(id);
  if (!conv) throw new Error(`Conversa ${id} não encontrada`);

  const historico = conv.historico;
  historico.push({
    de:      mensagem.de,
    texto:   mensagem.texto,
    hora:    mensagem.hora || new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    arquivo: mensagem.arquivo || undefined,
  });

  await updateConversation(id, {
    status:   conv.status === 'aguardando' ? 'em_atendimento' : conv.status,
    historico,
  });

  return { ...conv, historico };
}

async function setStatus(id, status) {
  await updateConversation(id, { status });
}

function safeJSON(str) {
  try { return JSON.parse(str); } catch { return []; }
}

module.exports = {
  getAllRows,
  getPendingConversations,
  getConversationByPhone,
  getConversationById,
  createConversation,
  appendMessage,
  setStatus,
};
