const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Erro inesperado no pool:', err.message);
});

// ─── UTILITÁRIOS ────────────────────────────────────────────────────────────

function horaBrasilia() {
  return new Date().toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  });
}

function isoAgora() {
  return new Date().toISOString();
}

// ─── CONTATOS ───────────────────────────────────────────────────────────────

async function getContatoByPhone(telefone) {
  const tel = String(telefone).replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT * FROM contatos WHERE telefone = $1 LIMIT 1`,
    [tel]
  );
  return rows[0] || null;
}

async function createContato({ telefone, nome, empresa }) {
  const tel = String(telefone).replace(/\D/g, '');
  const { rows } = await pool.query(
    `INSERT INTO contatos (telefone, nome, empresa)
     VALUES ($1, $2, $3)
     ON CONFLICT (telefone) DO UPDATE
       SET nome = EXCLUDED.nome,
           empresa = EXCLUDED.empresa,
           atualizado_em = now()
     RETURNING *`,
    [tel, nome || 'Cliente', empresa || '']
  );
  return rows[0];
}

async function updateContato({ telefone, nome, empresa }) {
  const tel = String(telefone).replace(/\D/g, '');
  const { rows } = await pool.query(
    `UPDATE contatos
     SET nome = $2, empresa = $3, atualizado_em = now()
     WHERE telefone = $1
     RETURNING *`,
    [tel, nome, empresa]
  );
  return rows[0] || null;
}

async function getAllContatos() {
  const { rows } = await pool.query(
    `SELECT c.*, COUNT(a.id) as total_atendimentos
     FROM contatos c
     LEFT JOIN atendimentos a ON a.contato_id = c.id
     GROUP BY c.id
     ORDER BY c.atualizado_em DESC`
  );
  return rows;
}

// ─── ATENDIMENTOS ────────────────────────────────────────────────────────────

async function getAllAtendimentos() {
  const { rows } = await pool.query(
    `SELECT a.*, c.nome, c.empresa
     FROM atendimentos a
     LEFT JOIN contatos c ON c.id = a.contato_id
     ORDER BY a.atualizado_em DESC`
  );
  return rows.map(r => ({
    ...r,
    historico: Array.isArray(r.historico) ? r.historico : [],
  }));
}

async function getPendingConversations() {
  const { rows } = await pool.query(
    `SELECT a.*, c.nome, c.empresa
     FROM atendimentos a
     LEFT JOIN contatos c ON c.id = a.contato_id
     WHERE a.status IN ('aguardando', 'em_atendimento')
     ORDER BY a.atualizado_em DESC`
  );
  return rows.map(r => ({
    ...r,
    historico: Array.isArray(r.historico) ? r.historico : [],
  }));
}

async function getConversationByPhone(telefone) {
  const tel = String(telefone).replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT a.*, c.nome, c.empresa
     FROM atendimentos a
     LEFT JOIN contatos c ON c.id = a.contato_id
     WHERE a.telefone = $1
       AND a.status IN ('aguardando', 'em_atendimento')
     ORDER BY a.atualizado_em DESC
     LIMIT 1`,
    [tel]
  );
  if (!rows[0]) return null;
  return { ...rows[0], historico: Array.isArray(rows[0].historico) ? rows[0].historico : [] };
}

async function getConversationById(id) {
  const { rows } = await pool.query(
    `SELECT a.*, c.nome, c.empresa
     FROM atendimentos a
     LEFT JOIN contatos c ON c.id = a.contato_id
     WHERE a.id = $1
     LIMIT 1`,
    [id]
  );
  if (!rows[0]) return null;
  return { ...rows[0], historico: Array.isArray(rows[0].historico) ? rows[0].historico : [] };
}

// Busca TODO o histórico de atendimentos anteriores de um telefone
async function getHistoricoCompleto(telefone) {
  const tel = String(telefone).replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT a.id, a.status, a.criado_em, a.atualizado_em,
            a.atendente, a.numero_atendimento, a.historico,
            c.nome, c.empresa
     FROM atendimentos a
     LEFT JOIN contatos c ON c.id = a.contato_id
     WHERE a.telefone = $1
     ORDER BY a.criado_em ASC`,
    [tel]
  );
  return rows.map(r => ({
    ...r,
    historico: Array.isArray(r.historico) ? r.historico : [],
  }));
}

async function createConversation({ id, telefone, nome, resumo_ia, historico }) {
  const tel = String(telefone).replace(/\D/g, '');

  // Garante que o contato existe
  const contato = await createContato({ telefone: tel, nome: nome || 'Cliente' });

  // Conta atendimentos anteriores para numero_atendimento
  const { rows: count } = await pool.query(
    `SELECT COUNT(*) FROM atendimentos WHERE telefone = $1`,
    [tel]
  );
  const numero = parseInt(count[0].count) + 1;

  await pool.query(
    `INSERT INTO atendimentos
       (id, contato_id, telefone, status, resumo_ia, historico, numero_atendimento, atualizado_em)
     VALUES ($1, $2, $3, 'aguardando', $4, $5, $6, now())
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      contato.id,
      tel,
      resumo_ia || '',
      JSON.stringify(historico || []),
      numero,
    ]
  );

  return { id, telefone: tel, nome: contato.nome, empresa: contato.empresa };
}

async function appendMessage(id, mensagem) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock na linha para evitar race condition
    const { rows } = await client.query(
      `SELECT * FROM atendimentos WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!rows[0]) throw new Error(`Conversa ${id} não encontrada`);
    const conv = rows[0];

    const historico = Array.isArray(conv.historico) ? conv.historico : [];
    const hora = mensagem.hora || horaBrasilia();

    const novaMensagem = {
      de:        mensagem.de,
      texto:     mensagem.texto,
      hora,
      atendente: mensagem.atendente || '',
      ...(mensagem.arquivo ? { arquivo: mensagem.arquivo } : {}),
    };

    historico.push(novaMensagem);

    const novoStatus = (conv.status === 'aguardando' || conv.status === '')
      ? 'em_atendimento'
      : conv.status;

    await client.query(
      `UPDATE atendimentos
       SET historico = $1, status = $2, atualizado_em = now()
       WHERE id = $3`,
      [JSON.stringify(historico), novoStatus, id]
    );

    // Grava na tabela historico (espelho para Sheets/Glide)
    if (mensagem.de === 'humano' || mensagem.de === 'atendente') {
      await client.query(
        `INSERT INTO historico
           (id_atendimento, telefone, data_hora, atendente, mensagem_cliente, resposta_atendente)
         VALUES ($1, $2, now(), $3, '', $4)`,
        [id, conv.telefone, mensagem.atendente || conv.atendente || '', mensagem.texto]
      );
    } else if (mensagem.de === 'cliente') {
      await client.query(
        `INSERT INTO historico
           (id_atendimento, telefone, data_hora, atendente, mensagem_cliente, resposta_atendente)
         VALUES ($1, $2, now(), '', $3, '')`,
        [id, conv.telefone, mensagem.texto]
      );
    }

    await client.query('COMMIT');
    return { ...conv, historico, status: novoStatus };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function setAtendente(id, atendente) {
  await pool.query(
    `UPDATE atendimentos SET atendente = $1, atualizado_em = now() WHERE id = $2`,
    [atendente, id]
  );
}

async function setStatus(id, status) {
  await pool.query(
    `UPDATE atendimentos SET status = $1, atualizado_em = now() WHERE id = $2`,
    [status, id]
  );
}

// ─── ATENDENTES (LOGIN) ──────────────────────────────────────────────────────

async function getAtendentes() {
  const { rows } = await pool.query(
    `SELECT id, nome, email, cor FROM atendentes ORDER BY nome`
  );
  return rows;
}

async function getAtendenteByEmail(email) {
  const { rows } = await pool.query(
    `SELECT * FROM atendentes WHERE email = $1 LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

async function getAtendenteByNome(nome) {
  const { rows } = await pool.query(
    `SELECT * FROM atendentes WHERE nome = $1 LIMIT 1`,
    [nome]
  );
  return rows[0] || null;
}

module.exports = {
  // contatos
  getContatoByPhone,
  createContato,
  updateContato,
  getAllContatos,
  // atendimentos
  getAllAtendimentos,
  getPendingConversations,
  getConversationByPhone,
  getConversationById,
  getHistoricoCompleto,
  createConversation,
  appendMessage,
  setAtendente,
  setStatus,
  // atendentes
  getAtendentes,
  getAtendenteByEmail,
  getAtendenteByNome,
};
