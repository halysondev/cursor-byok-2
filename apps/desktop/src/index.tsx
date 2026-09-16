import ReactDOM from "react-dom/client";
import "../node_modules/monaco-editor/min/vs/editor/editor.main.css";
import { App } from "./App";
import { appStore } from "./shared/store/appStore";
import { applyTheme } from "./shared/theme/theme";
import "./styles/globals.scss";

applyTheme(appStore.getSnapshot().theme);
void appStore.refresh();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <App />,
);
