import { installDemoApi } from "./api";

installDemoApi();

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "default-light" ? "default-light" : "default-dark";

document.documentElement.dataset.platform = "macos";
localStorage.setItem("cursor-byok.theme", theme);

void import("../index");
