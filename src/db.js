const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
  const { data, error } = await supabase
    .from('contatos')
    .select('*')
    .eq('telefone', tel)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

async function createContato({ telefone, nome, empresa }) {
  const tel = String(telefone).replace(/\D/g, '');
  const { data, error } = await supabase
    .from('contatos')
    .upsert({ telefone: tel, nome: nome || 'Cliente', empresa: empresa || '', atualizado_em: isoAgora() }, { onConflict: 'telefone' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateContato({ telefone, nome, empresa }) {
  const tel = String(telefone).replace(/\D/g, '');
  const { data, error } = await supabase
    .from('contatos')
    .update({ nome, empresa, atualizado_em: isoAgora() })
    .eq('telefone', tel)
    .select()
    .single();
  if (error) throw error;
  return data || null;
}

async function getAllContatos() {
  const { data, error } = await supabase
    .from('contatos')
    .select('*')
    .order('atualizado_em', { ascending: false });
  if (error) throw error;
  return data || [];
}

// ─── ATENDIMENTOS ────────────────────────────────────────────────────────────

async function getAllAtendimentos() {
  const { data, error } = await supabase
    .from('atendimentos')
    .select('*, contatos(nome, empresa)')
    .order('atualizado_em', { ascending: false });
  if (error) throw error;
  return (data || []).map(r => ({
    ...r,
    nome: r.contatos?.nome || 'Cliente',
    empresa: r.contatos?.empresa || '',
    historico: Array.isArray(r.historico) ? r.historico : [],
  }));
}

async function getPendingConversations() {
  const { data, error } = await supabase
    .from('atendimentos')
    .select('*, contatos(nome, empresa)')
    .in('status', ['aguardando', 'em_atendimento'])
    .order('atualizado_em', { ascending: false });
  if (error) throw error;
  return (data || []).map(r => ({
    ...r,
    nome: r.contatos?.nome || 'Cliente',
    empresa: r.contatos?.empresa || '',
    historico: Array.isArray(r.historico) ? r.historico : [],
  }));
}

async function getConversationByPhone(telefone) {
  const tel = String(telefone).replace(/\D/g, '');
  const { data, error } = await supabase
    .from('atendimentos')
    .select('*, contatos(nome, empresa)')
    .eq('telefone', tel)
    .in('status', ['aguardando', 'em_atendimento'])
    .order('atualizado_em', { ascending: false })
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  if (!data) return null;
  return {
    ...data,
    nome: data.contatos?.nome || 'Cliente',
    empresa: data.contatos?.empresa || '',
    historico: Array.isArray(data.historico) ? data.historico : [],
  };
}

async function getConversationById(id) {
  const { data, error } = await supabase
    .from('atendimentos')
    .select('*, contatos(nome, empresa)')
    .eq('id', id)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  if (!data) return null;
  return {
    ...data,
    nome: data.contatos?.nome || 'Cliente',
    empresa: data.contatos?.empresa || '',
    historico: Array.isArray(data.historico) ? data.historico : [],
  };
}

async function getHistoricoCompleto(telefone) {
  const tel = String(telefone).replace(/\D/g, '');
  const { data, error } = await supabase
    .from('atendimentos')
    .select('*, contatos(nome, empresa)')
    .eq('telefone', tel)
    .order('criado_em', { ascending: true });
  if (error) throw error;
  return (data || []).map(r => ({
    ...r,
    nome: r.contatos?.nome || 'Cliente',
    empresa: r.contatos?.empresa || '',
    historico: Array.isArray(r.historico) ? r.historico : [],
  }));
}

async function createConversation({ id, telefone, nome, resumo_ia, historico }) {
  const tel = String(telefone).replace(/\D/g, '');

  const contato = await createContato({ telefone: tel, nome: nome || 'Cliente' });

  const { count } = await supabase
    .from('atendimentos')
    .select('*', { count: 'exact', head: true })
    .eq('telefone', tel);

  const numero = (count || 0) + 1;

  const { error } = await supabase
    .from('atendimentos')
    .upsert({
      id,
      contato_id: contato.id,
      telefone: tel,
      status: 'aguardando',
      resumo_ia: resumo_ia || '',
      historico: historico || [],
      numero_atendimento: numero,
      atualizado_em: isoAgora(),
    }, { onConflict: 'id', ignoreDuplicates: true });

  if (error) throw error;
  return { id, telefone: tel, nome: contato.nome, empresa: contato.empresa };
}

async function appendMessage(id, mensagem) {
  const conv = await getConversationById(id);
  if (!conv) throw new Error(`Conversa ${id} não encontrada`);

  const historico = Array.isArray(conv.historico) ? conv.historico : [];
  const hora = mensagem.hora || horaBrasilia();

  const novaMensagem = {
    de: mensagem.de,
    texto: mensagem.texto,
    hora,
    atendente: mensagem.atendente || '',
    ...(mensagem.arquivo ? { arquivo: mensagem.arquivo } : {}),
  };

  historico.push(novaMensagem);

  const novoStatus = (conv.status === 'aguardando' || conv.status === '')
    ? 'em_atendimento'
    : conv.status;

  const { error } = await supabase
    .from('atendimentos')
    .update({
      historico,
      status: novoStatus,
      atualizado_em: isoAgora(),
    })
    .eq('id', id);

  if (error) throw error;

  await supabase.from('historico').insert({
    id_atendimento: id,
    telefone: conv.telefone,
    data_hora: isoAgora(),
    atendente: mensagem.atendente || conv.atendente || '',
    mensagem_cliente: mensagem.de === 'cliente' ? mensagem.texto : '',
    resposta_atendente: mensagem.de === 'humano' ? mensagem.texto : '',
  });

  return { ...conv, historico, status: novoStatus };
}

async function setAtendente(id, atendente) {
  const { error } = await supabase
    .from('atendimentos')
    .update({ atendente, atualizado_em: isoAgora() })
    .eq('id', id);
  if (error) throw error;
}

async function setStatus(id, status) {
  const { error } = await supabase
    .from('atendimentos')
    .update({ status, atualizado_em: isoAgora() })
    .eq('id', id);
  if (error) throw error;
}

// ─── ATENDENTES (LOGIN) ──────────────────────────────────────────────────────

async function getAtendentes() {
  const { data, error } = await supabase
    .from('atendentes')
    .select('id, nome, email, cor')
    .order('nome');
  if (error) throw error;
  return data || [];
}

async function getAtendenteByEmail(email) {
  const { data, error } = await supabase
    .from('atendentes')
    .select('*')
    .eq('email', email)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

async function getAtendenteByNome(nome) {
  const { data, error } = await supabase
    .from('atendentes')
    .select('*')
    .eq('nome', nome)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

module.exports = {
  getContatoByPhone,
  createContato,
  updateContato,
  getAllContatos,
  getAllAtendimentos,
  getPendingConversations,
  getConversationByPhone,
  getConversationById,
  getHistoricoCompleto,
  createConversation,
  appendMessage,
  setAtendente,
  setStatus,
  getAtendentes,
  getAtendenteByEmail,
  getAtendenteByNome,
};
