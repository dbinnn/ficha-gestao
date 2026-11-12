import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./db.js";
const exec = promisify(execFile);
export type PdfPage = { text: string; page: number; ocr: boolean };
// No shell, private temporary directory, bounded pages/output/time, always cleaned.
export async function readLocalPdf(
  buffer: Buffer,
  forceOcr = false,
): Promise<PdfPage[]> {
  const dir = await mkdtemp(join(tmpdir(), "ficha-pdf-"));
  const pdf = join(dir, "document.pdf");
  const bin = (name: string) =>
    process.env[name.toUpperCase() + "_PATH"] || name;
  async function command(name: string, args: string[]) {
    try {
      return await exec(bin(name), args, {
        timeout: 90000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (error: any) {
      if (error.code === "ENOENT")
        throw new HttpError(
          503,
          `Leitura local: ${name} não encontrado. Consulte o README.md e configure ${name.toUpperCase()}_PATH no .env.`,
        );
      throw new HttpError(
        422,
        `Não foi possível ler o PDF com ${name}. Verifique se está protegido, danificado ou excede o tempo de leitura.`,
      );
    }
  }
  try {
    await writeFile(pdf, buffer);
    const info = await command("pdfinfo", [pdf]);
    const count = Number(info.stdout.match(/^Pages:\s*(\d+)/m)?.[1]);
    if (!count || count > 15)
      throw new HttpError(
        422,
        "Envie um PDF com até 15 páginas para leitura local.",
      );
    const pages: PdfPage[] = [];
    for (let page = 1; page <= count; page++) {
      const result = await command("pdftotext", [
        "-f",
        String(page),
        "-l",
        String(page),
        "-layout",
        pdf,
        "-",
      ]);
      let text = result.stdout;
      const ocr =
        forceOcr ||
        text.replace(/\s/g, "").length < 80 ||
        (text.match(/\d[.,]\d{2}\b/g)?.length ?? 0) < 3;
      if (ocr) {
        const prefix = join(dir, "page");
        await command("pdftoppm", [
          "-f",
          String(page),
          "-l",
          String(page),
          "-singlefile",
          "-scale-to",
          "2400",
          "-png",
          pdf,
          prefix,
        ]);
        await command("tesseract", [
          prefix + ".png",
          prefix,
          "-l",
          "eng",
          "--psm",
          "3",
        ]);
        text = await readFile(prefix + ".txt", "utf8");
      }
      pages.push({ text, page, ocr });
    }
    return pages;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
