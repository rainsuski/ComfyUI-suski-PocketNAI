import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

createApp(App).mount("#app");

if ("serviceWorker" in navigator && import.meta.env.PROD && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/pocket/sw.js", { scope: "/pocket/" }).catch((error) => {
      console.warn("[PocketNAI] Service worker registration failed", error);
    });
  });
}
