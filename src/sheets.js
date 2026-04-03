const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function getAuth() {
  return new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    SCOPES
  );
}

function getSheets() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

const TAB = () => process.env.SHEETS_TAB || 'atendimentos';
const SID = () => process.env.SHEETS_ID;

async function getAllRows() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SID(),
    range: `${TAB()}!A2:G1000`,
  });
  return (res.data.values || []).map((r, i) => ({
    _row: i + 2,
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

async function createConversation({ id, telefone, nome, resumo_ia, historico }) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SID(),
    range: `${TAB()}!A:G`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        id,
        telefone,
        nome,
        'aguardando',
        resumo_ia || '',
        JSON.stringify(historico || []),
        new Date().toISOString(),
      ]],
    },
  });
}

async function updateConversation(rowIndex, fields) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SID(),
    range: `${TAB()}!A${rowIndex}:G${rowIndex}`,
  });
  const cur = (res.data.values || [[]])[0] || [];

  const newRow = [
    fields.id        !== undefined ? fields.id        : (cur[0] || ''),
    fields.telefone  !== undefined ? fields.telefone  : (cur[1] || ''),
    fields.nome      !== undefined ? fields.nome      : (cur[2] || ''),
    fields.status    !== undefined ? fields.status    : (cur[3] || ''),
    fields.resumo_ia !== undefined ? fields.resumo_ia : (cur[4] || ''),
    fields.historico !== undefined ? JSON.stringify(fields.historico) : (cur[5] || '[]'),
    new Date().toISOString(),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SID(),
    range: `${TAB()}!A${rowIndex}:G${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [newRow] },
  });
}

async function appendMessage(id, mensagem) {
  const rows = await getAllRows();
  const conv = rows.find(r => r.id === id);
  if (!conv) throw new Error(`Conversa ${id} não encontrada`);

  const historico = conv.historico;
  historico.push({
    de:      mensagem.de,
    texto:   mensagem.texto,
    hora:    mensagem.hora || new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    arquivo: mensagem.arquivo || undefined,
  });

  await updateConversation(conv._row, {
    status: conv.status === 'aguardando' ? 'em_atendimento' : conv.status,
    historico,
  });

  return { ...conv, historico };
}

async function setStatus(id, status) {
  const rows = await getAllRows();
  const conv = rows.find(r => r.id === id);
  if (!conv) throw new Error(`Conversa ${id} não encontrada`);
  await updateConversation(conv._row, { status });
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
