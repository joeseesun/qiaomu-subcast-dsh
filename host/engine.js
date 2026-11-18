import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export class Engine {
  constructor(directory, emit) {
    this.directory = directory;
    this.emit = emit;
    this.sequence = 0;
    this.pending = new Map();
  }

  start() {
    const name = process.platform + "-" + process.arch + (process.platform === "win32" ? ".exe" : "");
    const child = spawn(fileURLToPath(new URL("../bin/" + name, import.meta.url)), [this.directory], {
      stdio: ["pipe", "pipe", "inherit"], detached: process.platform !== "win32", windowsHide: true,
    });
    this.child = child;
    const close = (error) => {
      if (this.child !== child) return;
      this.child = null;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
    child.once("error", close);
    child.once("close", (code) => close(new Error("SubCast engine exited (" + code + ")")));
    child.stdin.on("error", close);
    createInterface({ input: child.stdout }).on("line", line => {
      let packet;
      try { packet = JSON.parse(line); } catch { return; }
      if (packet.event) return this.emit(packet.event, packet.payload);
      const request = this.pending.get(packet.id);
      if (!request) return;
      this.pending.delete(packet.id);
      if ("error" in packet) request.reject(new Error(packet.error));
      else request.resolve(packet.value);
    });
    return child;
  }

  call(method, args) {
    const child = this.child || this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      child.stdin.write(JSON.stringify({id, method, args}) + "\n");
    });
  }

  dispose() {
    const child = this.child;
    if (!child?.pid) return;
    if (process.platform === "win32") child.kill();
    else {
      try { process.kill(-child.pid, "SIGTERM"); } catch (err) { if (err.code !== "ESRCH") throw err; }
    }
  }
}
