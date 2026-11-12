import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function diagnosePdf() {
  return Promise.all(
    ["pdfinfo", "pdftotext", "pdftoppm", "tesseract"].map(async (name) => {
      try {
        const cmd = process.env[name.toUpperCase() + "_PATH"] || name;
        await exec(cmd, [name === "tesseract" ? "--version" : "-v"], {
          timeout: 10000,
          windowsHide: true,
        });
        if (name === "tesseract") {
          const { stdout } = await exec(cmd, ["--list-langs"], {
            timeout: 10000,
            windowsHide: true,
          });
          if (!/^eng\s*$/m.test(stdout))
            return {
              name,
              ok: false,
              message: "Instale o idioma eng no Tesseract.",
            };
        }
        return { name, ok: true, message: "Disponível" };
      } catch {
        return {
          name,
          ok: false,
          message: `Confira instalação e ${name.toUpperCase()}_PATH no .env.`,
        };
      }
    }),
  );
}
