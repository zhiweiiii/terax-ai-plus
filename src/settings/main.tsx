import "../styles/globals.css";

import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { ThemeProvider } from "@/modules/theme";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import { SettingsApp } from "./SettingsApp";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

ReactDOM.createRoot(
  document.getElementById("settings-root") as HTMLElement,
).render(
  <ThemeProvider>
    <SettingsApp />
  </ThemeProvider>,
);

// Show as soon as the first paint is on screen. This used to be a 50 ms timer
// with a 500 ms one behind it as a backstop, which added a fixed wait to a
// window that was already slow to build. A double rAF fires after the browser
// has committed the frame React just produced, so the window appears with
// content rather than as an empty transparent rectangle.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    getCurrentWindow()
      .show()
      .catch((e) => console.error("settings show failed:", e));
  });
});
