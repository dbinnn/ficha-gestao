import ExcelJS from "exceljs";
import { fields, labels, report, sum } from "../shared/domain.js";
function sheet(
  book: ExcelJS.Workbook,
  name: string,
  cols: { header: string; key: string; width?: number }[],
) {
  const ws = book.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  ws.columns = cols.map((c) => ({ ...c, width: c.width || 22 }));
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF214F40" },
  };
  ws.getRow(1).height = 28;
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: cols.length },
  };
  return ws;
}
export async function companiesXlsx(rows: any[]) {
  const b = new ExcelJS.Workbook();
  b.creator = "Ficha Gestão";
  const ws = sheet(b, "Empresas", [
    { header: "Código", key: "internal_code" },
    { header: "Razão social", key: "legal_name", width: 46 },
    { header: "Nome fantasia", key: "trade_name", width: 36 },
    { header: "CNPJ", key: "cnpj" },
    { header: "Regime", key: "default_tax_regime" },
    { header: "Responsável", key: "responsible_name", width: 32 },
    { header: "Supervisor", key: "supervisor_name", width: 32 },
    { header: "IPI", key: "ipi" },
    { header: "Situação", key: "active" },
  ]);
  for (const r of rows)
    ws.addRow({
      ...r,
      cnpj: String(r.cnpj),
      internal_code: String(r.internal_code),
      ipi: r.has_ipi ? "Sim" : "Não se aplica",
      active: r.is_active ? "Ativa" : "Inativa",
    });
  return Buffer.from(await b.xlsx.writeBuffer());
}
export async function annualXlsx(
  company: any,
  year: number,
  rows: any[],
  month = 0,
) {
  const b = new ExcelJS.Workbook();
  b.creator = "Ficha Gestão";
  const selected = month ? rows.filter((r) => r.month === month) : rows;
  const ws = sheet(b, "Ficha Gestão", [
    { header: "Empresa", key: "company", width: 40 },
    { header: "CNPJ", key: "cnpj" },
    { header: "Competência", key: "period" },
    { header: "Status", key: "status" },
    ...fields.map((k) => ({ header: labels[k], key: k })),
    { header: "Receita total", key: "receita" },
    { header: "Débitos totais", key: "impostos" },
    { header: "Resultado gerencial", key: "resultado" },
  ]);
  const num = (v: any) => (v == null ? null : Number(v));
  for (let m = 1; m <= 12; m++) {
    if (month && m !== month) continue;
    const row = selected.find((r) => r.month === m);
    const values = row?.values || {};
    const calc = report(values);
    const line: any = {
      company: company.legal_name,
      cnpj: company.cnpj,
      period: String(m).padStart(2, "0") + "/" + year,
      status: row?.status || "Não iniciado",
    };
    for (const key of fields) line[key] = num(values[key]);
    for (const key of ["receita", "impostos", "resultado"] as const)
      line[key] = num(calc[key]);
    ws.addRow(line);
  }
  const total: any = {
    company: "Total informado (campos ausentes deixam total vazio)",
  };
  for (const key of fields)
    total[key] = selected.length
      ? num(sum(selected.map((r) => r.values[key])))
      : null;
  for (const key of ["receita", "impostos", "resultado"] as const)
    total[key] = selected.length
      ? num(sum(selected.map((r) => report(r.values)[key])))
      : null;
  const t = ws.addRow(total);
  t.font = { bold: true };
  for (let i = 5; i <= ws.columnCount; i++)
    ws.getColumn(i).numFmt = "#,##0.00;[Red]-#,##0.00";
  const info = b.addWorksheet("Leia-me");
  info.getColumn(1).width = 110;
  info.addRows([
    [company.legal_name + " — " + year],
    [
      "Valores em reais. Vazio significa não identificado, não iniciado ou total incompleto.",
    ],
    [
      "Meses excluídos ficam fora desta exportação. Campos vazios não são convertidos em zero.",
    ],
    [
      "Status diferente de fechada indica informação preliminar. Confira os documentos.",
    ],
    [
      "Resultado gerencial segue a fórmula do aplicativo; não substitui demonstrações contábeis.",
    ],
  ]);
  return Buffer.from(await b.xlsx.writeBuffer());
}
