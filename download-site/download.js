const parts = [
  "https://nodus-connect-download-1.vercel.app/Nodus-Connect-Setup-0.4.18.part01.bin",
  "https://nodus-connect-download-2.vercel.app/Nodus-Connect-Setup-0.4.18.part02.bin",
  "https://nodus-connect-download-3.vercel.app/Nodus-Connect-Setup-0.4.18.part03.bin",
  "https://nodus-connect-download-4.vercel.app/Nodus-Connect-Setup-0.4.18.part04.bin",
  "https://nodus-connect-download-5.vercel.app/Nodus-Connect-Setup-0.4.18.part05.bin",
];

const link = document.querySelector("#download-link");
const title = document.querySelector("#download-title");
const detail = document.querySelector("#download-detail");

link.addEventListener("click", async (event) => {
  event.preventDefault();
  if (link.dataset.loading) return;

  link.dataset.loading = "true";
  title.textContent = "Preparando download";
  detail.textContent = "Baixando o instalador...";

  try {
    const chunks = [];
    for (const [index, url] of parts.entries()) {
      detail.textContent = `Baixando ${index + 1} de ${parts.length}...`;
      const response = await fetch(url);
      if (!response.ok) throw new Error("download indisponível");
      chunks.push(await response.arrayBuffer());
    }

    const blob = new Blob(chunks, { type: "application/octet-stream" });
    const downloadUrl = URL.createObjectURL(blob);
    const download = document.createElement("a");
    download.href = downloadUrl;
    download.download = "Nodus-Connect-Setup-0.4.18.exe";
    download.click();
    URL.revokeObjectURL(downloadUrl);
    title.textContent = "Download iniciado";
    detail.textContent = "Nodus Connect Setup 0.4.18";
  } catch {
    title.textContent = "Não foi possível baixar";
    detail.textContent = "Tente novamente em alguns instantes.";
  } finally {
    delete link.dataset.loading;
  }
});
