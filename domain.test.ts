import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sum,
  report,
  pending,
  fields,
  groups,
  cnpjValid,
  manual,
} from "../shared/domain.js";
import { normalize } from "../server/extract.js";
const base = {
  cnpj: null,
  year: null,
  month: null,
  document_type: null,
  cfop_table_complete: false,
  cfops: [],
  fields: [],
  warnings: [],
};
test("Dinheiro exato e desconhecido diferente de zero", () => {
  assert.equal(sum(["0.10", "0.20"]), "0.30");
  assert.equal(sum(["10", null]), null);
  assert.equal(report({}).resultado, null);
});
test("Compras CFOP: referência do requisito e exclusão de devoluções", () => {
  const cfops = [
    "16317.13",
    "372345.26",
    "157091.01",
    "0",
    "11062.40",
    "13719.39",
  ].map((value, i) => ({
    cfop: ["1101", "1102", "1403", "2101", "2102", "2403"][i],
    value,
    evidence: "Valores contábeis",
  }));
  cfops.push({ cfop: "5202", value: "200000", evidence: "Devolução" });
  const r = normalize(
    { ...base, cfops, cfop_table_complete: true },
    "icms",
    "lucro_real",
  );
  assert.equal(r.fields.find((x) => x.key === "compras")?.value, "570535.19");
});
test("CFOP ausente só é zero se tabela comprovadamente completa", () => {
  assert.equal(
    normalize({ ...base }, "icms", "lucro_real").fields.find(
      (x) => x.key === "compras",
    )?.value,
    null,
  );
  assert.equal(
    normalize(
      { ...base, cfop_table_complete: true },
      "icms",
      "lucro_real",
    ).fields.find((x) => x.key === "compras")?.value,
    "0.00",
  );
});
test("CPP soma apenas empresa + terceiros; ausente bloqueia", () => {
  const r = {
    ...base,
    fields: [
      {
        key: "empresa_empregados_avulso",
        value: "9407.21",
        evidence: "DCTFWeb EMPRESA",
        page: 1,
      },
      {
        key: "terceiros",
        value: "2728.08",
        evidence: "DCTFWeb TERCEIROS",
        page: 1,
      },
      { key: "rat", value: "4000", evidence: "RAT", page: 1 },
    ],
  };
  assert.equal(normalize(r, "cpp", "lucro_real").fields[0].value, "12135.29");
  assert.equal(
    normalize({ ...r, fields: r.fields.slice(0, 1) }, "cpp", "lucro_real")
      .fields[0].value,
    null,
  );
});
test("IRPJ e CSLL do Real nunca são preenchidos por extração", () => {
  const r = {
    ...base,
    fields: [
      { key: "irpj", value: "9268.61", evidence: "IRPJ a recolher", page: 1 },
    ],
  };
  assert.ok(
    !normalize(r, "pis_cofins", "lucro_real").fields.some(
      (x) => x.key === "irpj",
    ),
  );
  assert.equal(
    normalize(r, "pis_cofins", "lucro_presumido").fields.find(
      (x) => x.key === "irpj",
    )?.value,
    "9268.61",
  );
  assert.ok(manual("irpj", "lucro_real"));
});
test("Saldos credores preservados e crédito negativo rejeitado", () => {
  const r = normalize(
    {
      ...base,
      fields: [
        { key: "icms", value: "-10000", evidence: "Saldo credor", page: 1 },
        { key: "credito_icms", value: "-5", evidence: "Crédito", page: 1 },
      ],
    },
    "icms",
    "lucro_real",
  );
  assert.equal(r.fields.find((x) => x.key === "icms")?.value, "-10000");
  assert.equal(r.fields.find((x) => x.key === "credito_icms")?.value, null);
});
test("IPI opcional não bloqueia; obrigatório e campos faltantes bloqueiam", () => {
  const vals = fields
    .filter((k) => !groups.ipi.includes(k))
    .map((field_key) => ({
      field_key,
      confirmed_value: "0",
      confirmed_at: "today",
    }));
  const docs = ["icms", "pis_cofins", "cpp"].map((document_type) => ({
    document_type,
    status: "conferido",
  }));
  assert.deepEqual(pending({ ipi_applicable: false }, docs, vals), []);
  assert.ok(
    pending({ ipi_applicable: true }, docs, vals).some((x) =>
      x.includes("ipi"),
    ),
  );
  assert.ok(pending({ ipi_applicable: false }, docs, vals.slice(1)).length);
});
test("CNPJ não aceita repetidos/inválidos", () => {
  assert.equal(cnpjValid("00000000000000"), false);
  assert.equal(cnpjValid("11222333000181"), true);
});
