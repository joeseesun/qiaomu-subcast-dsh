import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Engine } from "./engine.js";

const assets = fileURLToPath(new URL("../dist/", import.meta.url));
const types = { ".html":"text/html; charset=utf-8", ".js":"text/javascript", ".css":"text/css", ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg", ".mp3":"audio/mpeg", ".m4a":"audio/mp4", ".mp4":"video/mp4", ".aac":"audio/aac", ".ogg":"audio/ogg", ".wav":"audio/wav", ".flac":"audio/flac" };

function json(res, status, body) {
  res.writeHead(status, {"content-type":"application/json", "cache-control":"no-store"});
  res.end(JSON.stringify(body));
}

async function sendFile(req, res, file) {
  const stat = await lstat(file);
  if (!stat.isFile()) return json(res, 404, {error:"Missing file"});
  let start = 0, end = stat.size - 1;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
    }
    if (!match || (!match[1] && !match[2]) || start > end || start >= stat.size) {
      res.writeHead(416, {"content-range":"bytes */" + stat.size}); return res.end();
    }
    res.statusCode = 206;
    res.setHeader("content-range", `bytes ${start}-${end}/${stat.size}`);
  }
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("content-length", end - start + 1);
  res.setHeader("content-type", types[extname(file)] || "application/octet-stream");
  if (req.method === "HEAD" || stat.size === 0) return res.end();
  await pipeline(createReadStream(file, {start, end}), res);
}

export function createSurface(directory, hostModel) {
  const key = randomBytes(32).toString("hex");
  const clients = new Set();
  const emit = (event, payload) => {
    for (const res of clients) res.write("event: " + event + "\ndata: " + JSON.stringify(payload) + "\n\n");
  };
  const engine = new Engine(directory, emit);
  let origin, parent, opening, disposed = false;
  const server = createServer((req, res) => {
    handle(req, res).catch(err => {
      if (!res.headersSent && !res.destroyed) json(res, err.code === "ENOENT" ? 404 : 400, {error:err.message});
    });
  });
  async function handle(req, res) {
    if (req.headers.host !== new URL(origin).host) return json(res, 403, {error:"Invalid host"});
    const url = new URL(req.url, origin);
    res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "frame-ancestors " + parent + "; object-src 'none'; base-uri 'none'; script-src 'self' https://www.youtube.com https://s.ytimg.com; worker-src 'self' blob:");
    if (url.pathname === "/rpc") {
      if (req.method !== "POST" || req.headers.origin !== origin || req.headers.authorization !== "Bearer " + key)
        return json(res, 403, {error:"Invalid session"});
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) return json(res, 413, {error:"Request too large"});
        chunks.push(chunk);
      }
      const {method, args} = JSON.parse(Buffer.concat(chunks).toString());
      if (method === "dsh_model") return json(res, 200, {value:hostModel?.selection() ?? null});
      if (method === "llm_chat" && args?.provider?.protocol === "dsh") {
        if (!hostModel) throw Error("DSH model service is unavailable");
        return json(res, 200, {value:await hostModel.chat(args, emit)});
      }
      if (method === "cancel_job") hostModel?.cancel(args.id);
      return json(res, 200, {value:await engine.call(method, args)});
    }
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, {error:"Method not allowed"});
    if (url.pathname === "/events" || url.pathname.startsWith("/media/")) {
      if (url.searchParams.get("key") !== key) return json(res, 403, {error:"Invalid session"});
      res.setHeader("cache-control", "no-store");
      if (url.pathname === "/events") {
        res.writeHead(200, {"content-type":"text/event-stream"});
        res.write(": connected\n\n");
        clients.add(res);
        res.on("close", () => clients.delete(res));
        return;
      }
      const name = decodeURIComponent(url.pathname.slice(7));
      if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]{2,4}$/.test(name) || name.endsWith(".part")) return json(res, 404, {error:"Invalid media"});
      return sendFile(req, res, join(directory, "downloads", name));
    }
    if (url.pathname === "/") return sendFile(req, res, join(assets, "index.html"));
    if (/^\/assets\/[a-zA-Z0-9_.-]+$/.test(url.pathname)) return sendFile(req, res, join(assets, "assets", basename(url.pathname)));
    json(res, 404, {error:"Missing asset"});
  }
  function bind(port) {
    return new Promise((resolve, reject) => {
      const fail = err => { server.removeListener("listening", ready); reject(err); };
      const ready = () => { server.removeListener("error", fail); resolve(); };
      server.once("error", fail).once("listening", ready).listen(port, "127.0.0.1");
    });
  }
  async function open(parentOrigin) {
    parent = parentOrigin;
    await mkdir(directory, {recursive:true, mode:0o700});
    const portFile = join(directory, "panel-port");
    const preferred = Number(await readFile(portFile, "utf8").catch(() => 0));
    if (disposed) throw Error("Plugin disabled");
    await engine.call("list_shows", {});
    if (disposed) throw Error("Plugin disabled");
    try { await bind(preferred); } catch (err) { if (err.code !== "EADDRINUSE") throw err; await bind(0); }
    if (disposed) { server.close(); throw Error("Plugin disabled"); }
    const port = server.address().port;
    origin = "http://127.0.0.1:" + port;
    await writeFile(portFile, String(port));
    return origin + "/#" + key;
  }
  return {
    connect(parentOrigin) {
      return opening ??= open(parentOrigin).catch(err => { opening = undefined; throw err; });
    },
    dispose() {
      disposed = true;
      for (const res of clients) res.end();
      server.close();
      server.closeAllConnections();
      engine.dispose();
    },
  };
}
