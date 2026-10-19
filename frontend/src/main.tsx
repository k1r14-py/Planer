import { createRoot } from "react-dom/client";
import App from "./App";
import { ProjectsProvider } from "./projects";
import "./styles.css";

// Без StrictMode: двойной запуск эффектов в dev дважды открывал бы микрофон
createRoot(document.getElementById("root")!).render(
  <ProjectsProvider>
    <App />
  </ProjectsProvider>,
);
