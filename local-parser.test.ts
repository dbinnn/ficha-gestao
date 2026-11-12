import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLocal } from "../server/local-parser.js";
import { normalize } from "../server/extract.js";
const header = "CNPJ: 11222333000181\nPeriodo: 01/09/2026 a 30/09/2026\n";
const parse = (text: string, type: string, regime = "lucro_presumido") =>
  normalize(
    parseLocal([{ text: header + text, page: 2, ocr: false }], type),
    type,
    regime,
  );
const value = (r: ReturnType<typeof parse>, key: string) =>
  r.fields.find((f) => f.key === key)?.value;
test("CPP: lê primeira coluna, exclui RAT/segurados e não soma FGTS", () => {
  const r = parse(
    "Resumo Geral\nDCTFWeb          FGTS Digital\nEmpregados/Avulsos:   3.100,00\nEmpresa Empregados/Avulso:   8.200,00    FGTS Mensal:   3.050,00\nRAT Emp:   820,00\nTerceiros:   1.850,50\nINFORMAÇÕES AUXILIARES",
    "cpp",
  );
  assert.equal(value(r, "cpp"), "10050.50");
  assert.equal(r.month, 9);
  assert.equal(r.cnpj, "11222333000181");
});
test("CPP ausente, repetida ou arquivo diferente nunca vira zero", () => {
  for (const body of [
    "Resumo Geral\nDCTFWeb\nEmpresa Empregados/Avulso: 8.200,00",
    "Resumo da Folha\nINSS Folha 3.000,00",
    "Resumo Geral\nDCTFWeb\nEmpresa Empregados/Avulso: 8.200,00\nTerceiros: 1.850,50\nTerceiros: 1.850,50",
  ])
    assert.equal(value(parse(body, "cpp"), "cpp"), null);
});
test("Vendas vêm de Receitas IRPJ e não da base PIS; débito vazio não vira zero", () => {
  const r = parse(
    "Planilha de Lucro Presumido/Real\nReceitas - IRPJ\nVendas 500.000,00\nBases para Calculo - IRPJ\nIRPJ a Recolher 15.000,00\nReceitas - PIS\nVendas 480.000,00\nImposto Bruto - PIS\nSobre CST: 01 1,65% 2.900,00\nSobre CST: 02 0,65%\nSobre CST: 50 1,65% -2.100,00\nSub Total do Imposto Nao Cumulativo - PIS 800,00\nPIS Saldo Credor/Devedor 810,00",
    "pis_cofins",
  );
  assert.equal(value(r, "vendas_mercadorias"), "500000.00");
  assert.equal(value(r, "vendas_servicos"), null);
  assert.equal(value(r, "debito_pis"), null);
  assert.equal(value(r, "credito_pis"), "2100.00");
  assert.equal(value(r, "pis"), "810.00");
});
test("ICMS: crédito positivo, saldo credor negativo e CFOP ausente desconhecido", () => {
  const r = parse(
    "Registro de Apuração do ICMS\n1101 12.000,00 7.500,00\n004 - Total Débito do Imposto 50.000,00\n010 - Total Crédito do imposto -70.000,00\n012 - Total -20.000,00",
    "icms",
  );
  assert.equal(value(r, "credito_icms"), "70000.00");
  assert.equal(value(r, "icms"), "-20000.00");
  assert.equal(value(r, "compras"), null);
});
test("CNPJ ou competência conflitante permanece desconhecido", () => {
  const r = parse(
    "CNPJ: 12345678000195\nPeriodo: 01/10/2026\nResumo Geral\nDCTFWeb",
    "cpp",
  );
  assert.equal(r.cnpj, null);
  assert.equal(r.month, null);
});
test("IPI explícito e layouts desconhecidos: sem inferir apuração", () => {
  const r = parse(
    "Registro de Apuração do IPI\nTotal Débitos do Imposto 1.000,00\nTotal Créditos do Imposto 600,00\nIPI a recolher 400,00",
    "ipi",
  );
  assert.equal(value(r, "debito_ipi"), "1000.00");
  assert.equal(value(r, "credito_ipi"), "600.00");
  assert.equal(value(r, "ipi"), "400.00");
  const credor = parse(
    "Registro de Apuração do IPI\nIPI saldo credor 10,00",
    "ipi",
  );
  assert.equal(value(credor, "ipi"), "-10.00");
  assert.equal(
    value(parse("Documento desconhecido\nValor 800,00", "ipi"), "ipi"),
    null,
  );
});

