import React from "react";
import ReactDOM from "react-dom/client";
import App, { isPublicRoute } from "./App";
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
import "./design-system.css";
import { initializeTheme } from "./ThemeToggle";
import { currentRoute } from "./router";

initializeTheme(isPublicRoute(currentRoute()));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
