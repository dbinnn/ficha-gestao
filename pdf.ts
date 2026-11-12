import PDFDocument from "pdfkit";
import { money, report, sum } from "../shared/domain.js";
export function annualPdf(company: any, year: number, rows: any[]) {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: 30,
    info: { Title: `Ficha Gestão ${company.legal_name} ${year}` },
  });
  doc.font("assets/fonts/DejaVuSans.ttf");
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (x) => chunks.push(x));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const title = (text: string) => {
    doc.fillColor("#173e35").fontSize(20).text(text);
    doc
      .fontSize(10)
      .fillColor("#333")
      .text(`${company.legal_name} | CNPJ ${company.cnpj} | ${year}`);
    doc.moveDown();
  };
  title("Ficha Gestão • quadro anual");
  doc
    .fontSize(9)
    .text(
      "MODELO PROVISÓRIO — fidelidade à aba GESTÃO pendente de validação. Valores em R$.",
    );
  doc.text(
    "Competências não confirmadas são PRELIMINARES. Ausência de valor: —.",
  );
  doc.moveDown();
  const table = (headers: string[], data: string[][]) => {
    const width = 780 / headers.length;
    let y = doc.y;
    const row = (cells: string[], head = false) => {
      doc.fontSize(8);
      if (head) doc.rect(30, y, 780, 24).fill("#173e35");
      cells.forEach((v, i) => {
        doc.fontSize(8);
        let size = 8;
        while (doc.widthOfString(v) > width - 8 && size > 5) {
          size -= 0.5;
          doc.fontSize(size);
        }
        doc
          .fillColor(head ? "white" : "#202d29")
          .text(v, 34 + i * width, y + 7, {
            width: width - 8,
            align: i ? "right" : "left",
            lineBreak: false,
          });
      });
      y += 26;
      doc.strokeColor("#d7e1dc").moveTo(30, y).lineTo(810, y).stroke();
    };
    row(headers, true);
    data.forEach((r) => row(r));
    doc.x = 30;
    doc.y = y + 14;
  };
  const months = Array.from({ length: 12 }, (_, i) => {
    const r = rows.find((x) => x.month === i + 1);
    const v = r?.values || {};
    const a = report(v);
    return [
      String(i + 1).padStart(2, "0") +
        (r && !["conferida", "fechada"].includes(r.status) ? " *" : ""),
      money(v.vendas_mercadorias),
      money(v.vendas_servicos),
      money(a.receita),
      money(a.impostos),
      money(v.compras),
      money(v.despesas),
      money(a.resultado),
    ];
  });
  const totals = [
    "vendas_mercadorias",
    "vendas_servicos",
    "receita",
    "impostos",
    "compras",
    "despesas",
    "resultado",
  ].map((k) =>
    money(
      rows.length
        ? sum(
            rows.map((r) =>
              k in report(r.values)
                ? (report(r.values) as any)[k]
                : r.values[k],
            ),
          )
        : null,
    ),
  );
  months.push(["TOTAL*", ...totals]);
  table(
    [
      "Mês",
      "Vendas",
      "Serviços",
      "Receita",
      "Débitos",
      "Compras",
      "Despesas",
      "Resultado",
    ],
    months,
  );
  doc
    .fontSize(8)
    .text(
      "* Total das competências existentes; campo ausente em mês existente impede seu total.",
    );
  doc
    .fontSize(9)
    .text(
      "Folga de caixa, resultado final, percentuais e DRE: aguardam fórmulas da planilha GESTÃO.",
    );
  doc.addPage();
  title("Ficha Gestão • tributos e créditos");
  table(
    [
      "Mês",
      "ICMS",
      "IPI",
      "PIS",
      "COFINS",
      "ISS",
      "IRPJ + CSLL",
      "CPP",
      "Créditos",
    ],
    Array.from({ length: 12 }, (_, i) => {
      const r = rows.find((x) => x.month === i + 1),
        v = r?.values || {};
      return [
        String(i + 1).padStart(2, "0"),
        ...["icms", "ipi", "pis", "cofins", "iss"].map((k) => money(v[k])),
        v.irpj == null || v.csll == null ? "—" : money(sum([v.irpj, v.csll])),
        money(v.cpp),
        money(report(v).creditos),
      ];
    }),
  );
  doc
    .fontSize(9)
    .text(
      "Saldos negativos representam valores credores/recuperáveis. Débitos não representam imposto efetivamente a pagar.",
    );
  doc.moveDown();
  doc.text("DOCUMENTO EMITIDO PELA FICHA GESTÃO");
  doc.moveDown(2);
  doc.text(
    "RESPONSÁVEL: __________________     SUPERVISOR: __________________     CLIENTE: __________________",
  );
  doc.end();
  return done;
}
