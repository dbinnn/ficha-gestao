<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { api, auth, configured } from "./api";
import {
  fields,
  labels,
  groups,
  manual,
  money,
  report,
  sum,
} from "../shared/domain";
const me = ref<any>(null),
  page = ref("dashboard"),
  tab = ref("Visão geral"),
  busy = ref(false),
  error = ref(""),
  notice = ref(""),
  email = ref(""),
  password = ref(""),
  recovery = ref(false);
const companies = ref<any[]>([]),
  profiles = ref<any[]>([]),
  competencies = ref<any[]>([]),
  detail = ref<any>(null),
  annual = ref<any>(null),
  editor = ref<any>(null),
  createMonth = ref(false);
const now = new Date();
const year = ref(now.getFullYear()),
  month = ref(now.getMonth() + 1),
  search = ref(""),
  status = ref(""),
  regime = ref(""),
  responsible = ref(""),
  supervisor = ref(""),
  reportCompany = ref("");
const draft = ref<Record<string, string>>({}),
  notes = ref<Record<string, string>>({}),
  dirty = ref(false),
  remoteChange = ref(false);
let channel: any;
const human = (s: string) => s?.replaceAll("_", " ") || "—";
const date = (s: string) => (s ? new Date(s).toLocaleString("pt-BR") : "—");
const admin = computed(() => me.value?.role === "administrador"),
  elevated = computed(() =>
    ["administrador", "supervisor"].includes(me.value?.role),
  );
const closed = computed(() => detail.value?.competency.status === "fechada");
const filtered = computed(() =>
  competencies.value.filter(
    (c) =>
      (!month.value || c.month === Number(month.value)) &&
      (!status.value || c.status === status.value) &&
      (!regime.value || c.tax_regime === regime.value) &&
      (!responsible.value ||
        (responsible.value === "none"
          ? !c.responsible_user_id
          : c.responsible_user_id === responsible.value)) &&
      (!supervisor.value || c.supervisor_user_id === supervisor.value) &&
      `${c.legal_name} ${c.cnpj} ${c.internal_code}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  ),
);
const statuses = [
  "aguardando_documentos",
  "em_preenchimento",
  "aguardando_conferencia",
  "conferida",
  "fechada",
  "divergencia",
];
const regimes = ["lucro_real", "lucro_presumido", "simples_nacional", "outros"];
const types = ["icms", "ipi", "pis_cofins", "cpp"];
const tabs = [
  "Visão geral",
  "Documentos",
  "Conferência",
  "Ficha Gestão",
  "Histórico",
];
const notStarted = computed(
  () =>
    companies.value.filter(
      (c) =>
        c.is_active &&
        !competencies.value.some(
          (k) => k.company_id === c.id && k.month === Number(month.value),
        ),
    ).length,
);
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Falha inesperada.";
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  const [co, p, c] = await Promise.all([
    api("/companies"),
    api("/profiles"),
    api("/competencies?year=" + year.value),
  ]);
  companies.value = co;
  profiles.value = p;
  competencies.value = c;
}
async function start() {
  me.value = await api("/me");
  await refresh();
  channel = auth!
    .channel("fiscal-shared")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "competencies" },
      () => {
        refresh().catch(() => {});
        if (page.value === "reports" && reportCompany.value)
          loadReport().catch(() => {});
        if (detail.value) remoteChange.value = true;
      },
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "companies" },
      () => refresh().catch(() => {}),
    )
    .subscribe();
}
async function login() {
  await run(async () => {
    const { error: e } = await auth!.auth.signInWithPassword({
      email: email.value,
      password: password.value,
    });
    if (e) throw Error("E-mail ou senha inválidos.");
    password.value = "";
    await start();
  });
}
async function reset() {
  await run(async () => {
    if (!email.value) throw Error("Informe seu e-mail.");
    const { error: e } = await auth!.auth.resetPasswordForEmail(email.value, {
      redirectTo: location.origin,
    });
    if (e) throw e;
    notice.value =
      "Se o e-mail estiver cadastrado, você receberá as instruções de recuperação.";
  });
}
async function updatePassword() {
  await run(async () => {
    if (password.value.length < 12)
      throw Error("Use uma senha com pelo menos 12 caracteres.");
    const { error: e } = await auth!.auth.updateUser({
      password: password.value,
    });
    if (e) throw e;
    recovery.value = false;
    password.value = "";
    await start();
  });
}
async function logout() {
  await auth?.auth.signOut();
  if (channel) await auth?.removeChannel(channel);
  me.value = null;
  detail.value = null;
  companies.value = [];
  competencies.value = [];
  annual.value = null;
  page.value = "dashboard";
}
async function open(id: string) {
  if (dirty.value && !confirm("Descartar alterações ainda não salvas?")) return;
  if (detail.value?.competency.id !== id) {
    closePreview();
    batchFiles.value = {};
  }
  detail.value = await api("/competencies/" + id);
  draft.value = Object.fromEntries(
    detail.value.values.map((v: any) => [v.field_key, v.confirmed_value ?? ""]),
  );
  notes.value = Object.fromEntries(
    detail.value.values.map((v: any) => [v.field_key, v.notes ?? ""]),
  );
  dirty.value = false;
  remoteChange.value = false;
  page.value = "competency";
}
function editCompany(c?: any) {
  editor.value = c
    ? { ...c }
    : {
        internal_code: "",
        legal_name: "",
        trade_name: "",
        cnpj: "",
        default_tax_regime: "lucro_presumido",
        has_ipi: false,
        responsible_user_id: null,
        supervisor_user_id: null,
        margin_reference: null,
        tax_load_reference: null,
        is_active: true,
      };
}
async function saveCompany() {
  await run(async () => {
    const b = editor.value;
    await api("/companies" + (b.id ? "/" + b.id : ""), {
      method: b.id ? "PUT" : "POST",
      body: JSON.stringify(b),
    });
    editor.value = null;
    await refresh();
    notice.value = "Empresa salva.";
  });
}
const newUser = ref<any>(null);
async function saveUser() {
  await run(async () => {
    await api("/profiles", {
      method: "POST",
      body: JSON.stringify(newUser.value),
    });
    newUser.value = null;
    await refresh();
    notice.value =
      "Usuário cadastrado. Oriente a troca da senha no primeiro acesso.";
  });
}
const newCompany = ref("");
async function addMonth() {
  await run(async () => {
    const c = await api("/competencies", {
      method: "POST",
      body: JSON.stringify({
        company_id: newCompany.value,
        year: Number(year.value),
        month: Number(month.value),
      }),
    });
    createMonth.value = false;
    await refresh();
    await open(c.id);
  });
}
async function saveValues() {
  await run(async () => {
    await api("/competencies/" + detail.value.competency.id + "/values", {
      method: "PUT",
      body: JSON.stringify({
        version: detail.value.competency.version,
        values: fields.map((key) => ({
          key,
          value: draft.value[key] === "" ? null : String(draft.value[key]),
          notes: notes.value[key] || "",
        })),
      }),
    });
    dirty.value = false;
    await open(detail.value.competency.id);
    notice.value = "Valores salvos e conferidos. Confira também os documentos.";
  });
}
async function transition(action: string) {
  const reason = action === "reopen" ? prompt("Motivo da reabertura:") : "";
  if (action === "reopen" && !reason) return;
  await run(async () => {
    await api("/competencies/" + detail.value.competency.id + "/transition", {
      method: "POST",
      body: JSON.stringify({
        action,
        reason: reason || "",
        version: detail.value.competency.version,
      }),
    });
    await open(detail.value.competency.id);
    await refresh();
  });
}
async function ipi() {
  const reason = prompt("Justifique a alteração da aplicabilidade do IPI:");
  if (!reason) return;
  await run(async () => {
    await api("/competencies/" + detail.value.competency.id + "/ipi", {
      method: "POST",
      body: JSON.stringify({
        version: detail.value.competency.version,
        applicable: !detail.value.competency.ipi_applicable,
        reason,
      }),
    });
    await open(detail.value.competency.id);
  });
}
async function attach(e: Event, type: string) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  await run(async () => {
    await uploadFile(file, type);
    notice.value =
      "PDF anexado e colocado na fila de leitura. Você pode continuar trabalhando.";
  });
  input.value = "";
}
async function uploadFile(file: File, type: string) {
  const cid = detail.value.competency.id;
  const form = new FormData();
  form.append("file", file);
  form.append("version", detail.value.competency.version);
  await api("/competencies/" + cid + "/documents/" + type, {
    method: "POST",
    body: form,
  });
  await open(cid);
  await refreshJobs();
}
async function processDoc(d: any) {
  await run(async () => {
    await api("/documents/" + d.id + "/process", {
      method: "POST",
      body: JSON.stringify({ version: detail.value.competency.version }),
    });
    await open(detail.value.competency.id);
    await refreshJobs();
    notice.value =
      "Leitura adicionada à fila. Os valores conferidos serão preservados como escolhas para revisão.";
  });
}
async function reviewDoc(d: any) {
  if (d.status === "divergencia" && !elevated.value) {
    error.value = "Divergência exige liberação pelo supervisor.";
    return;
  }
  const reason = prompt(
    d.status === "divergencia"
      ? "Liberação pelo supervisor: descreva a divergência e o motivo da aceitação (mínimo 10 caracteres). Valores divergentes não serão importados."
      : "Registre a conferência da empresa, competência e valores deste documento:",
  );
  if (!reason) return;
  await run(async () => {
    await api("/documents/" + d.id + "/review", {
      method: "POST",
      body: JSON.stringify({
        version: detail.value.competency.version,
        reason,
      }),
    });
    await open(detail.value.competency.id);
  });
}
const preview = ref<any>(null);
function closePreview() {
  if (preview.value) URL.revokeObjectURL(preview.value.url);
  preview.value = null;
}
async function viewDoc(version: string, pageNumber = 1) {
  await run(async () => {
    const blob = await api("/documents/" + version + "/file");
    closePreview();
    preview.value = { url: URL.createObjectURL(blob), page: pageNumber };
  });
}
function evidence(v: any) {
  const version = v.has_suggestion
    ? v.suggested_document_version_id
    : v.source_document_version_id || v.suggested_document_version_id;
  const page =
    version === v.suggested_document_version_id
      ? v.suggested_page
      : Number(v.evidence?.match(/Página (\d+)/)?.[1]);
  viewDoc(version, page || 1);
}
async function loadReport() {
  annual.value = null;
  if (!reportCompany.value) return;
  annual.value = await api(
    "/reports/" + reportCompany.value + "/" + year.value,
  );
  page.value = "reports";
}
async function downloadPdf() {
  await run(async () => {
    const blob = await api(
      "/reports/" + reportCompany.value + "/" + year.value + "?format=pdf",
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Ficha-Gestao-" + year.value + ".pdf";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
const annualRows = computed(() =>
  Array.from({ length: 12 }, (_, i) => {
    const m = annual.value?.months.find((m: any) => m.month === i + 1);
    return {
      month: i + 1,
      status: m?.status,
      values: m?.values || {},
      calc: report(m?.values || {}),
    };
  }),
);
const annualTotals = computed(() => {
  const months = annualRows.value.filter((x) => x.status);
  return {
    vendas: months.length
      ? sum(months.map((x) => x.values.vendas_mercadorias))
      : null,
    servicos: months.length
      ? sum(months.map((x) => x.values.vendas_servicos))
      : null,
    receita: months.length ? sum(months.map((x) => x.calc.receita)) : null,
    impostos: months.length ? sum(months.map((x) => x.calc.impostos)) : null,
    compras: months.length ? sum(months.map((x) => x.values.compras)) : null,
    despesas: months.length ? sum(months.map((x) => x.values.despesas)) : null,
    resultado: months.length ? sum(months.map((x) => x.calc.resultado)) : null,
  };
});
async function profileChange(p: any) {
  await run(async () => {
    await api("/profiles/" + p.id, {
      method: "PATCH",
      body: JSON.stringify({ role: p.role, is_active: p.is_active }),
    });
    await refresh();
    notice.value = "Permissões atualizadas.";
  });
}
function navigate(p: string) {
  if (dirty.value && !confirm("Descartar alterações não salvas?")) return;
  dirty.value = false;
  closePreview();
  if (p === "trash") run(loadTrash);
  if (p === "system") run(loadDiagnostics);
  if (p === "jobs") run(refreshJobs);
  page.value = p;
}
const jobs = ref<any[]>([]),
  trash = ref<any>({ companies: [], competencies: [] }),
  diagnostics = ref<any>(null);
const deletion = ref<any>(null),
  deleteReason = ref(""),
  deleteConfirm = ref("");
const comparison = ref<any>(null),
  comparisonThreshold = ref(50),
  exportMonth = ref(0),
  activeFilter = ref("");
const batchFiles = ref<Record<string, File>>({});
let polling: ReturnType<typeof setInterval> | undefined;
let pollBusy = false;
const visibleCompanies = computed(() =>
  companies.value.filter(
    (c) =>
      (c.legal_name + c.cnpj + c.internal_code)
        .toLowerCase()
        .includes(search.value.toLowerCase()) &&
      (!regime.value || c.default_tax_regime === regime.value) &&
      (!responsible.value ||
        (responsible.value === "none"
          ? !c.responsible_user_id
          : c.responsible_user_id === responsible.value)) &&
      (!supervisor.value || c.supervisor_user_id === supervisor.value) &&
      (!activeFilter.value || String(c.is_active) === activeFilter.value),
  ),
);
const ownerPending = computed(() => {
  const map = new Map<string, any>();
  for (const c of filtered.value) {
    const key = c.responsible_user_id || "none";
    const row = map.get(key) || {
      id: key,
      name: c.responsible_name || "Sem responsável",
      companies: 0,
      pending: 0,
    };
    row.companies++;
    row.pending += (c.pending || []).length;
    map.set(key, row);
  }
  return [...map.values()];
});
const unstartedCompanies = computed(() =>
  month.value
    ? visibleCompanies.value.filter(
        (c) =>
          c.is_active &&
          !competencies.value.some(
            (x) => x.company_id === c.id && x.month === Number(month.value),
          ),
      )
    : [],
);
const jobLabel = (s: string) =>
  ({
    queued: "Na fila",
    running: "Lendo",
    done: "Concluída",
    error: "Erro",
    cancelled: "Cancelada",
  })[s] || s;
const fieldValue = (key: string) =>
  detail.value.values.find((v: any) => v.field_key === key);
async function refreshJobs() {
  jobs.value = await api("/jobs");
}
async function pollJobs() {
  if (!me.value || pollBusy) return;
  pollBusy = true;
  try {
    const before = JSON.stringify(jobs.value.map((j) => [j.id, j.status]));
    await refreshJobs();
    const changed =
      before !== JSON.stringify(jobs.value.map((j) => [j.id, j.status]));
    if (changed) {
      await refresh();
      if (detail.value && page.value === "competency") {
        if (!busy.value && !dirty.value) await open(detail.value.competency.id);
        else remoteChange.value = true;
      }
    }
  } catch {
  } finally {
    pollBusy = false;
  }
}
async function retryJob(j: any) {
  await run(async () => {
    await api("/jobs/" + j.id + "/retry", { method: "POST", body: "{}" });
    await refreshJobs();
    notice.value = "Leitura recolocada na fila.";
  });
}
function askDelete(type: string, row: any) {
  deletion.value = {
    type,
    row,
    label:
      type === "companies"
        ? row.legal_name
        : String(row.month).padStart(2, "0") + "/" + row.year,
    token:
      type === "companies"
        ? row.internal_code
        : String(row.month).padStart(2, "0") + "/" + row.year,
  };
  deleteReason.value = "";
  deleteConfirm.value = "";
  error.value = "";
}
async function deleteRecord() {
  await run(async () => {
    const { type, row } = deletion.value;
    if (deleteConfirm.value !== deletion.value.token)
      throw Error("Digite a confirmação exatamente como indicada.");
    await api("/" + type + "/" + row.id, {
      method: "DELETE",
      body: JSON.stringify({
        version: row.version,
        reason: deleteReason.value,
      }),
    });
    deletion.value = null;
    detail.value = null;
    closePreview();
    annual.value = null;
    page.value = type === "companies" ? "companies" : "dashboard";
    await refresh();
    await refreshJobs();
    notice.value = "Registro excluído e movido para a lixeira.";
  });
}
async function loadTrash() {
  trash.value = await api("/trash");
}
async function restoreRecord(type: string, row: any) {
  const reason = prompt("Motivo da restauração:");
  if (!reason) return;
  await run(async () => {
    await api("/trash/" + type + "/" + row.id + "/restore", {
      method: "POST",
      body: JSON.stringify({ version: row.version, reason }),
    });
    await loadTrash();
    await refresh();
    notice.value =
      type === "companies"
        ? "Empresa restaurada como inativa. Ative-a no cadastro e restaure os lançamentos desejados."
        : "Lançamento restaurado.";
  });
}
async function loadDiagnostics() {
  diagnostics.value = await api("/system/diagnostics");
}
async function resolveSuggestion(v: any, action: string) {
  await run(async () => {
    const doc = detail.value.documents.find(
      (d: any) => d.current_version_id === v.suggested_document_version_id,
    );
    if (!doc) throw Error("PDF substituído; processe a versão atual.");
    await api("/documents/" + doc.id + "/suggestions", {
      method: "POST",
      body: JSON.stringify({
        version: detail.value.competency.version,
        keys: [v.field_key],
        action,
      }),
    });
    await open(detail.value.competency.id);
  });
}
function selectBatch(e: Event, type: string) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) batchFiles.value[type] = f;
  else delete batchFiles.value[type];
}
async function uploadBatch() {
  await run(async () => {
    const failures: string[] = [];
    for (const [type, file] of Object.entries(batchFiles.value)) {
      try {
        await open(detail.value.competency.id);
        await uploadFile(file, type);
        delete batchFiles.value[type];
      } catch (e: any) {
        failures.push(type + ": " + e.message);
      }
    }
    notice.value = "Os PDFs enviados estão na fila. Acompanhe em Leituras.";
    if (failures.length) throw Error(failures.join(" | "));
  });
}
async function downloadFile(route: string, name: string) {
  const blob = await api(route);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function exportCompanies() {
  await run(async () => {
    if (!visibleCompanies.value.length)
      throw Error("Não há empresas neste filtro.");
    await downloadFile(
      "/companies-export?ids=" +
        visibleCompanies.value.map((c) => c.id).join(","),
      "Empresas-Ficha-Gestao.xlsx",
    );
  });
}
async function exportReport() {
  await run(async () => {
    await downloadFile(
      "/reports/" +
        reportCompany.value +
        "/" +
        year.value +
        "/excel?month=" +
        exportMonth.value,
      "Ficha-Gestao-" +
        year.value +
        (exportMonth.value
          ? "-" + String(exportMonth.value).padStart(2, "0")
          : "") +
        ".xlsx",
    );
  });
}
async function compareMonths() {
  await run(async () => {
    comparison.value = await api(
      "/competencies/" + detail.value.competency.id + "/comparison",
    );
  });
}
const beforeUnload = (e: BeforeUnloadEvent) => {
  if (dirty.value) {
    e.preventDefault();
    e.returnValue = "";
  }
};
onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  polling = setInterval(() => void pollJobs(), 4000);
  if (auth) {
    auth.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") recovery.value = true;
      if (event === "SIGNED_OUT") me.value = null;
    });
    run(async () => {
      const { data } = await auth!.auth.getSession();
      if (data.session && !location.hash.includes("type=recovery"))
        await start();
    });
  }
});
onUnmounted(() => {
  if (channel) auth?.removeChannel(channel);
  window.removeEventListener("beforeunload", beforeUnload);
  if (polling) clearInterval(polling);
  closePreview();
});
</script>
<template>
  <div v-if="!me || recovery" class="login-page">
    <section class="login-story">
      <div class="brand login-brand">
        <div class="brand-lockup">
          <img class="brand-mark-image" src="/logo-mark.png" alt="" /><span
            class="brand-name"
            >Ficha Gestão</span
          >
        </div>
        <span class="brand-caption">GESTÃO FISCAL</span>
      </div>
      <div>
        <span class="eyebrow">GESTÃO FISCAL · UM MÊS DE CADA VEZ</span>
        <h1>Mais clareza.<br />Mais controle.<br />Uma só ficha.</h1>
        <p>
          Documentos, conferência e histórico reunidos para cuidar de cada
          empresa com segurança.
        </p>
      </div>
      <small>Ficha Gestão • Ambiente interno</small>
    </section>
    <section class="login-panel">
      <form @submit.prevent="recovery ? updatePassword() : login()">
        <span class="eyebrow">BEM-VINDO À FICHA GESTÃO</span>
        <h2>
          {{ recovery ? "Defina uma nova senha" : "Acesse seu escritório" }}
        </h2>
        <p class="muted">Use o acesso liberado pelo administrador.</p>
        <div v-if="!configured" class="alert">
          Configuração inicial necessária. Siga o README do projeto para
          conectar seu Supabase. Nenhum dado de demonstração foi carregado.
        </div>
        <label v-if="!recovery"
          >E-mail<input
            v-model="email"
            type="email"
            autocomplete="username"
            required
            placeholder="voce@escritorio.com.br" /></label
        ><label
          >{{ recovery ? "Nova senha" : "Senha"
          }}<input
            v-model="password"
            type="password"
            :autocomplete="recovery ? 'new-password' : 'current-password'"
            required
            :minlength="recovery ? 12 : 1"
        /></label>
        <p v-if="error" role="alert" class="alert error">{{ error }}</p>
        <p v-if="notice" role="status" class="alert">{{ notice }}</p>
        <button class="primary wide" :disabled="busy || !configured">
          {{
            busy
              ? "Aguarde…"
              : recovery
                ? "Salvar nova senha"
                : "Entrar no sistema →"
          }}</button
        ><button
          v-if="!recovery"
          type="button"
          class="text-button wide"
          @click="reset"
          :disabled="busy || !configured"
        >
          Esqueci minha senha</button
        ><small class="muted"
          >Acesso restrito à equipe. Seus registros ficam no banco central do
          escritório.</small
        >
      </form>
    </section>
  </div>
  <div v-else class="shell">
    <aside class="sidebar">
      <div class="brand sidebar-brand">
        <div class="brand-lockup">
          <img class="brand-mark-image" src="/logo-mark.png" alt="" /><span
            class="brand-name"
            >Ficha Gestão</span
          >
        </div>
        <div>Ficha Gestão<small>GESTÃO FISCAL</small></div>
      </div>
      <span class="nav-caption">ESCRITÓRIO</span>
      <nav>
        <button
          v-for="[key, icon, label] in [
            ['dashboard', '▦', 'Visão geral'],
            ['companies', '▤', 'Empresas'],
            ['reports', '▥', 'Ficha anual'],
            ['jobs', '↻', 'Leituras'],
          ]"
          :class="{ active: page === key }"
          @click="navigate(key)"
        >
          <span>{{ icon }}</span
          >{{ label }}</button
        ><button
          v-if="admin"
          :class="{ active: page === 'users' }"
          @click="navigate('users')"
        >
          <span>♙</span>Equipe e acessos
        </button>
        <button
          v-if="admin"
          :class="{ active: page === 'trash' }"
          @click="navigate('trash')"
        >
          <span>♲</span>Lixeira
        </button>
        <button
          v-if="admin"
          :class="{ active: page === 'system' }"
          @click="navigate('system')"
        >
          <span>⚙</span>Diagnóstico
        </button>
      </nav>
      <div class="sidebar-bottom">
        <p>Um histórico que<br />acompanha sua empresa.</p>
        <small>Dados compartilhados<br />com a equipe autorizada</small>
      </div>
    </aside>
    <div class="workspace" :class="{ 'preview-open': preview }">
      <header class="topbar">
        <span
          >Fiscal
          <span class="muted"
            >/
            {{
              page === "competency"
                ? "Competência"
                : page === "reports"
                  ? "Ficha anual"
                  : page === "companies"
                    ? "Empresas"
                    : "Gestão"
            }}</span
          ></span
        >
        <div class="user">
          <span class="avatar">{{ me.full_name.charAt(0) }}</span>
          <div>
            {{ me.full_name }}<small>{{ human(me.role) }}</small>
          </div>
          <button class="text-button" @click="logout">Sair</button>
        </div>
      </header>
      <main>
        <div v-if="busy" class="progress" role="status">
          Processando solicitação…
        </div>
        <div v-if="error" class="alert error" role="alert">
          {{ error }}
          <button @click="error = ''" aria-label="Fechar aviso">×</button>
        </div>
        <div v-if="notice" class="alert" role="status">{{ notice }}</div>
        <template v-if="page === 'dashboard'"
          ><div class="page-heading">
            <div>
              <span class="eyebrow">ACOMPANHAMENTO MENSAL</span>
              <h1>Visão geral</h1>
              <p class="muted">
                Cada competência no seu lugar. Nenhuma pendência esquecida.
              </p>
            </div>
            <button class="primary" @click="createMonth = true">
              + Nova competência
            </button>
          </div>
          <div class="stats">
            <article>
              <small>Empresas ativas</small
              ><strong>{{ companies.filter((c) => c.is_active).length }}</strong
              ><span>Carteira do escritório</span>
            </article>
            <article>
              <small>Não iniciadas</small
              ><strong>{{ month ? notStarted : "—" }}</strong
              ><span>No mês selecionado</span>
            </article>
            <article v-for="s in ['aguardando_conferencia', 'fechada']">
              <small>{{ human(s) }}</small
              ><strong>{{
                filtered.filter((c) => c.status === s).length
              }}</strong
              ><span>Competências do filtro</span>
            </article>
          </div>
          <section class="panel padded">
            <h2>Pendências por responsável</h2>
            <div class="owner-grid">
              <button
                v-for="owner in ownerPending"
                @click="responsible = owner.id"
              >
                <b>{{ owner.name }}</b
                ><span
                  >{{ owner.companies }} lançamentos ·
                  {{ owner.pending }} pendências</span
                >
              </button>
            </div>
          </section>
          <section v-if="unstartedCompanies.length" class="panel padded">
            <h2>Empresas sem lançamento neste mês</h2>
            <div class="owner-grid">
              <button
                v-for="c in unstartedCompanies"
                @click="
                  newCompany = c.id;
                  createMonth = true;
                "
              >
                {{ c.internal_code }} · {{ c.legal_name }}
                <span>Iniciar {{ month }}/{{ year }}</span>
              </button>
            </div>
          </section>
          <section class="panel">
            <div class="panel-heading">
              <h2>Mapa de competências</h2>
              <small>{{ filtered.length }} registros</small>
            </div>
            <div class="filters">
              <label class="grow"
                >Buscar empresa<input
                  v-model="search"
                  placeholder="Nome, código ou CNPJ" /></label
              ><label
                >Ano<input
                  v-model.number="year"
                  type="number"
                  min="2000"
                  max="2200"
                  @change="run(refresh)" /></label
              ><label
                >Mês<select v-model.number="month">
                  <option :value="0">Todos</option>
                  <option v-for="n in 12" :value="n">
                    {{ String(n).padStart(2, "0") }}
                  </option>
                </select></label
              ><label
                >Status<select v-model="status">
                  <option value="">Todos</option>
                  <option v-for="s in statuses">{{ s }}</option>
                </select></label
              ><label
                >Regime<select v-model="regime">
                  <option value="">Todos</option>
                  <option v-for="s in regimes" :value="s">
                    {{ human(s) }}
                  </option>
                </select></label
              ><label
                >Responsável<select v-model="responsible">
                  <option value="">Todos</option>
                  <option value="none">Sem responsável</option>
                  <option v-for="p in profiles" :value="p.id">
                    {{ p.full_name }}
                  </option>
                </select></label
              ><label
                >Supervisor<select v-model="supervisor">
                  <option value="">Todos</option>
                  <option v-for="p in profiles" :value="p.id">
                    {{ p.full_name }}
                  </option>
                </select></label
              >
            </div>
            <div class="status-strip">
              <span v-for="s in statuses"
                >{{ human(s) }}
                <b>{{ filtered.filter((c) => c.status === s).length }}</b></span
              >
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Empresa</th>
                    <th>Competência</th>
                    <th>Regime / responsável</th>
                    <th>Status / documentos</th>
                    <th>Atualização</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="c in filtered" :key="c.id">
                    <td>
                      <b>{{ c.internal_code }} · {{ c.legal_name }}</b
                      ><small>{{ c.cnpj }}</small>
                    </td>
                    <td>{{ String(c.month).padStart(2, "0") }}/{{ c.year }}</td>
                    <td>
                      {{ human(c.tax_regime)
                      }}<small>{{
                        c.responsible_name || "Sem responsável"
                      }}</small>
                    </td>
                    <td>
                      <span class="badge" :class="c.status">{{
                        human(c.status)
                      }}</span
                      ><small
                        >{{ c.processed_documents }} documentos com dados</small
                      >
                    </td>
                    <td>{{ date(c.updated_at) }}</td>
                    <td>
                      <button @click="run(() => open(c.id))">
                        Abrir ficha →
                      </button>
                      <button
                        v-if="elevated"
                        class="danger text-button"
                        :disabled="busy"
                        @click="askDelete('competencies', c)"
                      >
                        Excluir lançamento
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="!filtered.length" class="empty">
                <span>▤</span>
                <h3>Nenhuma competência neste filtro</h3>
                <p>Cadastre uma empresa e abra o primeiro mês para começar.</p>
                <button @click="navigate('companies')">Ver empresas</button>
              </div>
            </div>
          </section></template
        >
        <template v-if="page === 'companies'"
          ><div class="page-heading">
            <div>
              <span class="eyebrow">CARTEIRA DO ESCRITÓRIO</span>
              <h1>Empresas</h1>
              <p class="muted">
                Cadastros e parâmetros. O histórico de cada mês permanece
                preservado.
              </p>
            </div>
            <button :disabled="busy" @click="exportCompanies">
              Exportar Excel
            </button>
            <button v-if="admin" class="primary" @click="editCompany()">
              + Cadastrar empresa
            </button>
          </div>
          <section class="panel">
            <div class="filters">
              <label class="grow"
                >Buscar<input
                  v-model="search"
                  placeholder="Nome ou CNPJ" /></label
              ><label
                >Situação<select v-model="activeFilter">
                  <option value="">Todas</option>
                  <option value="true">Ativas</option>
                  <option value="false">Inativas</option>
                </select></label
              >
              <label
                >Regime<select v-model="regime">
                  <option value="">Todos</option>
                  <option v-for="r in regimes" :value="r">
                    {{ human(r) }}
                  </option>
                </select></label
              >
              <label
                >Responsável<select v-model="responsible">
                  <option value="">Todos</option>
                  <option v-for="p in profiles" :value="p.id">
                    {{ p.full_name }}
                  </option>
                </select></label
              >
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Código / empresa</th>
                    <th>CNPJ</th>
                    <th>Regime atual</th>
                    <th>IPI</th>
                    <th>Situação</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="c in visibleCompanies">
                    <td>
                      <b>{{ c.internal_code }} · {{ c.legal_name }}</b
                      ><small>{{ c.trade_name }}</small>
                    </td>
                    <td>{{ c.cnpj }}</td>
                    <td>{{ human(c.default_tax_regime) }}</td>
                    <td>{{ c.has_ipi ? "Sim" : "Não se aplica" }}</td>
                    <td>
                      <span class="badge">{{
                        c.is_active ? "Ativa" : "Inativa"
                      }}</span>
                    </td>
                    <td class="actions">
                      <button
                        @click="
                          reportCompany = c.id;
                          run(loadReport);
                        "
                      >
                        Visualizar</button
                      ><button v-if="admin" @click="editCompany(c)">
                        Editar / inativar</button
                      ><button
                        v-if="admin"
                        class="danger"
                        :disabled="busy"
                        @click="askDelete('companies', c)"
                      >
                        Excluir empresa
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="!companies.length" class="empty">
                <h3>Sua carteira começa aqui</h3>
                <p>
                  {{
                    admin
                      ? "Cadastre a primeira empresa."
                      : "Solicite ao administrador o cadastro das empresas."
                  }}
                </p>
              </div>
            </div>
          </section></template
        >
        <template v-if="page === 'competency' && detail"
          ><div class="page-heading">
            <div>
              <span class="eyebrow"
                >{{ detail.competency.cnpj }} ·
                {{ human(detail.competency.tax_regime) }}</span
              >
              <h1>{{ detail.competency.legal_name }}</h1>
              <p class="muted">
                {{ String(detail.competency.month).padStart(2, "0") }}/{{
                  detail.competency.year
                }}
                · Atualizada em {{ date(detail.competency.updated_at) }}
              </p>
              <p class="muted">
                Responsável:
                {{
                  profiles.find(
                    (p) => p.id === detail.competency.responsible_user_id,
                  )?.full_name || "Não definido"
                }}
                · Supervisor:
                {{
                  profiles.find(
                    (p) => p.id === detail.competency.supervisor_user_id,
                  )?.full_name || "Não definido"
                }}
              </p>
            </div>
            <span class="badge" :class="detail.competency.status">{{
              human(detail.competency.status)
            }}</span>
          </div>
          <div v-if="remoteChange" class="alert">
            Há uma atualização no banco. Recarregue para consultar a versão
            atual.
            <button @click="run(() => open(detail.competency.id))">
              Recarregar
            </button>
          </div>
          <div class="tabs">
            <button
              v-for="t in tabs"
              :class="{ selected: tab === t }"
              @click="tab = t"
            >
              {{ t }}
            </button>
          </div>
          <section v-if="tab === 'Visão geral'" class="overview-grid">
            <div class="panel padded">
              <h2>Próximos passos</h2>
              <p v-if="closed" class="alert">
                Competência fechada. A edição exige reabertura pelo supervisor.
              </p>
              <p v-if="!detail.pending.length" class="alert">
                Documentos e campos conferidos. A competência pode seguir para
                confirmação.
              </p>
              <ul class="pending">
                <li v-for="p in detail.pending">{{ p }}</li>
              </ul>
              <div class="actions" v-if="elevated">
                <button
                  v-if="!closed"
                  class="primary"
                  :disabled="busy || dirty || detail.pending.length > 0"
                  @click="transition('confirm')"
                >
                  Confirmar competência</button
                ><button
                  v-if="!closed"
                  :disabled="
                    busy || dirty || detail.competency.status !== 'conferida'
                  "
                  @click="transition('close')"
                >
                  Fechar competência</button
                ><button v-if="closed" @click="transition('reopen')">
                  Reabrir com motivo
                </button>
              </div>
              <p v-else class="muted">
                Confirmação e fechamento são realizados pelo supervisor ou
                administrador.
              </p>
            </div>
            <div class="panel padded">
              <h2>Documentos do mês</h2>
              <div class="doc-line" v-for="d in detail.documents">
                <b>{{ human(d.document_type).toUpperCase() }}</b
                ><span class="badge">{{ human(d.status) }}</span>
              </div>
              <hr />
              <h3>Aplicabilidade do IPI</h3>
              <p>
                {{
                  detail.competency.ipi_applicable
                    ? "Apuração obrigatória neste mês."
                    : "Não se aplica: débitos, créditos e saldo iguais a zero."
                }}
              </p>
              <button :disabled="closed || busy || dirty" @click="ipi">
                Alterar com justificativa
              </button>
            </div>
          </section>
          <section
            v-if="!closed && tab === 'Documentos'"
            class="panel padded batch-panel"
          >
            <h2>Enviar documentos da competência</h2>
            <p class="muted">
              Selecione um PDF por tipo. Todos serão enviados para a fila desta
              empresa e competência.
            </p>
            <div class="batch-grid">
              <label
                v-for="type in types.filter(
                  (t) => t !== 'ipi' || detail.competency.ipi_applicable,
                )"
                >{{ human(type)
                }}<input
                  type="file"
                  accept="application/pdf"
                  :disabled="busy || dirty"
                  @change="selectBatch($event, type)"
              /></label>
            </div>
            <button
              class="primary"
              :disabled="busy || dirty || !Object.keys(batchFiles).length"
              @click="uploadBatch"
            >
              Enviar PDFs selecionados
            </button>
          </section>
          <div v-if="tab === 'Documentos'" class="document-grid">
            <article v-for="d in detail.documents" class="panel padded">
              <div class="panel-heading">
                <h2>{{ human(d.document_type).toUpperCase() }}</h2>
                <span class="badge" :class="d.status">{{
                  human(d.status)
                }}</span>
              </div>
              <p class="file-name">
                {{ d.original_filename || "Nenhum documento anexado" }}
              </p>
              <p v-if="d.processing_error" class="alert error">
                {{ d.processing_error }}
              </p>
              <p v-if="d.status === 'divergencia'" class="alert error">
                Divergência identificada. Confira abaixo os dados esperados e os
                encontrados no PDF.
              </p>
              <ul
                v-if="d.raw_extracted_data?.validation_issues?.length"
                class="alert error"
              >
                <li v-for="issue in d.raw_extracted_data.validation_issues">
                  {{ issue }}
                </li>
              </ul>
              <p v-if="d.job" class="job-message" :class="d.job.status">
                {{ jobLabel(d.job.status) }} · {{ d.job.message }}
              </p>
              <template v-if="d.status !== 'nao_se_aplica'"
                ><div class="actions">
                  <label class="button" v-if="!closed"
                    >{{ d.current_version_id ? "Substituir PDF" : "Anexar PDF"
                    }}<input
                      class="file-input"
                      type="file"
                      accept="application/pdf"
                      :disabled="busy || dirty"
                      @change="attach($event, d.document_type)" /></label
                  ><button
                    v-if="d.current_version_id"
                    @click="viewDoc(d.current_version_id)"
                  >
                    Visualizar</button
                  ><button
                    v-if="d.current_version_id && !closed"
                    :disabled="
                      busy ||
                      dirty ||
                      ['queued', 'running'].includes(d.job?.status)
                    "
                    @click="processDoc(d)"
                  >
                    Processar leitura</button
                  ><button
                    v-if="d.current_version_id && !closed"
                    :disabled="busy || dirty"
                    @click="reviewDoc(d)"
                  >
                    Conferi o documento
                  </button>
                </div>
                <ul v-if="d.raw_extracted_data?.warnings?.length" class="alert">
                  <li
                    v-for="warning in d.raw_extracted_data.warnings"
                    :key="warning"
                  >
                    {{ warning }}
                  </li>
                </ul>
                <details v-if="d.raw_extracted_data">
                  <summary>Ver evidências da leitura</summary>
                  <pre>{{ JSON.stringify(d.raw_extracted_data, null, 2) }}</pre>
                </details>
                <details>
                  <summary>Versões anteriores e upload</summary>
                  <div
                    v-for="v in detail.versions.filter(
                      (v: any) => v.competency_document_id === d.id,
                    )"
                    class="version"
                  >
                    <span
                      >v{{ v.version_number }} · {{ date(v.uploaded_at)
                      }}<small>{{ v.original_filename }}</small></span
                    ><button @click="viewDoc(v.id)">Abrir</button>
                  </div>
                </details></template
              >
              <p v-else class="muted">
                Não exige documento e não bloqueia o fechamento.
              </p>
            </article>
          </div>
          <section v-if="tab === 'Conferência'" class="panel">
            <div class="panel-heading">
              <div>
                <h2>Conferência dos valores</h2>
                <button :disabled="busy" @click="compareMonths">
                  Comparar com mês anterior
                </button>
                <p class="muted">
                  Valores em R$. Vazio significa não identificado. Informe zero
                  apenas quando confirmado.
                </p>
              </div>
              <button
                class="primary"
                :disabled="busy || closed"
                @click="saveValues"
              >
                Salvar e conferir valores
              </button>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Campo</th>
                    <th>Extraído</th>
                    <th>Valor confirmado</th>
                    <th>Origem / evidência</th>
                    <th>Observação</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="key in fields" :key="key">
                    <td>
                      <b>{{ labels[key] }}</b
                      ><small>{{
                        manual(key, detail.competency.tax_regime)
                          ? "Preenchimento manual"
                          : "Leitura do documento / correção"
                      }}</small>
                    </td>
                    <td class="number">
                      {{
                        money(
                          detail.values.find((v: any) => v.field_key === key)
                            ?.extracted_value,
                        )
                      }}
                    </td>
                    <td>
                      <input
                        :aria-label="labels[key]"
                        v-model="draft[key]"
                        type="number"
                        step="0.01"
                        :disabled="
                          closed ||
                          (!detail.competency.ipi_applicable &&
                            groups.ipi.includes(key))
                        "
                        @input="dirty = true"
                        placeholder="Não identificado"
                      />
                    </td>
                    <td class="evidence">
                      <button
                        v-if="
                          fieldValue(key)?.source_document_version_id ||
                          fieldValue(key)?.suggested_document_version_id
                        "
                        class="text-button"
                        :disabled="busy"
                        @click="evidence(fieldValue(key))"
                      >
                        Ver página de origem
                      </button>
                      <div
                        v-if="fieldValue(key)?.has_suggestion"
                        class="suggestion"
                      >
                        <b>Valor anterior preservado</b
                        ><small
                          >Nova sugestão:
                          {{ money(fieldValue(key).extracted_value) }}</small
                        >
                        <button
                          :disabled="busy || dirty || closed"
                          @click="resolveSuggestion(fieldValue(key), 'keep')"
                        >
                          Manter atual
                        </button>
                        <button
                          :disabled="busy || dirty || closed"
                          @click="resolveSuggestion(fieldValue(key), 'accept')"
                        >
                          Aceitar sugestão
                        </button>
                      </div>
                      <small>{{
                        detail.values.find((v: any) => v.field_key === key)
                          ?.source_type
                      }}</small
                      >{{
                        detail.values.find((v: any) => v.field_key === key)
                          ?.evidence || "Sem extração automática"
                      }}<small
                        v-if="
                          detail.values.find((v: any) => v.field_key === key)
                            ?.confirmed_at
                        "
                        >Conferido em
                        {{
                          date(
                            detail.values.find((v: any) => v.field_key === key)
                              ?.confirmed_at,
                          )
                        }}</small
                      >
                    </td>
                    <td>
                      <input
                        v-model="notes[key]"
                        :aria-label="'Observação ' + labels[key]"
                        :disabled="closed"
                        @input="dirty = true"
                        placeholder="Justificativa opcional"
                      />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
          <section v-if="tab === 'Ficha Gestão'" class="panel padded">
            <h2>Uma ficha, todos os meses</h2>
            <p>
              O relatório consulta os valores confirmados de cada competência,
              incluindo os meses anteriores.
            </p>
            <button
              class="primary"
              @click="
                reportCompany = detail.competency.company_id;
                year = detail.competency.year;
                run(loadReport);
              "
            >
              Abrir ficha anual →
            </button>
          </section>
          <section v-if="tab === 'Histórico'" class="panel padded">
            <h2>Histórico auditável</h2>
            <p class="muted">
              Até 500 eventos mais recentes nesta tela. Histórico completo
              preservado no banco.
            </p>
            <div v-for="h in detail.history" class="history">
              <span class="timeline-dot"></span>
              <div>
                <b
                  >{{ h.actor || h.user_id }} ·
                  {{ h.action === "INSERT" ? "Inclusão" : "Alteração" }} ·
                  {{ h.entity_type }}</b
                ><small
                  >{{ date(h.created_at) }}
                  {{ h.reason ? "· " + h.reason : "" }}</small
                >
                <details>
                  <summary>Valores anteriores e novos</summary>
                  <pre>{{
                    JSON.stringify(
                      { anterior: h.old_value, novo: h.new_value },
                      null,
                      2,
                    )
                  }}</pre>
                </details>
              </div>
            </div>
          </section></template
        >
        <template v-if="page === 'jobs'">
          <div class="page-heading">
            <div>
              <span class="eyebrow">DOCUMENTOS</span>
              <h1>Leituras</h1>
              <p class="muted">
                Últimas 100 leituras. Acompanhe a fila e repita os arquivos que
                precisarem.
              </p>
            </div>
            <button @click="run(refreshJobs)">Atualizar</button>
          </div>
          <section class="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Empresa / competência</th>
                  <th>PDF</th>
                  <th>Andamento</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="j in jobs">
                  <td>
                    <b>{{ j.legal_name }}</b
                    ><small>{{ j.month }}/{{ j.year }}</small>
                  </td>
                  <td>
                    {{ human(j.document_type)
                    }}<small>{{ j.original_filename }}</small>
                  </td>
                  <td>
                    <b>{{ jobLabel(j.status) }}</b
                    ><small>{{ j.message }}</small
                    ><progress
                      v-if="j.status === 'running'"
                      aria-label="Leitura em andamento"
                    ></progress>
                  </td>
                  <td>
                    <button @click="run(() => open(j.competency_id))">
                      Abrir ficha</button
                    ><button
                      v-if="j.status === 'error'"
                      :disabled="busy"
                      @click="retryJob(j)"
                    >
                      Tentar novamente
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="!jobs.length" class="empty">
              Nenhuma leitura na fila. Envie PDFs pela ficha da empresa.
            </p>
          </section>
        </template>
        <template v-if="page === 'trash' && admin">
          <div class="page-heading">
            <div>
              <h1>Lixeira</h1>
              <p class="muted">
                Registros excluídos ficam fora dos relatórios. Restaure a
                empresa antes dos lançamentos.
              </p>
            </div>
            <button @click="run(loadTrash)">Atualizar</button>
          </div>
          <section class="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Empresa</th>
                  <th>Tipo</th>
                  <th>Motivo / data</th>
                  <th>Ação</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in trash.companies">
                  <td>
                    {{ c.legal_name }}<small>{{ c.cnpj }}</small>
                  </td>
                  <td>Empresa</td>
                  <td>
                    {{ c.delete_reason }}<small>{{ date(c.deleted_at) }}</small>
                  </td>
                  <td>
                    <button
                      :disabled="busy"
                      @click="restoreRecord('companies', c)"
                    >
                      Restaurar empresa
                    </button>
                  </td>
                </tr>
                <tr v-for="c in trash.competencies">
                  <td>{{ c.legal_name }}</td>
                  <td>Lançamento {{ c.month }}/{{ c.year }}</td>
                  <td>
                    {{ c.delete_reason }}<small>{{ date(c.deleted_at) }}</small>
                  </td>
                  <td>
                    <button
                      :disabled="busy || !!c.company_deleted"
                      @click="restoreRecord('competencies', c)"
                    >
                      Restaurar lançamento
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            <p
              v-if="!trash.companies.length && !trash.competencies.length"
              class="empty"
            >
              Lixeira vazia.
            </p>
          </section>
        </template>
        <template v-if="page === 'system' && admin">
          <div class="page-heading">
            <div>
              <h1>Diagnóstico</h1>
              <p class="muted">
                Verificação da instalação e das conexões do servidor.
              </p>
            </div>
            <button :disabled="busy" @click="run(loadDiagnostics)">
              Verificar novamente
            </button>
          </div>
          <section v-if="diagnostics" class="panel padded">
            <h2>Ambiente</h2>
            <p>
              Banco: <b>{{ diagnostics.database }}</b>
            </p>
            <p>
              Atualização 0.3:
              <b>{{
                diagnostics.migration
                  ? "Instalada"
                  : "Execute npm run db:migrate e reinicie"
              }}</b>
            </p>
            <p>
              Leitor: <b>{{ diagnostics.reader }}</b>
            </p>
            <p v-if="diagnostics.reader === 'openai'">
              Chave da API:
              {{ diagnostics.apiConfigured ? "Configurada" : "Ausente" }}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Ferramenta</th>
                  <th>Resultado</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="t in diagnostics.tools">
                  <td>{{ t.name }}</td>
                  <td :class="{ danger: !t.ok }">
                    {{ t.ok ? "OK" : "Falha" }} · {{ t.message }}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </template>
        <template v-if="page === 'reports'"
          ><div class="page-heading">
            <div>
              <span class="eyebrow">RELATÓRIOS · FICHA GESTÃO</span>
              <h1>O ano em perspectiva</h1>
              <p class="muted">
                Janeiro a dezembro, com os dados de cada competência.
              </p>
            </div>
            <button
              class="primary"
              :disabled="!annual || busy"
              @click="downloadPdf"
            >
              Baixar PDF</button
            ><button :disabled="!annual || busy" @click="exportReport">
              Baixar Excel
            </button>
            <label
              >Período do Excel<select v-model.number="exportMonth">
                <option :value="0">Ano completo</option>
                <option v-for="m in 12" :value="m">Mês {{ m }}</option>
              </select></label
            >
          </div>
          <div class="filters panel">
            <label class="grow"
              >Empresa<select v-model="reportCompany" @change="run(loadReport)">
                <option value="">Selecione uma empresa</option>
                <option v-for="c in companies" :value="c.id">
                  {{ c.internal_code }} · {{ c.legal_name }}
                </option>
              </select></label
            ><label
              >Ano<input
                type="number"
                min="2000"
                max="2200"
                v-model.number="year"
                @change="run(loadReport)"
            /></label>
          </div>
          <div class="alert">
            Modelo provisório: a aba GESTÃO não foi fornecida. Folga de caixa,
            DRE, percentuais e carga média aguardam análise das fórmulas
            originais.
          </div>
          <section v-if="annual" class="panel">
            <div class="panel-heading">
              <div>
                <h2>{{ annual.company.legal_name }}</h2>
                <p class="muted">
                  {{ annual.company.cnpj }} · {{ annual.year }} · Valores em R$
                </p>
              </div>
              <span class="badge">Prévia do relatório</span>
            </div>
            <div class="table-wrap">
              <table class="report-table">
                <thead>
                  <tr>
                    <th>Mês / situação</th>
                    <th>Vendas</th>
                    <th>Serviços</th>
                    <th>Total</th>
                    <th>Débitos</th>
                    <th>Compras</th>
                    <th>Despesas</th>
                    <th>Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in annualRows">
                    <td>
                      {{ String(r.month).padStart(2, "0")
                      }}<small>{{
                        !r.status
                          ? "Não iniciado"
                          : ["conferida", "fechada"].includes(r.status)
                            ? human(r.status)
                            : "PRELIMINAR"
                      }}</small>
                    </td>
                    <td>{{ money(r.values.vendas_mercadorias) }}</td>
                    <td>{{ money(r.values.vendas_servicos) }}</td>
                    <td>{{ money(r.calc.receita) }}</td>
                    <td>{{ money(r.calc.impostos) }}</td>
                    <td>{{ money(r.values.compras) }}</td>
                    <td>{{ money(r.values.despesas) }}</td>
                    <td>{{ money(r.calc.resultado) }}</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total informado*</td>
                    <td v-for="v in annualTotals">{{ money(v) }}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p class="footnote">
              * Somente competências existentes. Se um campo estiver ausente em
              algum desses meses, seu total fica não identificado. Meses não
              iniciados não são tratados como receita zero.
            </p>
            <div class="panel-heading">
              <h2>Tributos e créditos recuperáveis</h2>
            </div>
            <div class="table-wrap">
              <table class="report-table">
                <thead>
                  <tr>
                    <th>Mês</th>
                    <th
                      v-for="k in [
                        'icms',
                        'ipi',
                        'pis',
                        'cofins',
                        'iss',
                        'irpj',
                        'csll',
                        'cpp',
                      ]"
                    >
                      {{ k.toUpperCase() }}
                    </th>
                    <th>Créditos</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in annualRows">
                    <td>{{ String(r.month).padStart(2, "0") }}</td>
                    <td
                      v-for="k in [
                        'icms',
                        'ipi',
                        'pis',
                        'cofins',
                        'iss',
                        'irpj',
                        'csll',
                        'cpp',
                      ]"
                    >
                      {{ money(r.values[k]) }}
                    </td>
                    <td>{{ money(r.calc.creditos) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <footer class="report-footer">
              DOCUMENTO EMITIDO PELA FICHA GESTÃO
              <div>
                RESPONSÁVEL __________________ &nbsp; SUPERVISOR
                __________________ &nbsp; CLIENTE __________________
              </div>
            </footer>
          </section>
          <div v-else class="empty">
            <h3>Selecione uma empresa para consultar o ano.</h3>
          </div></template
        >
        <template v-if="page === 'users' && admin"
          ><div class="page-heading">
            <div>
              <span class="eyebrow">ADMINISTRAÇÃO</span>
              <h1>Equipe e acessos</h1>
            </div>
            <button
              class="primary"
              @click="
                newUser = {
                  email: '',
                  full_name: '',
                  password: '',
                  role: 'colaborador',
                }
              "
            >
              + Cadastrar usuário
            </button>
          </div>
          <div class="alert">
            Cadastre a equipe e controle permissões. Cada pessoa deve usar seu
            próprio acesso. O primeiro administrador é configurado conforme o
            README.
          </div>
          <section class="panel">
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Nome / e-mail</th>
                    <th>Perfil</th>
                    <th>Acesso</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="p in profiles">
                    <td>
                      <b>{{ p.full_name }}</b
                      ><small>{{ p.email }}</small>
                    </td>
                    <td>
                      <select v-model="p.role" :disabled="p.id === me.id">
                        <option
                          v-for="role in [
                            'administrador',
                            'supervisor',
                            'colaborador',
                          ]"
                        >
                          {{ role }}
                        </option>
                      </select>
                    </td>
                    <td>
                      <label class="check"
                        ><input
                          type="checkbox"
                          v-model="p.is_active"
                          :disabled="p.id === me.id"
                        />Ativo</label
                      >
                    </td>
                    <td>
                      <button
                        :disabled="busy || p.id === me.id"
                        @click="profileChange(p)"
                      >
                        Salvar acesso
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section></template
        >
        <aside v-if="preview" class="pdf-preview">
          <div class="panel-heading">
            <b>Documento · página {{ preview.page }}</b
            ><button @click="closePreview">Fechar ×</button>
          </div>
          <p class="muted">
            Compare os valores e navegue pelas páginas do PDF.
          </p>
          <iframe
            :src="preview.url + '#page=' + preview.page"
            title="Documento de origem"
          ></iframe>
          <a
            :href="preview.url + '#page=' + preview.page"
            target="_blank"
            rel="noopener"
            >Abrir documento em outra guia</a
          >
        </aside>
      </main>
      <footer class="app-footer">
        FICHA GESTÃO <span>v0.3</span>
      </footer>
    </div>
  </div>
  <div
    v-if="deletion"
    class="modal-backdrop"
    role="dialog"
    aria-modal="true"
    aria-label="Excluir registro"
  >
    <form class="modal small-modal" @submit.prevent="deleteRecord">
      <div class="panel-heading">
        <h2>
          {{
            deletion.type === "companies"
              ? "Excluir empresa"
              : "Excluir lançamento"
          }}
        </h2>
        <button type="button" :disabled="busy" @click="deletion = null">
          ×
        </button>
      </div>
      <p>
        <b>{{ deletion.label }}</b>
      </p>
      <p>
        {{
          deletion.type === "companies"
            ? "A empresa e seus lançamentos sairão das consultas e relatórios."
            : "Somente este lançamento por competência sairá das consultas e relatórios."
        }}
        A restauração fica disponível na lixeira para o administrador.
      </p>
      <p>Competências fechadas precisam ser reabertas antes da exclusão.</p>
      <label
        >Motivo<input
          v-model="deleteReason"
          required
          minlength="3"
          maxlength="1000"
      /></label>
      <label
        >Digite {{ deletion.token }} para confirmar<input
          v-model="deleteConfirm"
          required
          autocomplete="off"
      /></label>
      <p v-if="error" class="alert error">{{ error }}</p>
      <button
        class="danger"
        :disabled="busy || deleteConfirm !== deletion.token"
      >
        Excluir e mover para lixeira
      </button>
    </form>
  </div>
  <div
    v-if="comparison"
    class="modal-backdrop"
    role="dialog"
    aria-modal="true"
    aria-label="Comparação mensal"
  >
    <section class="modal">
      <div class="panel-heading">
        <h2>
          Comparação com
          {{ String(comparison.previousPeriod.month).padStart(2, "0") }}/{{
            comparison.previousPeriod.year
          }}
        </h2>
        <button @click="comparison = null">×</button>
      </div>
      <p v-if="!comparison.exists" class="alert">
        Mês anterior sem lançamento. Não há base para comparação.
      </p>
      <label
        >Destacar variação a partir de (%)<input
          type="number"
          min="0"
          v-model.number="comparisonThreshold"
      /></label>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Campo</th>
              <th>Anterior</th>
              <th>Atual</th>
              <th>Diferença</th>
              <th>Variação</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in comparison.rows"
              :class="{
                'variation-alert':
                  r.percent !== null &&
                  Math.abs(Number(r.percent)) >= comparisonThreshold,
              }"
            >
              <td>{{ r.label }}</td>
              <td>{{ money(r.previous) }}</td>
              <td>{{ money(r.current) }}</td>
              <td>{{ money(r.difference) }}</td>
              <td>{{ r.percent === null ? "Sem base" : r.percent + "%" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="muted">
        Comparação dos valores informados. A variação é um sinal para revisão;
        campos ausentes e base zero não geram percentual.
      </p>
    </section>
  </div>
  <div v-if="editor" class="modal-backdrop">
    <form class="modal" @submit.prevent="saveCompany">
      <div class="panel-heading">
        <h2>{{ editor.id ? "Editar empresa" : "Nova empresa" }}</h2>
        <button type="button" @click="editor = null" aria-label="Fechar">
          ×
        </button>
      </div>
      <div class="form-grid">
        <label
          >Código interno<input
            v-model="editor.internal_code"
            required /></label
        ><label
          >CNPJ<input
            v-model="editor.cnpj"
            required
            placeholder="Somente números" /></label
        ><label class="full"
          >Razão social<input v-model="editor.legal_name" required /></label
        ><label class="full"
          >Nome fantasia<input v-model="editor.trade_name" /></label
        ><label
          >Regime atual<select v-model="editor.default_tax_regime">
            <option v-for="s in regimes" :value="s">{{ human(s) }}</option>
          </select></label
        ><label
          >Responsável<select v-model="editor.responsible_user_id">
            <option :value="null">Não definido</option>
            <option
              v-for="p in profiles.filter((p) => p.is_active)"
              :value="p.id"
            >
              {{ p.full_name }}
            </option>
          </select></label
        ><label
          >Supervisor<select v-model="editor.supervisor_user_id">
            <option :value="null">Não definido</option>
            <option
              v-for="p in profiles.filter(
                (p) => p.is_active && p.role !== 'colaborador',
              )"
              :value="p.id"
            >
              {{ p.full_name }}
            </option>
          </select></label
        ><label
          >Carga de referência (%)<input
            type="number"
            step="0.0001"
            v-model="editor.tax_load_reference" /></label
        ><label
          >Margem de referência (%)<input
            type="number"
            step="0.0001"
            v-model="editor.margin_reference" /></label
        ><label class="check"
          ><input type="checkbox" v-model="editor.has_ipi" />Possui apuração de
          IPI</label
        ><label class="check"
          ><input type="checkbox" v-model="editor.is_active" />Empresa
          ativa</label
        >
      </div>
      <p class="muted">
        Alterações cadastrais não modificam as competências anteriores.
      </p>
      <p v-if="error" class="alert error">{{ error }}</p>
      <button class="primary" :disabled="busy">Salvar empresa</button>
    </form>
  </div>
  <div v-if="createMonth" class="modal-backdrop">
    <form class="modal small-modal" @submit.prevent="addMonth">
      <div class="panel-heading">
        <h2>Nova competência</h2>
        <button type="button" @click="createMonth = false">×</button>
      </div>
      <label
        >Empresa<select v-model="newCompany" required>
          <option value="">Selecione</option>
          <option
            v-for="c in companies.filter((c) => c.is_active)"
            :value="c.id"
          >
            {{ c.internal_code }} · {{ c.legal_name }}
          </option>
        </select></label
      >
      <div class="form-grid">
        <label
          >Mês<select v-model.number="month" required>
            <option v-for="n in 12" :value="n">{{ n }}</option>
          </select></label
        ><label
          >Ano<input
            type="number"
            v-model.number="year"
            min="2000"
            max="2200"
            required
        /></label>
      </div>
      <p class="muted">
        O mês começa sem valores financeiros. Regime, IPI e responsáveis são
        copiados do cadastro atual.
      </p>
      <p v-if="error" class="alert error">{{ error }}</p>
      <button class="primary" :disabled="busy || !month">
        Criar e abrir ficha
      </button>
    </form>
  </div>
  <div v-if="newUser" class="modal-backdrop">
    <form class="modal small-modal" @submit.prevent="saveUser">
      <div class="panel-heading">
        <h2>Novo usuário</h2>
        <button type="button" @click="newUser = null">×</button>
      </div>
      <label>Nome completo<input v-model="newUser.full_name" required /></label
      ><label
        >E-mail<input v-model="newUser.email" type="email" required /></label
      ><label
        >Senha inicial<input
          v-model="newUser.password"
          type="password"
          minlength="12"
          autocomplete="new-password"
          required /></label
      ><label
        >Perfil<select v-model="newUser.role">
          <option
            v-for="role in ['colaborador', 'supervisor', 'administrador']"
          >
            {{ role }}
          </option>
        </select></label
      >
      <p class="muted">
        Forneça a senha por canal seguro. O usuário pode trocá-la usando a
        recuperação de senha.
      </p>
      <p v-if="error" class="alert error">{{ error }}</p>
      <button class="primary" :disabled="busy">Cadastrar usuário</button>
    </form>
  </div>
</template>
