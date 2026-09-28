const setupUrl = "https://github.com/Kaueeteixeiraa/nodus-connect/releases/download/v0.4.25-recovery.1-cursor/Nodus-Connect-Setup-0.4.25-recovery.1-cursor.exe";

const link = document.querySelector("#download-link");
const title = document.querySelector("#download-title");
const detail = document.querySelector("#download-detail");

link.href = setupUrl;
link.addEventListener("click", () => {
  title.textContent = "Download iniciado";
  detail.textContent = "0.4.25-recovery.1 - teste do cursor";
});
