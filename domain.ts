import { Decimal } from "decimal.js";
export const fields = [
  "vendas_mercadorias",
  "vendas_servicos",
  "debito_icms",
  "debito_ipi",
  "debito_pis",
  "debito_cofins",
  "debito_iss",
  "compras",
  "despesas",
  "icms",
  "ipi",
  "pis",
  "cofins",
  "iss",
  "irpj",
  "csll",
  "cpp",
  "credito_icms",
  "credito_ipi",
  "credito_pis",
  "credito_cofins",
] as const;
export const labels: Record<string, string> = {
  vendas_mercadorias: "Vendas de mercadorias",
  vendas_servicos: "Receita de serviços",
  debito_icms: "Débito ICMS",
  debito_ipi: "Débito IPI",
  debito_pis: "Débito PIS",
  debito_cofins: "Débito COFINS",
  debito_iss: "Débito ISS",
  compras: "Compras",
  despesas: "Despesas",
  icms: "ICMS • saldo final",
  ipi: "IPI • saldo final",
  pis: "PIS • saldo final",
  cofins: "COFINS • saldo final",
  iss: "ISS a pagar",
  irpj: "IRPJ",
  csll: "CSLL",
  cpp: "CPP patronal",
  credito_icms: "Crédito ICMS",
  credito_ipi: "Crédito IPI",
  credito_pis: "Crédito PIS",
  credito_cofins: "Crédito COFINS",
};
export const purchases = ["1101", "1102", "1403", "2101", "2102", "2403"];
export const sales = ["5101", "5102", "5405", "6101", "6102", "6405"];
export const groups: Record<string, string[]> = {
  icms: ["compras", "debito_icms", "credito_icms", "icms"],
  ipi: ["debito_ipi", "credito_ipi", "ipi"],
  pis_cofins: [
    "vendas_mercadorias",
    "vendas_servicos",
    "debito_pis",
    "credito_pis",
    "pis",
    "debito_cofins",
    "credito_cofins",
    "cofins",
  ],
  cpp: ["cpp"],
};
export function sum(
  values: (string | number | null | undefined)[],
): string | null {
  if (values.some((v) => v == null || v === "")) return null;
  return values
    .reduce<Decimal>((a, v) => a.plus(v!), new Decimal(0))
    .toFixed(2);
}
export function report(v: Record<string, string | null>) {
  const receita = sum([v.vendas_mercadorias, v.vendas_servicos]);
  const impostos = sum(
    ["icms", "ipi", "pis", "cofins", "iss"].map((k) => v["debito_" + k]),
  );
  const creditos = sum(
    ["icms", "ipi", "pis", "cofins"].map((k) => v["credito_" + k]),
  );
  return {
    receita,
    impostos,
    creditos,
    resultado: [receita, impostos, v.compras, v.despesas].some((x) => x == null)
      ? null
      : new Decimal(receita!)
          .minus(impostos!)
          .minus(v.compras!)
          .minus(v.despesas!)
          .toFixed(2),
  };
}
export function money(v: unknown) {
  return v == null || v === ""
    ? "—"
    : new Decimal(String(v))
        .toFixed(2)
        .replace(".", ",")
        .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
export function manual(k: string, regime: string) {
  return (
    ["debito_iss", "iss", "despesas"].includes(k) ||
    (["irpj", "csll"].includes(k) && regime !== "lucro_presumido")
  );
}
export function cnpjValid(value: string) {
  if (!/^\d{14}$/.test(value) || /^(\d)\1+$/.test(value)) return false;
  const digit = (part: string) => {
    let w = part.length - 7;
    const s = [...part].reduce((a, c) => {
      const r = a + Number(c) * w--;
      if (w < 2) w = 9;
      return r;
    }, 0);
    return s % 11 < 2 ? 0 : 11 - (s % 11);
  };
  return (
    digit(value.slice(0, 12)) === +value[12] &&
    digit(value.slice(0, 13)) === +value[13]
  );
}
export function requiredTypes(ipi: boolean) {
  return ["icms", "pis_cofins", "cpp", ...(ipi ? ["ipi"] : [])];
}
export function pending(c: any, docs: any[], vals: any[]) {
  return [
    ...requiredTypes(c.ipi_applicable)
      .filter(
        (t) =>
          !docs.some((d) => d.document_type === t && d.status === "conferido"),
      )
      .map((t) => "Conferir documento " + t),
    ...fields
      .filter(
        (k) =>
          !(!c.ipi_applicable && groups.ipi.includes(k)) &&
          !vals.some(
            (v) =>
              v.field_key === k &&
              v.confirmed_value != null &&
              v.confirmed_at &&
              !v.has_suggestion,
          ),
      )
      .map((k) => "Conferir " + labels[k]),
  ];
}
