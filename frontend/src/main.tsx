import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles/base.css";
import "./styles/calculator.css";
import "./styles/history.css";
import "./styles/definitions.css";

createRoot(document.getElementById("root")!).render(<App />);
