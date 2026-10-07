import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadOfficialIdentity } from "./core/identity";
import "./styles.css";

window.addEventListener("error", (event) => {
  document.body.dataset.bootError = event.message || "renderer-error";
});

Promise.all([loadOfficialIdentity(), window.nodusDesktop?.getSupportProfile?.() ?? Promise.resolve(null)]).then(([identity, supportProfile]) => {
  if (supportProfile) identity = { ...identity, deviceName: identity.deviceNameConfirmed ? identity.deviceName : supportProfile.name, deviceNameConfirmed: true, supportProfileId: supportProfile.id };
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App initialIdentity={identity} supportProfile={supportProfile} />
    </StrictMode>,
  );
}).catch((error) => {
  document.body.dataset.bootError = error instanceof Error ? error.message : "identity-error";
});
