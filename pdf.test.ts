import { test } from "node:test";
import assert from "node:assert/strict";
import { annualPdf } from "../server/pdf.js";
import { writeFile, mkdir } from "node:fs/promises";
import { fields } from "../shared/domain.js";
test("PDF anual gerado sem dependência de navegador", async () => {
  const rows = [
    {
      month: 8,
      status: "em_preenchimento",
      values: Object.fromEntries(
        fields.map((k) => [k, k === "icms" ? "-10000.00" : "123456.78"]),
      ),
    },
  ];
  const pdf = await annualPdf(
    {
      legal_name: "EMPRESA DE TESTE — SOMENTE VALIDAÇÃO TÉCNICA",
      cnpj: "00000000000000",
    },
    2026,
    rows,
  );
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 2000);
  await mkdir("tmp/pdfs", { recursive: true });
  await writeFile("tmp/pdfs/report-test.pdf", pdf);
});
