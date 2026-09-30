const setupUrl = "https://github.com/Kaueeteixeiraa/nodus-connect/releases/download/v0.0.1/Nodus-Connect-Setup-0.0.1.exe?build=20260930-session-review";

const link = document.querySelector("#download-link");
const title = document.querySelector("#download-title");
const detail = document.querySelector("#download-detail");

link.href = setupUrl;
link.addEventListener("click", () => {
  title.textContent = "Download iniciado";
  detail.textContent = "Versão 0.0.1 - Arquivo único";
});
