import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
let failed = false;
for (const name of ["pdfinfo", "pdftotext", "pdftoppm", "tesseract"]) {
  try {
    const path = process.env[name.toUpperCase() + "_PATH"] || name;
    await exec(path, [name === "tesseract" ? "--version" : "-v"], {
      timeout: 15000,
      windowsHide: true,
    });
    if (name === "tesseract") {
      const { stdout } = await exec(path, ["--list-langs"], {
        timeout: 15000,
        windowsHide: true,
      });
      if (!/^eng\s*$/m.test(stdout)) throw Error("idioma eng não instalado");
    }
    console.log("OK: " + name);
  } catch {
    failed = true;
    console.error(
      "FALHA: " +
        name +
        ". Confira instalação, idioma eng e " +
        name.toUpperCase() +
        "_PATH no .env.",
    );
  }
}
process.exitCode = failed ? 1 : 0;
