import { render } from "preact";
import { frameBust } from "./security";
import { App } from "./ui/App";
import { registerServiceWorker } from "./ui/pwa";

if (!frameBust()) {
  const root = document.getElementById("app");
  // A room link (#join=… or #watch=…) opens the friend's page, loaded on demand.
  const joining =
    document.documentElement.dataset.mode === "live" && /^#(join|watch)=/.test(location.hash);
  if (root && joining) void import("./ui/JoinApp").then((m) => render(<m.JoinApp />, root));
  else if (root) render(<App />, root);
  registerServiceWorker();
}
