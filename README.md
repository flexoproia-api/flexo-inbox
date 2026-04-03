# Flexo Inbox — Chat de Atendimento Humano

Substitui o Chatwoot. App próprio que roda no ORender/Hostinger e se integra com N8N + Google Sheets + META API.

## Arquitetura

```
Cliente (WhatsApp)
    ↓
META Cloud API
    ↓
N8N (já configurado)
    ↓
  [TRANSFERIR_HUMANO detectado]
    ↓
POST /webhook/new-conversation  ← N8N avisa o Flexo Inbox
    ↓
Google Sheets (persiste o estado)
    ↓
WebSocket → Atendente vê no Inbox ← Atendente responde
    ↓
POST /api/send → META API → WhatsApp do cliente
```

---

## Estrutura do Projeto

```
flexo-inbox/
├── src/
│   ├── server.js       ← Servidor principal (Express + WebSocket)
│   ├── sheets.js       ← Integração Google Sheets
│   ├── meta.js         ← Envio pelo WhatsApp (META API)
│   └── ws-manager.js   ← Gerenciador de conexões WebSocket
├── public/
│   └── index.html      ← Interface do atendente
├── uploads/            ← Criada automaticamente
├── .env.example        ← Copie para .env e preencha
├── package.json
└── README.md
```

---

## Planilha Google Sheets — Estrutura

Crie uma aba chamada `atendimentos` com estas colunas **exatamente nessa ordem**:

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| id | telefone | nome | status | resumo_ia | historico_json | atualizado_em |

**Status possíveis:** `aguardando` | `em_atendimento` | `finalizado`

**historico_json** — array JSON de mensagens:
```json
[
  {"de": "cliente", "texto": "Olá", "hora": "14:30"},
  {"de": "ia", "texto": "Olá! Como posso ajudar?", "hora": "14:30"},
  {"de": "humano", "texto": "Olá João, sou o atendente.", "hora": "14:35"}
]
```

---

## Google Cloud — Service Account (para ler/escrever no Sheets)

1. Acesse [console.cloud.google.com](https://console.cloud.google.com)
2. Crie um projeto (ou use o existente)
3. Ative a **Google Sheets API**
4. Vá em **IAM & Admin → Service Accounts → Create**
5. Baixe o JSON da service account
6. **Compartilhe a planilha** com o e-mail da service account (editor)
7. Copie `client_email` e `private_key` para o `.env`

---

## Variáveis de Ambiente (.env)

Copie `.env.example` para `.env` e preencha:

```env
PORT=3000
SHEETS_ID=ID_DA_SUA_PLANILHA
SHEETS_TAB=atendimentos
GOOGLE_CLIENT_EMAIL=service@projeto.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
META_TOKEN=seu_token_meta
META_PHONE_ID=seu_phone_number_id
WEBHOOK_SECRET=string_aleatoria_secreta
UPLOAD_DIR=uploads
MAX_FILE_MB=25
PUBLIC_URL=https://seu-dominio.com.br
```

---

## Deploy no ORender

1. Faça push do projeto para o GitHub:
```bash
git init
git add .
git commit -m "first commit"
git remote add origin https://github.com/SEU_USER/flexo-inbox.git
git push -u origin main
```

2. No ORender:
   - Conecte o repositório GitHub
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - Adicione todas as variáveis do `.env` no painel de Environment Variables
   - Configure o domínio personalizado da Hostinger

3. No painel da Hostinger:
   - DNS → Adicione um registro CNAME apontando para o ORender
   - Ex: `inbox.seudominio.com.br` → `seu-app.onrender.com`

---

## Configuração no N8N

### 1. Quando detectar [TRANSFERIR_HUMANO]

Adicione um nó **HTTP Request** após o If de transferência:

- **Method:** POST
- **URL:** `https://seu-inbox.com/webhook/new-conversation`
- **Header:** `x-webhook-secret: SEU_WEBHOOK_SECRET`
- **Body (JSON):**
```json
{
  "telefone": "{{ $json.telefone }}",
  "nome": "{{ $json.nome_cliente }}",
  "resumo_ia": "{{ $json.resumo }}",
  "historico": {{ $json.historico_array }}
}
```

### 2. Quando receber mensagem de cliente já em atendimento humano

No início do seu fluxo principal, antes de chamar a IA, adicione uma verificação:

**HTTP Request** para verificar status:
- **Method:** GET
- **URL:** `https://seu-inbox.com/api/conversations?telefone={{ $json.telefone }}`

Se retornar conversa com `status = em_atendimento`, **pare o fluxo** (não envia para IA) e chame:

**HTTP Request** para repassar mensagem ao inbox:
- **Method:** POST
- **URL:** `https://seu-inbox.com/webhook/incoming`
- **Header:** `x-webhook-secret: SEU_WEBHOOK_SECRET`
- **Body:**
```json
{
  "telefone": "{{ $json.telefone }}",
  "texto": "{{ $json.mensagem }}",
  "hora": "{{ $now.toLocaleTimeString('pt-BR') }}"
}
```

---

## Desenvolvimento Local

```bash
# Clone o repositório
git clone https://github.com/SEU_USER/flexo-inbox.git
cd flexo-inbox

# Instale dependências
npm install

# Configure o .env
cp .env.example .env
# Edite o .env com seus dados

# Rode em desenvolvimento
npm run dev

# Acesse em
# http://localhost:3000
```

---

## API Reference

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/conversations` | Lista conversas pendentes |
| GET | `/api/conversations/:id` | Detalhe de uma conversa |
| POST | `/api/send` | Atendente envia texto |
| POST | `/api/send-file` | Atendente envia arquivo |
| POST | `/api/finish` | Finaliza e libera IA |
| POST | `/webhook/new-conversation` | N8N abre nova conversa (requer secret) |
| POST | `/webhook/incoming` | N8N repassa msg do cliente (requer secret) |
| GET | `/health` | Health check |
| WS | `/ws` | WebSocket para tempo real |
