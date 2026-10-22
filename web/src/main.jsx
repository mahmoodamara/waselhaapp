import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/noto-sans-arabic/wght.css";
import "@fontsource-variable/noto-sans-hebrew/wght.css";
import "./tokens.css";
import "./base.css";
import "./styles.css";
import App from "./App.jsx";
import { LanguageProvider } from "./components/UI.jsx";
createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </BrowserRouter>,
);
