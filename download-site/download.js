const setupUrl = "https://github.com/Kaueeteixeiraa/nodus-connect/releases/download/v1.1.17/Nodus-Connect-Setup-1.1.17.exe?build=1.1.17-free-session-20261009";

const link = document.querySelector("#download-link");
const title = document.querySelector("#download-title");
const detail = document.querySelector("#download-detail");

link.href = setupUrl;
link.addEventListener("click", () => {
  title.textContent = "Download iniciado";
  detail.textContent = "Versão 1.1.17 - Arquivo único";
});
