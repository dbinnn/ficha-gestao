import { Decimal } from "decimal.js";
export function identityIssues(result: any, expected: any): string[] {
  const out: string[] = [];
  const got = result.cnpj?.replace(/\D/g, "");
  if (got !== expected.cnpj)
    out.push(
      `CNPJ: esperado ${expected.cnpj}; encontrado ${got || "não identificado"}.`,
    );
  if (result.year !== expected.year || result.month !== expected.month)
    out.push(
      `Competência: esperada ${String(expected.month).padStart(2, "0")}/${expected.year}; encontrada ${result.month && result.year ? String(result.month).padStart(2, "0") + "/" + result.year : "não identificada"}.`,
    );
  if (result.document_type !== expected.document_type)
    out.push(
      `Tipo: esperado ${expected.document_type}; encontrado ${result.document_type || "modelo não reconhecido"}.`,
    );
  return out;
}
export function preserveValue(
  field: any,
  snapshotUpdatedAt: string | undefined,
) {
  return (
    !!field.is_manual_override ||
    !!field.confirmed_at ||
    !snapshotUpdatedAt ||
    new Date(field.updated_at).toISOString() !==
      new Date(snapshotUpdatedAt).toISOString()
  );
}
export function variation(
  current: string | null | undefined,
  previous: string | null | undefined,
) {
  if (current == null || previous == null)
    return { difference: null, percent: null };
  const difference = new Decimal(current).minus(previous);
  return {
    difference: difference.toFixed(2),
    percent: new Decimal(previous).isZero()
      ? null
      : difference.div(new Decimal(previous).abs()).times(100).toFixed(2),
  };
}
