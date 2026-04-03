// ─────────────────────────────────────────────────────────────
// data/mock.js
// Dados fictícios para desenvolvimento sem APIs reais.
// Cada seção tem um comentário "MODULE: X" indicando qual
// integração real substituirá esses dados.
// ─────────────────────────────────────────────────────────────

// MODULE: Auth → substituir por JWT / NextAuth / Supabase Auth
export const OPERATORS = [
  { id: 1, login: "yuri",       name: "Yuri",       role: "gerente",       avatar: "YU", color: "#0d7d62" },
  { id: 2, login: "ana",        name: "Ana",         role: "dentista",      avatar: "AN", color: "#1a5fa8" },
  { id: 3, login: "patricia",   name: "Patrícia",    role: "recepcao",      avatar: "PA", color: "#b56a00" },
  { id: 4, login: "dudu",       name: "Dudu 🤖",     role: "bot",           avatar: "🤖", color: "#5b3db8" },
];

// MODULE: WAHA API → GET /api/sessions / GET /api/chats
export const MOCK_CHATS = [
  {
    id: "5561999991111@c.us",
    name: "Ingrid Kelly",
    phone: "+55 61 99999-1111",
    lastMsg: "Olá, gostaria de agendar uma consulta",
    lastTime: "10:42",
    unread: 3,
    status: "open",        // open | resolved | waiting
    assignedTo: "recepcao",
    tags: ["novo"],
    avatar: "IK",
    avatarColor: "#c0412c",
  },
  {
    id: "5511988882222@c.us",
    name: "Carlos Mendes",
    phone: "+55 11 98888-2222",
    lastMsg: "Quando posso retirar minha prótese?",
    lastTime: "09:15",
    unread: 0,
    status: "open",
    assignedTo: "ana",
    tags: ["em-tratamento"],
    avatar: "CM",
    avatarColor: "#1a5fa8",
  },
  {
    id: "5561977773333@c.us",
    name: "Maria da Silva",
    phone: "+55 61 97777-3333",
    lastMsg: "Ok, obrigada!",
    lastTime: "Ontem",
    unread: 0,
    status: "resolved",
    assignedTo: "recepcao",
    tags: ["vip"],
    avatar: "MS",
    avatarColor: "#0d7d62",
  },
  {
    id: "5521966664444@c.us",
    name: "Roberto Alves",
    phone: "+55 21 96666-4444",
    lastMsg: "Tenho dor de dente urgente",
    lastTime: "08:03",
    unread: 1,
    status: "waiting",
    assignedTo: null,
    tags: ["urgente"],
    avatar: "RA",
    avatarColor: "#c0412c",
  },
];

// MODULE: WAHA API → GET /api/messages/{chatId}
export const MOCK_MESSAGES = {
  "5561999991111@c.us": [
    { id: 1, from: "patient", text: "Olá, bom dia! Gostaria de agendar uma consulta.", time: "10:38", type: "text" },
    { id: 2, from: "bot",     text: "Bom dia! Sou o Dudu 🤖, assistente da clínica. Para te atender melhor, pode me informar seu nome completo e CPF?", time: "10:38", type: "text", operator: "Dudu 🤖" },
    { id: 3, from: "patient", text: "Claro!\n\nPara agendamento preciso de algumas informações\nNome completo: Ingrid Kelly Pereira Lopes\nCPF: 06011692125\nE-mail: Ingrid.kelly13@gmail.com\nConvênio/particular: MetLife\nTelefone: 61991300525\nData de nascimento: 29/05/1999", time: "10:40", type: "text", hasPatientCard: true },
    { id: 4, from: "patient", text: "Olá, gostaria de agendar uma consulta", time: "10:42", type: "text" },
  ],
  "5511988882222@c.us": [
    { id: 1, from: "operator", text: "Boa tarde, Carlos! Sua prótese já está pronta.", time: "09:10", type: "text", operator: "Ana" },
    { id: 2, from: "patient",  text: "Quando posso retirar minha prótese?", time: "09:15", type: "text" },
  ],
};

// MODULE: Codental API → GET /prontuario/{cpf}
export const MOCK_PRONTUARIO = {
  "06011692125": {
    nome: "Ingrid Kelly Pereira Lopes",
    cpf: "060.116.921-25",
    nascimento: "29/05/1999",
    convenio: "MetLife",
    telefone: "(61) 99130-0525",
    email: "Ingrid.kelly13@gmail.com",
    dentista: "Dra. Ana",
    ultimaConsulta: "—",
    proximaConsulta: "—",
    evolucoes: [],          // MODULE: Codental → lista de evoluções
    agendamentos: [],       // MODULE: Doctoralia → lista de consultas
  },
};

// MODULE: Google Contacts API → contacts.list
export const MOCK_CONTACTS = [];

// Roles e permissões
export const ROLE_PERMISSIONS = {
  gerente:  { verTodos: true,  verRecepcao: true,  verDentistas: true,  verAdmin: true  },
  recepcao: { verTodos: false, verRecepcao: true,  verDentistas: true,  verAdmin: false },
  dentista: { verTodos: false, verRecepcao: false, verDentistas: true,  verAdmin: false },
  bot:      { verTodos: false, verRecepcao: false, verDentistas: false, verAdmin: false },
};

export const TAG_COLORS = {
  "novo":          { bg: "#e0f5ef", text: "#0d7d62" },
  "em-tratamento": { bg: "#e3eef9", text: "#1a5fa8" },
  "vip":           { bg: "#fff3dc", text: "#b56a00" },
  "urgente":       { bg: "#fdeae6", text: "#c0412c" },
  "inadimplente":  { bg: "#f5e6f5", text: "#7b2d8b" },
};

export const STATUS_LABELS = {
  open:     { label: "Aberto",    color: "#0d7d62" },
  waiting:  { label: "Aguardando", color: "#b56a00" },
  resolved: { label: "Resolvido", color: "#888"    },
};
