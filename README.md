# Ficha Gestão

Sistema web para escritórios de contabilidade acompanharem, **mês a mês, a situação econômica e tributária de cada empresa cliente**. Substitui a planilha que o time fiscal preenche à mão.

O colaborador abre a competência (mês) da empresa e anexa os PDFs das apurações: ICMS, PIS/COFINS, IRPJ/CSLL e o resumo da DCTFWeb (CPP). O sistema **lê os PDFs automaticamente** (texto + OCR), sugere os valores, o supervisor confere e fecha o mês. Depois disso dá para ver a **ficha anual** da empresa e exportar em PDF ou Excel.

> O projeto não traz nenhum dado de cliente. Os testes usam empresas e valores fictícios.

## Principais recursos

- **Empresas**: cadastro com código, CNPJ, regime tributário, IPI e responsáveis; lixeira com restauração.
- **Competências**: uma por empresa/mês, com status, fechamento e reabertura com motivo.
- **Upload de PDFs** com versionamento: substituir um arquivo cria nova versão e mantém o histórico.
- **Leitura automática local** dos PDFs com Poppler (texto) e Tesseract (OCR), sem custo de API:
  - Registro de Apuração do ICMS (valores por CFOP, débito, crédito e saldo);
  - Planilha de Lucro Presumido/Real (vendas, PIS, COFINS, IRPJ, CSLL);
  - Resumo Geral com quadro DCTFWeb (CPP = empresa + terceiros).
- **Leitura por IA (opcional)** com a API da OpenAI, só se ativada no `.env`.
- **Fila de processamento** persistente no banco, com retomada automática.
- **Conferência**: valor extraído, evidência (trecho e página) e PDF lado a lado; divergências de CNPJ ou mês bloqueiam o preenchimento.
- **Regras de segurança fiscal**: campo vazio é "desconhecido" e nunca vira zero; valores em decimal exato (sem arredondamento de ponto flutuante).
- **Perfis de acesso**: colaborador, supervisor e administrador.
- **Auditoria completa**: quem alterou, quando, valor anterior e novo.
- **Ficha anual e mensal** com comparação entre meses, exportada em **PDF** e **Excel**.
- **Diagnóstico** das ferramentas de leitura de PDF pela própria tela.

## Tecnologias e linguagens

| Linguagem / tecnologia | Uso no projeto |
|---|---|
| **TypeScript** | Linguagem principal, no servidor e na interface |
| **Vue 3** + **Vite** | Interface web (`src/`) |
| **Node.js** + **Express** | Servidor e API (`server/`) |
| **SQL (PostgreSQL)** | Banco de dados, tabelas, regras de segurança (RLS) e auditoria (`supabase/migrations/`) |
| **Supabase** | Hospeda o PostgreSQL, o login dos usuários e o armazenamento dos PDFs |
| **HTML + CSS** | Estrutura e visual das telas |
| **Batch (.bat)** | Atalho `INICIAR_WINDOWS.bat` para rodar no Windows |

Bibliotecas principais (em `package.json`): `express`, `vue`, `@supabase/supabase-js`, `pg`, `decimal.js` (cálculos exatos), `exceljs` (Excel), `pdfkit` (PDF), `zod` (validação), `helmet` e `express-rate-limit` (segurança), `multer` (upload). Nos testes, `@electric-sql/pglite` roda um PostgreSQL em memória.

## O que precisa baixar para rodar

| Programa | Obrigatório? | Para quê | Link |
|---|---|---|---|
| **Node.js 24** (versão LTS 24.12 ou superior) | Sim | Rodar o sistema (já vem com o `npm`) | https://nodejs.org/en/download |
| **Conta no Supabase** (plano gratuito serve) | Sim | Banco de dados, login e armazenamento dos PDFs | https://supabase.com |
| **Poppler** | Sim, para leitura automática | Extrair texto e imagens dos PDFs | Windows: https://github.com/oschwartz10612/poppler-windows/releases |
| **Tesseract OCR** (com idioma *eng*) | Sim, para leitura automática | Ler PDFs escaneados (OCR) | https://tesseract-ocr.github.io/tessdoc/Installation.html (Windows: https://github.com/UB-Mannheim/tesseract/wiki) |
| **Git** | Não | Clonar o repositório | https://git-scm.com/downloads |
| **Chave da OpenAI** | Não | Leitura por IA, alternativa à leitura local | https://platform.openai.com/api-keys |
| **VS Code** | Não | Editar o código | https://code.visualstudio.com/ |

> No Linux (Debian/Ubuntu), Poppler e Tesseract são instalados com:
> `sudo apt install poppler-utils tesseract-ocr tesseract-ocr-eng`

Não precisa de Python nem de instalar PostgreSQL no computador: o banco fica no Supabase.

## Instalação passo a passo

### 1. Baixar o projeto

```bash
git clone https://github.com/dbinnn/ficha-gestao.git
cd ficha-gestao
npm ci
```

Ou baixe pelo botão **Code → Download ZIP**, extraia e rode `npm ci` dentro da pasta.

### 2. Criar o projeto no Supabase

1. Crie um projeto em https://supabase.com.
2. Em **Project Settings → API**, copie a **URL**, a chave **anon/publishable** e a chave **service_role/secret**.
3. Em **Project Settings → Database**, copie a **connection string** (se a sua rede não aceitar a conexão direta, use o *pooler* em modo *Session*).
4. Em **Authentication → Providers**, deixe o login por e-mail/senha ativo e **desative o cadastro público**.
5. Em **Authentication → URL Configuration**, coloque `http://localhost:5173` em *Site URL* e *Redirect URLs*.

### 3. Configurar o `.env`

Copie o modelo:

```bash
# Windows (PowerShell)
Copy-Item .env.example .env
# Linux/macOS
cp .env.example .env
```

E preencha:

| Variável | O que colocar |
|---|---|
| `DATABASE_URL` | Connection string do banco (caracteres especiais da senha precisam ser codificados na URL) |
| `DB_SSL` | `true` (conexão criptografada) |
| `SUPABASE_URL` / `VITE_SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_ANON_KEY` / `VITE_SUPABASE_ANON_KEY` | Chave pública (anon/publishable) |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave secreta: **somente no servidor, nunca em variável `VITE_`** |
| `PDF_READER` | `local` (padrão, gratuito) ou `openai` |
| `PDFINFO_PATH`, `PDFTOTEXT_PATH`, `PDFTOPPM_PATH`, `TESSERACT_PATH` | Caminho completo dos executáveis, só se não estiverem no PATH. Use barras `/`, ex.: `C:/ferramentas/poppler/Library/bin/pdftotext.exe` |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | Só se usar `PDF_READER=openai` |
| `PORT` / `APP_URL` | Porta do servidor (3001) e URL da interface (`http://localhost:5173`) |

> **Nunca envie o `.env` para o GitHub.** Ele já está no `.gitignore`.

Se a conexão com o banco der erro de certificado, o arquivo `supabase-ca.crt` (certificado público do Supabase) já está no projeto. O `INICIAR_WINDOWS.bat` usa esse arquivo automaticamente. No terminal:

```bash
# Windows (CMD)
set "NODE_EXTRA_CA_CERTS=%cd%\supabase-ca.crt"
# Linux/macOS
export NODE_EXTRA_CA_CERTS=$PWD/supabase-ca.crt
```

### 4. Conferir as ferramentas de PDF

```bash
npm run pdf:check
```

Deve aparecer `OK` para `pdfinfo`, `pdftotext`, `pdftoppm` e `tesseract`.

### 5. Criar as tabelas no banco

```bash
npm run db:migrate
```

Aplica as migrations de `supabase/migrations/` em ordem, com controle de versão. Use **em um banco novo**.

### 6. Criar o primeiro administrador

1. No Supabase, em **Authentication → Users**, crie um usuário com seu e-mail e senha.
2. No **SQL Editor**, rode (trocando e-mail e nome):

```sql
insert into public.profiles(id, email, full_name, role, is_active)
select id, email, 'Seu nome', 'administrador', true
from auth.users where email = 'seu@email.com'
on conflict (id) do update set role = 'administrador', is_active = true;
```

### 7. Rodar

```bash
npm run dev
```

Abra http://localhost:5173 e entre com o usuário criado. No Windows, também dá para dar dois cliques em `INICIAR_WINDOWS.bat`.

Em **Equipe e acessos**, cadastre os demais usuários e seus perfis.

## Como usar

1. **Empresas**: cadastre as empresas com regime tributário e responsáveis.
2. **Dashboard**: escolha ano/mês e crie a competência da empresa.
3. **Documentos**: anexe os PDFs (até 20 MB). A leitura começa sozinha e pode levar alguns minutos com OCR.
4. **Conferência**: confira CNPJ, mês e cada valor sugerido ao lado do PDF; aceite ou corrija. ISS, despesas e IRPJ/CSLL do Lucro Real são manuais.
5. **Fechamento**: supervisor ou administrador confirma e fecha. Reabrir exige motivo.
6. **Ficha anual**: veja os 12 meses, compare períodos e exporte PDF/Excel. Meses não confirmados aparecem como *PRELIMINAR*.

| Perfil | Pode |
|---|---|
| Colaborador | Cadastrar, anexar, alimentar e consultar |
| Supervisor | Tudo do colaborador + confirmar, fechar e reabrir competências |
| Administrador | Tudo + gerenciar usuários e permissões |

## Comandos

| Comando | O que faz |
|---|---|
| `npm ci` | Instala as dependências nas versões travadas |
| `npm run dev` | Interface + servidor em modo desenvolvimento |
| `npm test` | Roda os testes automáticos (banco em memória, sem Supabase) |
| `npm run build` | Verifica o TypeScript e compila |
| `npm start` | Roda a versão compilada (produção) |
| `npm run db:migrate` | Cria/atualiza as tabelas no banco |
| `npm run pdf:check` | Testa Poppler e Tesseract |

## Publicar em um servidor

É um aplicativo Node que fica rodando: não serve hospedagem só de páginas estáticas. No servidor, com Node 24, Poppler e Tesseract instalados:

```bash
npm ci
npm run build
npm run db:migrate
npm start
```

- Configure as variáveis no painel da hospedagem **antes do build** (as `VITE_*` entram no build).
- Use HTTPS e cadastre a URL definitiva no Supabase Auth.
- Ative backup do banco **e** do bucket de PDFs no Supabase.

## Estrutura do projeto

```text
src/                    interface (Vue 3)
server/                 API, autenticação, fila, leitura de PDF e exportações
shared/                 regras de negócio e cálculos (decimal exato)
supabase/migrations/    estrutura do banco, segurança (RLS) e auditoria
scripts/                migrations, diagnóstico de PDF e consultas de integridade
tests/                  testes automáticos com dados fictícios
docs/BANCO.md           documentação detalhada do banco de dados
assets/fonts/           fonte DejaVu Sans usada nos PDFs (licença livre)
```

## Limitações conhecidas

- A leitura automática foi feita para os modelos de relatório do sistema contábil **Alterdata**; outros layouts podem precisar de ajuste ou ser preenchidos à mão.
- OCR pode errar números: a conferência humana é obrigatória.
- Versão pensada para um único escritório (não é multiempresa/multitenant).
- Limite de 15 páginas por PDF na leitura local.
