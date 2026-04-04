const axios = require('axios');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const KEY = () => process.env.GOOGLE_API_KEY;
const SID = () => process.env.SHEETS_ID;
const TAB = () => process.env.SHEETS_TAB || 'atendimentos';
const N8N = () => process.env.N8N_SHEETS_WEBHOOK;

async function getAllRows() {
  const range = encodeURIComponent(`${TAB()}!A2:G1000`);
  const url = `${API}/${SID()}/values/${range}?key=${KEY()}`;
  const res = await axios.get(url);
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

async function n8nWrite(payload) {
  try {
    await axios.post(N8N(), payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
  } catch(e) {
    console.error('[n8nWrite] erro:', e.message);
    throw e;
  }
}

async function createConversation({ id, telefone, nome, resumo_ia, historico }) {
  await n8nWrite({
    acao:         'criar',
    id,
    telefone,
    nome:         nome || 'Cliente',
    status:       'aguardando',
    resumo_ia:    resumo_ia || '',
    historico:    JSON.stringify(historico || []),
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

  await n8nWrite({
    acao:         'atualizar',
    id,
    status:       conv.status === 'aguardando' ? 'em_atendimento' : conv.status,
    historico:    JSON.stringify(historico),
    atualizado_em: new Date().toISOString(),
  });

  return { ...conv, historico };
}

async function setStatus(id, status) {
  await n8nWrite({
    acao:         'atualizar',
    id,
    status,
    atualizado_em: new Date().toISOString(),
  });
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
