import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadOfficialIdentity } from "./core/identity";
import "./styles.css";

window.addEventListener("error", (event) => {
  document.body.dataset.bootError = event.message || "renderer-error";
});

loadOfficialIdentity().then((identity) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App initialIdentity={identity} />
    </StrictMode>,
  );
}).catch((error) => {
  document.body.dataset.bootError = error instanceof Error ? error.message : "identity-error";
});
