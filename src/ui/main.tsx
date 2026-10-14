import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/inter";
// Pages share class names across these sheets, so they load with the shell rather than with lazy route chunks
import "./styles.css";
import "./auth-loading.css";
import "./cloudflare-connection.css";
import "./cloudflare-deploy-button.css";
import "./documentation.css";
import "./homepage.css";
import "./model-connections.css";
import "./proposal-create.css";
import "./public-install.css";
import "./public-repository.css";
import "./repository-browser.css";
import "./repository-import.css";
import "./repository-skills.css";
import "./repository-work.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
