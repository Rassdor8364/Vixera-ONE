import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./app/App.tsx";
import { loadConfig } from "./bootstrap/config.ts";
import { createShell } from "./bootstrap/runtime.ts";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root missing");
const root = createRoot(rootEl);

createShell(loadConfig())
  .then((shell) => {
    root.render(
      <StrictMode>
        <App shell={shell} />
      </StrictMode>,
    );
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    root.render(
      <div className="signin">
        <div className="signin__box">
          <div className="signin__brand">Vixera One</div>
          <p className="error">{message}</p>
          <p className="notice">Check .env (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY) or set VITE_VIXERA_DEV_FIXTURES=true.</p>
        </div>
      </div>,
    );
  });
