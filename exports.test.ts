import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { companiesXlsx, annualXlsx } from "../server/exports.js";
import {
  identityIssues,
  preserveValue,
  variation,
} from "../shared/workflow.js";
test("Excel: CNPJ/código continuam texto e conteúdo começando por = não vira fórmula", async () => {
  const b = new ExcelJS.Workbook();
  await b.xlsx.load(
    await companiesXlsx([
      {
        internal_code: "0008",
        legal_name: '=HYPERLINK("x")',
        cnpj: "01234567000189",
        is_active: false,
        has_ipi: false,
      },
    ]),
  );
  const s = b.worksheets[0];
  assert.equal(s.getCell("A2").value, "0008");
  assert.equal(s.getCell("B2").value, '=HYPERLINK("x")');
  assert.equal(s.getCell("D2").value, "01234567000189");
  assert.ok(s.autoFilter);
  assert.equal(s.views[0].state, "frozen");
});
test("Excel anual/mensal: campo ausente e mês sem lançamento não viram zero", async () => {
  const company = { legal_name: "Teste", cnpj: "11222333000181" };
  const rows = [
    {
      month: 9,
      status: "aguardando_conferencia",
      values: {
        vendas_mercadorias: "10000",
        vendas_servicos: "0",
        compras: "6000",
      },
    },
    {
      month: 10,
      status: "em_preenchimento",
      values: { vendas_mercadorias: "12000" },
    },
  ];
  const b = new ExcelJS.Workbook();
  await b.xlsx.load(await annualXlsx(company, 2026, rows));
  const ws = b.worksheets[0];
  assert.equal(ws.getCell("D2").value, "Não iniciado");
  assert.equal(ws.getCell("E2").value, null);
  assert.equal(ws.getCell("E10").value, 10000);
  // First two value fields are goods and services; incomplete services total stays empty.
  assert.equal(ws.getCell("E14").value, 22000);
  assert.equal(ws.getCell("F14").value, null);
  const monthly = new ExcelJS.Workbook();
  await monthly.xlsx.load(await annualXlsx(company, 2026, rows, 9));
  assert.equal(monthly.worksheets[0].rowCount, 3);
  assert.equal(monthly.worksheets[0].getCell("E2").value, 10000);
});
test("Comparação e proteção de edições: ausência, zero e mudanças durante leitura", () => {
  assert.equal(variation("50", "0").percent, null);
  assert.equal(variation(null, "10").difference, null);
  assert.deepEqual(variation("150", "100"), {
    difference: "50.00",
    percent: "50.00",
  });
  assert.equal(
    preserveValue(
      {
        confirmed_at: null,
        is_manual_override: false,
        updated_at: "2026-09-01T00:00:00Z",
      },
      "2026-09-01T00:00:00.000Z",
    ),
    false,
  );
  assert.equal(
    preserveValue(
      {
        confirmed_at: null,
        is_manual_override: false,
        updated_at: "2026-09-02",
      },
      "2026-09-01",
    ),
    true,
  );
  assert.equal(
    identityIssues(
      { cnpj: "11222333000181", year: 2026, month: 8, document_type: "icms" },
      { cnpj: "11222333000181", year: 2026, month: 9, document_type: "icms" },
    ).length,
    1,
  );
});
