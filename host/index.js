import { homedir } from "node:os";
import { join } from "node:path";
import { createSurface } from "./surface.js";

import { createHostModel } from "./model.js";

// DSH Desktop forwards requests from its own Electron origin over loopback.
// The shell strips Origin after checking it. Keep a separate header value so
// requests missing Origin on the regular web path are still rejected.
const desktopOrigin = "dsh-app://app";

export const name = "qiaomu-subcast-dsh";
export const inject = ["webServer"];
export function apply(ctx, config = {}) {
  const directory = config.dataDir || join(process.env.DSH_HOME || join(homedir(), ".dsh"), "plugin-data", name);
  const surface = createSurface(directory, createHostModel(ctx));
  ctx.effect(() => () => surface.dispose());
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/qiaomu-subcast/connect",
    async handler(req, res) {
      const host = req.headers.host;
      const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
      const origin = req.headers.origin;
      const panel = req.headers["x-subcast-panel"];
      const webOrigin = "http://" + host;
      const parent = panel === "desktop" && origin === undefined
        ? desktopOrigin
        : panel === "1" && origin === webOrigin ? webOrigin : undefined;
      res.setHeader("cache-control", "no-store");
      if (!local || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ||
          !parent || req.method !== "POST" ||
          req.headers.forwarded || req.headers["x-forwarded-for"]) {
        res.writeHead(403); res.end("Open SubCast in the local DSH profile."); return;
      }
      try {
        const url = await surface.connect(parent);
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({url}));
      } catch (err) { res.writeHead(500); res.end(err.message); }
    },
  }));
}
