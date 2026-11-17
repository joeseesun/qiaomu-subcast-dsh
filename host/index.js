import { homedir } from "node:os";
import { join } from "node:path";
import { createSurface } from "./surface.js";

import { createHostModel } from "./model.js";

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
      res.setHeader("cache-control", "no-store");
      if (!local || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ||
          origin !== "http://" + host || req.method !== "POST" || req.headers["x-subcast-panel"] !== "1" ||
          req.headers.forwarded || req.headers["x-forwarded-for"]) {
        res.writeHead(403); res.end("Open SubCast in the local DSH profile."); return;
      }
      try {
        const url = await surface.connect(origin);
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({url}));
      } catch (err) { res.writeHead(500); res.end(err.message); }
    },
  }));
}
