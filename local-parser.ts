import { Decimal } from "decimal.js";
import type { Extraction } from "./extract.js";
import type { PdfPage } from "./local-pdf.js";
import { sum } from "../shared/domain.js";
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
const money = /(?<![\d.,])-?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}(?![\d%.,])/g;
const amounts = (s: string) =>
  [...s.matchAll(money)].map((m) => m[0].replace(/\./g, "").replace(",", "."));
export function parseLocal(pages: PdfPage[], requested: string): Extraction {
  let decimalFixes = 0;
  const lines = pages
    .flatMap((p) =>
      p.text.split(/\r?\n/).map((text) => {
        if (p.ocr)
          text = text.replace(
            /(?<![\d.,])(-?(?:\d{1,3}(?:\.\d{3})+|\d+))\.(\d{2})(?![\d.,%])/g,
            (_m, integer, decimal) => {
              decimalFixes++;
              return integer + "," + decimal;
            },
          );
        return { text: text.trim(), f: fold(text.trim()), page: p.page };
      }),
    )
    .filter((l) => l.text);
  const all = lines.map((l) => l.f).join("\n");
  const cn = [
    ...all.matchAll(
      /cnpj(?:\/cpf)?\s*:?\s*(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})/g,
    ),
  ].map((m) => m[1].replace(/\D/g, ""));
  const dates = [
    ...all.matchAll(
      /(?:apuracao|apuragao|periodo)[^\n]*?(\d{2})\/(\d{2})\/(\d{4})/g,
    ),
  ];
  const monthNames = [
    "janeiro",
    "fevereiro",
    "marco",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
  ];
  for (const m of all.matchAll(
    /\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\/(\d{4})\b/g,
  ))
    dates.push(["", "", "" + (monthNames.indexOf(m[1]) + 1), m[2]] as any);
  for (const m of all.matchAll(
    /(?:periodo|apuracao)[^\n]*?\b(0?[1-9]|1[012])\/(\d{4})\b/g,
  ))
    dates.push(["", "", "" + Number(m[1]), m[2]] as any);
  for (const l of lines.filter((l) => /periodo|apura.{1,3}o/.test(l.f)))
    for (const m of l.f.matchAll(/\b\d{2}\/(\d{2})\/(\d{4})\b/g))
      dates.push(["", "", "" + Number(m[1]), m[2]] as any);
  for (const m of all.matchAll(/\bpa:\s*(\d{2})\/(\d{4})\b/g))
    dates.push(["", "", "" + Number(m[1]), m[2]] as any);
  const periods = new Set(dates.map((m) => m[3] + "/" + Number(m[2])));
  const darf =
    /documento de arrecadacao/.test(all) &&
    /previdenciaria empresa|cp patronal/.test(all);
  const kind =
    /(?:registro|demonstrativo) de apura.{1,3}o (?:do |de )?icms/.test(all)
      ? "icms"
      : /(?:registro|demonstrativo) de apura.{1,3}o (?:do |de )?ipi/.test(all)
        ? "ipi"
        : /planilha de lucro presumido\s*\/\s*real|apuracao (?:de )?pis (?:e |\/)?cofins/.test(
              all,
            )
          ? "pis_cofins"
          : darf ||
              (/resumo (?:geral|da folha)/.test(all) && /dctfweb/.test(all))
            ? "cpp"
            : null;
  const result: Extraction = {
    cnpj: new Set(cn).size === 1 ? cn[0] : null,
    year: periods.size === 1 ? +dates[0][3] : null,
    month: periods.size === 1 ? +dates[0][2] : null,
    document_type: kind,
    cfop_table_complete: false,
    cfops: [],
    fields: [],
    warnings: [],
  };
  if (pages.some((p) => p.ocr))
    result.warnings.push(
      "PDF lido por OCR local. Confira cada valor e a página de origem antes de confirmar.",
    );
  if (decimalFixes)
    result.warnings.push(
      "OCR: separadores decimais com ponto foram normalizados para duas casas. Confira os valores na página original.",
    );
  if (kind !== requested) {
    result.warnings.push(
      "Modelo não reconhecido para este tipo. Nenhum valor foi inferido; confira manualmente.",
    );
    return result;
  }
  function put(key: string, matches: typeof lines, abs = false) {
    const valid = matches.length === 1 && amounts(matches[0].text).length === 1;
    const value = valid ? amounts(matches[0].text)[0] : null;
    result.fields.push({
      key,
      value:
        value !== null && abs ? new Decimal(value).abs().toFixed(2) : value,
      evidence: matches.map((l) => l.text).join(" | ") || "Não identificado",
      page: matches.length === 1 ? matches[0].page : null,
    });
  }
  if (kind === "cpp" && darf) {
    const revenueRows = lines
      .filter((l) => /^\d{4}\s/.test(l.f))
      .map((l) => ({
        ...l,
        code: l.f.slice(0, 4),
        value: amounts(l.text)[0] ?? null,
      }));
    const totalLines = lines.filter((l) => /^totais\s/.test(l.f));
    const total =
      totalLines.length === 1 ? amounts(totalLines[0].text)[0] : null;
    const valid =
      revenueRows.length > 0 &&
      revenueRows.every((l) => l.value !== null) &&
      new Set(revenueRows.map((l) => l.code)).size === revenueRows.length &&
      total &&
      sum(revenueRows.map((l) => l.value)) === new Decimal(total).toFixed(2);
    const employer = revenueRows.filter(
      (l) =>
        l.code === "1138" &&
        lines
          .slice(
            lines.indexOf(lines.find((x) => x.text === l.text)!),
            lines.indexOf(lines.find((x) => x.text === l.text)!) + 4,
          )
          .some((x) => /cp patronal.*empregad/.test(x.f)),
    );
    const third = revenueRows.filter((l) =>
      /contribui.{1,3}o.*terceir|cide.*terceir/.test(l.f),
    );
    result.fields.push({
      key: "empresa_empregados_avulso",
      value: valid && employer.length === 1 ? employer[0].value : null,
      evidence: employer.map((l) => l.text).join(" | ") || "Não identificado",
      page: employer[0]?.page ?? null,
    });
    result.fields.push({
      key: "terceiros",
      value: valid && third.length ? sum(third.map((l) => l.value)) : null,
      evidence: third.map((l) => l.text).join(" + ") || "Não identificado",
      page: third[0]?.page ?? null,
    });
    if (!valid)
      result.warnings.push(
        "A composição do DARF não foi validada contra o total impresso. Confira os componentes manualmente.",
      );
    result.warnings.push(
      "CPP considera a contribuição patronal de empregados/avulsos e terceiros. RAT e valores descontados dos segurados foram excluídos.",
    );
  }
  if (kind === "cpp" && !darf) {
    // Only the DCTFWeb block, excluding employee deduction, RAT and FGTS.
    const start = lines.findIndex((l) => /dctfweb/.test(l.f));
    const end = lines.findIndex(
      (l, i) => i > start && /informa.{1,4}es auxiliares/.test(l.f),
    );
    const block = lines.slice(start, end < 0 ? undefined : end);
    // Layout columns may put FGTS and DARF on the same row: retain first column.
    const col = block.map((l) => ({
      ...l,
      text: l.text
        .split(/\s*\|\s*/)[0]
        .split(/\s{3,}/)
        .slice(0, 2)
        .join(" "),
    }));
    put(
      "empresa_empregados_avulso",
      col.filter((l) => /^empresa empregados\/avulso\s*:/.test(l.f)),
    );
    put(
      "terceiros",
      col.filter((l) => /^terceiros\s*:/.test(l.f)),
    );
  }
  if (kind === "icms") {
    for (const l of lines) {
      const m = l.text.match(/^([123567]\.?\d{3})\s+(.+)$/);
      if (m) {
        const first = m[2].match(
          /^(-?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})(?:\s|$)/,
        );
        result.cfops.push({
          cfop: m[1].replace(".", ""),
          value: first ? first[1].replace(/\./g, "").replace(",", ".") : null,
          evidence: `Página ${l.page}: ${l.text}`,
        });
      }
    }
    // Missing codes are zero only when all accounting columns reconcile to both printed totals.
    const entry = lines.findIndex((l) => /^entradas\b/.test(l.f));
    const exit = lines.findIndex((l) => /^saidas\b/.test(l.f));
    const endTable = lines.findIndex(
      (l, i) => i > exit && /debito do imposto/.test(l.f),
    );
    const complete = (block: typeof lines) => {
      const totals = block.filter((l) => /^totais\s/.test(l.f));
      const cfops = block.filter((l) => /^[123567]\.?\d{3}\s/.test(l.text));
      const values = cfops.map((l) => {
        const m = l.text.match(/^[123567]\.?\d{3}\s+(-?[\d.]+,\d{2})(?:\s|$)/);
        return m ? m[1].replace(/\./g, "").replace(",", ".") : null;
      });
      return (
        totals.length === 1 &&
        values.length > 0 &&
        values.every((v) => v !== null) &&
        sum(values) === amounts(totals[0].text)[0]
      );
    };
    result.cfop_table_complete =
      entry >= 0 &&
      exit > entry &&
      endTable > exit &&
      complete(lines.slice(entry, exit)) &&
      complete(lines.slice(exit, endTable));
    put(
      "debito_icms",
      lines.filter((l) => /^004\s*[-–]/.test(l.f)),
    );
    put(
      "credito_icms",
      lines.filter((l) => /^010\s*[-–]/.test(l.f)),
      true,
    );
    const finals = lines.filter((l) => /^012\s*[-–]\s*total/.test(l.f));
    // Some print-to-PDF layouts position the final amount on the preceding line.
    const resolved = finals.map((l) => {
      if (amounts(l.text).length) return l;
      const prev = lines[lines.indexOf(l) - 1];
      return prev && /^-?[\d.,]+$/.test(prev.text) && prev.page === l.page
        ? { ...l, text: l.text + " " + prev.text }
        : l;
    });
    put("icms", resolved);
  }
  if (kind === "ipi") {
    put(
      "debito_ipi",
      lines.filter((l) =>
        /^(?:004\s*[-–]\s*)?total (?:de )?debitos?(?: do imposto)?\s/.test(l.f),
      ),
    );
    put(
      "credito_ipi",
      lines.filter((l) =>
        /^(?:010\s*[-–]\s*)?total (?:de )?creditos?(?: do imposto)?\s/.test(
          l.f,
        ),
      ),
      true,
    );
    const payable = lines.filter((l) =>
      /^(?:ipi |imposto )?(?:a recolher|a pagar|saldo devedor)\s/.test(l.f),
    );
    const credit = lines.filter((l) =>
      /^(?:ipi )?saldo credor(?: para o periodo seguinte)?\s/.test(l.f),
    );
    if (payable.length === 1 && credit.length === 0) put("ipi", payable);
    else if (credit.length === 1 && payable.length === 0) {
      put("ipi", credit);
      const f = result.fields.find((f) => f.key === "ipi")!;
      if (f.value !== null)
        f.value = new Decimal(f.value).abs().negated().toFixed(2);
    }
    result.warnings.push(
      "IPI: leitor por rótulos explícitos. Modelo sem correspondência permanece para preenchimento manual.",
    );
  }
  if (kind === "pis_cofins") {
    const revenueStart = lines.findIndex((l) =>
      /^receitas\s*[-–]\s*(?:irpj|imposto de renda)/.test(l.f),
    );
    const revenueEnd = lines.findIndex(
      (l, i) => i > revenueStart && /^bases para/.test(l.f),
    );
    const revenue =
      revenueStart >= 0 && revenueEnd > revenueStart
        ? lines.slice(revenueStart + 1, revenueEnd)
        : [];
    put(
      "vendas_mercadorias",
      revenue.filter((l) => /^vendas\s/.test(l.f)),
    );
    put(
      "vendas_servicos",
      revenue.filter((l) => /^(?:servicos|prestacao de servicos)\s/.test(l.f)),
    );
    put(
      "irpj",
      lines.filter((l) => /^irpj a recolher\s/.test(l.f)),
    );
    put(
      "csll",
      lines.filter((l) =>
        /^(?:contribui.{1,3}o social|csll) a recolher\s/.test(l.f),
      ),
    );
    for (const tax of ["pis", "cofins"]) {
      put(
        tax,
        lines.filter((l) =>
          new RegExp(`^${tax} saldo credor/devedor\\s`).test(l.f),
        ),
      );
      const starts = lines
        .map((l, i) =>
          new RegExp(`^imposto bruto\\s*-\\s*${tax}$`).test(l.f) ? i : -1,
        )
        .filter((i) => i >= 0);
      const start = starts.length === 1 ? starts[0] : -1;
      const end = lines.findIndex(
        (l, i) => i > start && /^sub total do imposto/.test(l.f),
      );
      const rows =
        start >= 0 && end > start
          ? lines.slice(start + 1, end).filter((l) => /^sobre cst:/.test(l.f))
          : [];
      for (const side of ["debito", "credito"]) {
        const selected = rows.filter((l) => {
          const code = Number(l.f.match(/cst:\s*(\d+)/)?.[1]);
          return side === "debito"
            ? code >= 1 && code < 50
            : code >= 50 && code <= 66;
        });
        const vals = selected.map((l) =>
          amounts(l.text).length === 1
            ? new Decimal(amounts(l.text)[0]).abs().toFixed(2)
            : null,
        );
        result.fields.push({
          key: side + "_" + tax,
          value: selected.length ? sum(vals) : null,
          evidence:
            selected.map((l) => `Página ${l.page}: ${l.text}`).join(" | ") ||
            "Não identificado",
          page: selected[0]?.page ?? null,
        });
        if (vals.includes(null))
          result.warnings.push(
            `${side} ${tax.toUpperCase()}: há linha CST sem valor legível. Não foi considerada zero; informe o total após conferir.`,
          );
      }
    }
    result.warnings.push(
      "Saldos finais são os impressos no documento; não foram recalculados a partir dos subtotais.",
    );
  }
  return result;
}
