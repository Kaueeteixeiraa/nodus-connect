const base = require("./package.json").build;
module.exports = {
  ...base,
  compression: "maximum",
  files: [...base.files, "!dist/desktop/assets/theme-*.png", "!dist/desktop/assets/nodus-nightscape-*.png", "!dist/desktop/assets/nodus-future-grid-*.png", "!dist/desktop/assets/Standby3D-*.js"],
  directories: { ...base.directories, output: "outputs/quick-support" },
  win: { ...base.win, target: [{ target: "portable", arch: ["x64"] }], artifactName: "Nodus-QuickSupport-${version}.${ext}" },
  portable: { requestExecutionLevel: "user" },
};
