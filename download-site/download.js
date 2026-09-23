const setupUrl = "https://github.com/Kaueeteixeiraa/nodus-connect/releases/download/v0.4.19/Nodus-Connect-Setup.exe";

const link = document.querySelector("#download-link");
const title = document.querySelector("#download-title");
const detail = document.querySelector("#download-detail");

link.href = setupUrl;
link.addEventListener("click", () => {
  title.textContent = "Download iniciado";
  detail.textContent = "Nodus Connect Setup 0.4.19";
});
