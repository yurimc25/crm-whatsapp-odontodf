# Como obter o Google OAuth2 Refresh Token

Você precisa fazer isso **uma vez**. Depois coloca o refresh_token no Vercel e nunca mais precisa mexer.

## Passo 1 — Cria o projeto no Google Cloud

1. Acesse https://console.cloud.google.com
2. Crie um projeto novo (ex: "clinica-crm")
3. Vá em **APIs & Services → Library**
4. Busque e ative: **Google People API**

## Passo 2 — Cria as credenciais OAuth2

1. Vá em **APIs & Services → Credentials**
2. Clique em **Create Credentials → OAuth client ID**
3. Tipo: **Desktop app** (mais simples para gerar o token)
4. Copie o **Client ID** e o **Client Secret**

## Passo 3 — Configura o consent screen

1. Vá em **OAuth consent screen**
2. User type: **Internal** (se for Google Workspace) ou External
3. Preencha nome do app e email
4. Em **Scopes**, adicione: `https://www.googleapis.com/auth/contacts.readonly`

## Passo 4 — Gera o refresh token (roda UMA VEZ no terminal)

Substitua CLIENT_ID e CLIENT_SECRET pelos seus valores:

```bash
# Instala a biblioteca Google
pip install google-auth-oauthlib

# Cria o arquivo de credenciais
cat > credentials.json << 'EOF'
{
  "installed": {
    "client_id": "SEU_CLIENT_ID.apps.googleusercontent.com",
    "client_secret": "SEU_CLIENT_SECRET",
    "redirect_uris": ["urn:ietf:wg:oauth:2.0:oob", "http://localhost"],
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token"
  }
}
EOF

# Roda o script de autenticação
python3 -c "
from google_auth_oauthlib.flow import InstalledAppFlow
flow = InstalledAppFlow.from_client_secrets_file(
    'credentials.json',
    scopes=['https://www.googleapis.com/auth/contacts.readonly']
)
creds = flow.run_local_server(port=0)
print('ACCESS TOKEN:', creds.token)
print('REFRESH TOKEN:', creds.refresh_token)
"
```

O script vai abrir o navegador. Faça login com a conta Google da clínica que tem os contatos.

Copie o **REFRESH TOKEN** que aparecer no terminal.

## Passo 5 — Adiciona no Vercel

Em **Settings → Environment Variables** no Vercel:

| Variável | Valor |
|---|---|
| `GOOGLE_CLIENT_ID` | SEU_CLIENT_ID.apps.googleusercontent.com |
| `GOOGLE_CLIENT_SECRET` | SEU_CLIENT_SECRET |
| `GOOGLE_REFRESH_TOKEN` | o token gerado no passo 4 |
| `INTERNAL_API_KEY` | mesma chave do WAHA (qualquer string longa) |

## Passo 6 — Variáveis de senha dos operadores

Ainda no Vercel, adicione uma variável por operador:

| Variável | Valor |
|---|---|
| `OPERATOR_YURI_PASS` | senha do Yuri |
| `OPERATOR_ANA_PASS` | senha da Ana |
| `OPERATOR_PATRICIA_PASS` | senha da Patrícia |

O formato é sempre: `OPERATOR_{LOGIN_MAIÚSCULO}_PASS`

Após adicionar todas as variáveis, clique em **Redeploy**.
