const axios = require('axios');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const KEY = () => process.env.GOOGLE_API_KEY;
const SID = () => process.env.SHEETS_ID;
const N8N = () => process.env.N8N_SHEETS_WEBHOOK;

// Horário de Brasília
function horaBrasilia() {
  return new Date().toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });
}

function isoAgora() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace(' ', 'T') + '-03:00';
}

async function getRows(aba, colunas) {
  const range = encodeURIComponent(`${aba}!A2:${colunas}1000`);
  const url = `${API}/${SID()}/values/${range}?key=${KEY()}`;
  const res = await axios.get(url);
  return res.data.values || [];
}

async function getAllAtendimentos() {
  const rows = await getRows('atendimentos', 'I');
  return rows.map((r, i) => ({
    _row:               i + 2,
    id:                 r[0] || '',
    telefone:           r[1] || '',
    nome:               r[2] || 'Cliente',
    status:             r[3] || '',
    resumo_ia:          r[4] || '',
    historico:          safeJSON(r[5] || '[]'),
    atualizado_em:      r[6] || '',
    atendente:          r[7] || '',
    numero_atendimento: parseInt(r[8] || '0'),
  }));
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
  const todos = await getAllAtendimentos();
  const anteriores = todos.filter(r => r.telefone === telefone);
  const numero = anteriores.length + 1;

  await n8nWrite({
    acao:               'criar_atendimento',
    id,
    telefone,
    nome:               nome || 'Cliente',
    status:             'aguardando',
    resumo_ia:          resumo_ia || '',
    historico:          JSON.stringify(historico || []),
    atualizado_em:      isoAgora(),
    atendente:          '',
    numero_atendimento: numero,
  });
}

async function appendMessage(id, mensagem) {
  const conv = await getConversationById(id);
  if (!conv) throw new Error(`Conversa ${id} não encontrada`);

  const historico = Array.isArray(conv.historico) ? conv.historico : [];
  const hora = mensagem.hora || horaBrasilia();

  // FIX: evita duplicar — só adiciona se não for mensagem do cliente via webhook/incoming
  // (o webhook/incoming já chama appendMessage, não duplicar via gravar_historico)
  const novaMensagem = {
    de:        mensagem.de,
    texto:     mensagem.texto,
    hora,
    atendente: mensagem.atendente || '',
    ...(mensagem.arquivo ? { arquivo: mensagem.arquivo } : {}),
  };

  historico.push(novaMensagem);

  // FIX: status — aceita vazio ou 'aguardando' como gatilho para em_atendimento
  const novoStatus = (conv.status === 'aguardando' || conv.status === '')
    ? 'em_atendimento'
    : conv.status;

  await n8nWrite({
    acao:          'atualizar_atendimento',
    id,
    status:        novoStatus,
    historico:     JSON.stringify(historico),
    atualizado_em: isoAgora(),
  });

  // gravar_historico só para mensagens humanas (evita duplicar no histórico separado)
  if (mensagem.de === 'humano' || mensagem.de === 'atendente') {
    await n8nWrite({
      acao:               'gravar_historico',
      id_atendimento:     id,
      telefone:           conv.telefone,
      data_hora:          isoAgora(),
      atendente:          mensagem.atendente || conv.atendente || '',
      mensagem_cliente:   '',
      resposta_atendente: mensagem.texto,
    });
  }

  return { ...conv, historico };
}

async function setAtendente(id, atendente) {
  await n8nWrite({
    acao:          'atualizar_atendimento',
    id,
    atendente,
    atualizado_em: isoAgora(),
  });
}

async function setStatus(id, status) {
  await n8nWrite({
    acao:          'atualizar_atendimento',
    id,
    status,
    atualizado_em: isoAgora(),
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
  createConversation,
  appendMessage,
  setAtendente,
  setStatus,
};
