const axios = require('axios');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const KEY = () => process.env.GOOGLE_API_KEY;
const SID = () => process.env.SHEETS_ID;
const N8N = () => process.env.N8N_SHEETS_WEBHOOK;

async function getRows(aba, colunas) {
  const range = encodeURIComponent(`${aba}!A2:${colunas}1000`);
  const url = `${API}/${SID()}/values/${range}?key=${KEY()}`;
  const res = await axios.get(url);
  return res.data.values || [];
}

async function getAllAtendimentos() {
  const rows = await getRows('atendimentos', 'H');
  return rows.map((r, i) => ({
    _row:               i + 2,
    id:                 r[0] || '',
    telefone:           r[1] || '',
    status:             r[2] || '',
    resumo_ia:          r[3] || '',
    historico:          safeJSON(r[4] || '[]'),
    atualizado_em:      r[5] || '',
    atendente:          r[6] || '',
    numero_atendimento: parseInt(r[7] || '0'),
  }));
}

async function getAtendimentos(telefone) {
  const rows = await getAllAtendimentos();
  return rows.filter(r => r.telefone === telefone);
}

async function getPendingConversations() {
  const rows = await getAllAtendimentos();
  return rows.filter(r => r.status === 'aguardando' || r.status === 'em_atendimento');
}

async function getConversationByPhone(telefone) {
  const rows = await getAllAtendimentos();
  return rows.find(r =>
    r.telefone === telefone &&
    (r.status === 'aguardando' || r.status === 'em_atendimento')
  ) || null;
}

async function getConversationById(id) {
  const rows = await getAllAtendimentos();
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
  const anteriores = await getAtendimentos(telefone);
  const numero = anteriores.length + 1;

  await n8nWrite({
    acao:               'criar_atendimento',
    id,
    telefone,
    status:             'aguardando',
    resumo_ia:          resumo_ia || '',
    historico:          JSON.stringify(historico || []),
    atualizado_em:      new Date().toISOString(),
    atendente:          '',
    numero_atendimento: numero,
  });
}

async function appendMessage(id, mensagem) {
  const conv = await getConversationById(id);
  if (!conv) throw new Error(`Conversa ${id} não encontrada`);

  // Garante que historico é sempre array
  const historico = Array.isArray(conv.historico) ? conv.historico : [];
  const hora = mensagem.hora || new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  historico.push({
    de:       mensagem.de,
    texto:    mensagem.texto,
    hora,
    atendente: mensagem.atendente || '',
    arquivo:  mensagem.arquivo || undefined,
  });

  await n8nWrite({
    acao:          'atualizar_atendimento',
    id,
    status:        conv.status === 'aguardando' ? 'em_atendimento' : conv.status,
    historico:     JSON.stringify(historico),
    atualizado_em: new Date().toISOString(),
  });

  await n8nWrite({
    acao:               'gravar_historico',
    id_atendimento:     id,
    telefone:           conv.telefone,
    data_hora:          new Date().toISOString(),
    atendente:          mensagem.atendente || conv.atendente || '',
    mensagem_cliente:   (mensagem.de === 'cliente') ? mensagem.texto : '',
    resposta_atendente: (mensagem.de === 'humano' || mensagem.de === 'atendente') ? mensagem.texto : '',
  });

  return { ...conv, historico };
}

async function setAtendente(id, atendente) {
  await n8nWrite({
    acao:          'atualizar_atendimento',
    id,
    atendente,
    atualizado_em: new Date().toISOString(),
  });
}

async function setStatus(id, status) {
  await n8nWrite({
    acao:          'atualizar_atendimento',
    id,
    status,
    atualizado_em: new Date().toISOString(),
  });
}

function safeJSON(str) {
  if (Array.isArray(str)) return str;
  try { 
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

module.exports = {
  getAllAtendimentos,
  getPendingConversations,
  getConversationByPhone,
  getConversationById,
  getAtendimentos,
  createConversation,
  appendMessage,
  setAtendente,
  setStatus,
};
