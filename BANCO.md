# Estrutura do banco

Banco alvo: PostgreSQL gerenciado do Supabase. Migrations para instalação nova, sem DROP/TRUNCATE ou migração de dados preexistentes.

## Tabelas e relacionamentos

| Tabela | Finalidade / referências |
| --- | --- |
| `auth.users` | Identidade gerenciada pelo Supabase Auth. Não criada pelo projeto. |
| `profiles` | Mesmo UUID de auth.users, nome, e-mail, papel e acesso ativo. |
| `companies` | Cadastro único por CNPJ e código; responsáveis referenciam profiles. |
| `competencies` | FK empresa; UNIQUE empresa+ano+mês; snapshot regime/IPI/responsáveis. |
| `competency_documents` | Documento lógico; UNIQUE competência+tipo. |
| `competency_document_versions` | FK documento; UNIQUE documento+versão e storage_path. Arquivos imutáveis no bucket. |
| `competency_field_values` | FK competência, versão de origem e perfil que confirmou; UNIQUE competência+campo. |
| `competency_cfop_values` | FK competência e versão; UNIQUE competência+versão+CFOP. |
| `fiscal_cfop_rules` | Catálogo dos 12 CFOPs explicitamente previstos, sem valores financeiros. |
| `audit_logs` | Ator, empresa/competência, entidade, estado anterior/novo, motivo, horário. Imutável. |
| `schema_migrations` | Checksum e data de cada migration; criada pelo runner. |

`competency_documents(current_version_id,id)` referencia `(id,competency_document_id)` das versões por FK composta e diferida, impedindo apontar para versão pertencente a outro documento. Um trigger verifica também a origem dos valores de campos.

Enums: `fiscal_role`, `tax_regime`, `competency_status`, `document_type`, `document_status`. Os demais estados/fontes são texto validado pelo servidor. UUID nas entidades, timestamptz nas datas e numeric(18,2) nos valores monetários. No Node, valores monetários são strings e cálculos usam Decimal. Não há FLOAT financeiro.

Não criamos tabelas separadas para configurações ou eventos: referências fiscais ficam em companies e a linha do tempo consulta audit_logs. Evita duplicação. Folga de caixa/estoques não foram criados sem confirmação da origem e fórmula na planilha. Tabela de PDFs exportados é opcional e não foi implementada; PDF é gerado sob demanda.

## Índices e consulta anual

UNIQUEs geram índices para CNPJ, código, empresa+ano+mês, documento+tipo, versões e campos. Índices adicionais: período, status da competência/documento, campo, documento de cada versão, auditoria por empresa/competência e data, CFOP por competência. Todos estão no SQL.

`vw_monthly_ficha_gestao`, com `security_invoker=true`, fornece uma linha por competência e objeto JSON com valores confirmados. Não há cópia independente dos resultados anuais. Os valores extraídos são inicialmente propostos como confirmados sem data de conferência; a tela sinaliza PRELIMINAR até confirmação. Valores desconhecidos permanecem NULL. Totais são calculados pela camada de domínio sem persistência redundante.

Compras: 1101, 1102, 1403, 2101, 2102, 2403.
Vendas ICMS, apenas comparativo: 5101, 5102, 5405, 6101, 6102, 6405.
Regras constam do catálogo e do módulo de domínio. Não há editor de CFOPs nesta versão; uma mudança deve ser versionada nos dois e testada. Receita oficial usa PIS/COFINS.

## Segurança, escrita e histórico

RLS em todas as tabelas públicas: usuário autenticado com perfil ativo pode consultar os dados do escritório. Usuário inativo ou sem perfil não pode ler. **Esta versão é para um único escritório, não multitenant.** Todas as escritas diretas por anon/authenticated foram revogadas; navegador não altera tabelas, perfis ou auditoria diretamente.

API valida token pelo Supabase `auth.getUser`, consulta o perfil ativo e verifica permissões no servidor. A conexão DATABASE_URL deve ficar restrita ao servidor/migrations. Triggers exigem um ator ativo em `app.actor`; não substituem o controle de identidade da API. Portadores da credencial administrativa do banco têm poder de administração e precisam ser tratados como operadores confiáveis.

Operações financeiras usam transação, `SELECT FOR UPDATE` e versão otimista. Quando a versão mudou, resposta 409 exige recarregar; não há sobrescrita silenciosa. O trigger também bloqueia alteração de filhos de competência fechada. Reabertura exige papel elevado e motivo. Auditoria registra o JSON anterior/novo e o ator em todas as mutações financeiras; senhas/tokens não entram em auditoria. Perfis administrados pela API também recebem evento.

Nenhuma exclusão física financeira é disponibilizada. PDFs são armazenados em bucket privado, em caminhos UUID por competência/tipo/versão, com hash SHA-256. A API emite URLs de 60 segundos após autenticação; acesso a versões antigas é permitido à equipe ativa. Não há política pública no bucket. Durante upload, falha na transação tenta remover somente o objeto novo que ficou órfão; falha de compensação pode exigir limpeza administrativa, nunca remoção automática do histórico.

Extração roda fora da transação; ao aplicar resultado, revalida versão da competência e documento. Reprocessamento usa os mesmos campos/CFOPs, mantendo raw e mudanças anteriores na auditoria. Não duplica registros. O usuário precisa confirmar explicitamente antes de reprocessar. Uma queda durante processamento pode deixar a versão com estado técnico processando: nova tentativa é permitida. Não há fila/worker persistente nesta versão.

## Migrations entregues

1. `001_initial.sql`: tabelas, enums, índices, RLS, auditoria e view.
2. `002_storage_realtime.sql`: bucket privado e publicação Realtime.
3. `003_auth_profiles.sql`: criação de perfil inativo para novos usuários Auth; metadata do usuário não pode definir seu papel.

Executadas nesta entrega: migration 001 em PostgreSQL PGlite isolado, com auth/roles mínimos de teste. 002 depende dos serviços Supabase e não foi executada em projeto real. 003 foi validada no teste isolado de cadastro. Nenhuma migration foi aplicada a banco remoto do usuário.

## Integridade

Os testes verificam preservação agosto/setembro, duplicidade, origem/confirmado, edição da empresa sem troca de identidade, regime histórico, bloqueio fechado, reabertura por papel, leitura RLS e auditoria imutável. Eles não substituem teste real de Supabase Auth/Storage/Realtime e acessos simultâneos em produção. Consultas de diagnóstico para execução após configurar o ambiente estão em `scripts/integridade.sql`.


## Versão 0.3

A migration 004 acrescenta deleted_at/deleted_by/delete_reason a empresas e competências, índices únicos apenas para registros fora da lixeira, sugestões de leitura em campos e document_jobs para fila durável. Não altera as migrations já aplicadas. Exclusões são atualizações auditadas; relatórios e políticas de leitura ocultam os registros excluídos. Dados e PDFs permanecem preservados. Há proteção para impedir edições em registros excluídos e liberação de divergência por colaborador. A fila usa reservas de 2 minutos renovadas durante a execução e tokens para impedir que uma execução antiga publique resultados após outra retomá-la.
