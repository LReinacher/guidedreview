import { createRoot } from "react-dom/client";
import { App } from "./App";
import { parseAppHash } from "./routes";
import { SourceApp } from "./source/SourceView";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

// The source viewer is opened in its own tab and has no business booting the
// review session, its stream, or its persistence.
const isSourceTab = parseAppHash(window.location.hash).name === "source";
createRoot(root).render(isSourceTab ? <SourceApp /> : <App />);
