import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/inter";
// Pages share class names across these sheets, so they load with the shell; styles.css stays last so its rules win as before route splitting
import "./repository-browser.css";
import "./public-install.css";
import "./auth-loading.css";
import "./documentation.css";
import "./repository-skills.css";
import "./cloudflare-connection.css";
import "./repository-work.css";
import "./proposal-create.css";
import "./repository-import.css";
import "./model-connections.css";
import "./issues.css";
import "./releases.css";
import "./pull-requests.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
