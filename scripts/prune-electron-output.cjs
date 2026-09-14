const fs = require("node:fs");
const path = require("node:path");

module.exports = async function pruneElectronOutput(context) {
  const localesDir = path.join(context.appOutDir, "locales");
  const keep = new Set(["en-US.pak", "pt-BR.pak", "pt-PT.pak"]);
  if (!fs.existsSync(localesDir)) return;
  for (const entry of fs.readdirSync(localesDir)) {
    if (entry.endsWith(".pak") && !keep.has(entry)) fs.rmSync(path.join(localesDir, entry), { force: true });
  }
};
