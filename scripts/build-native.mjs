import { copyFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const exe = windows ? ".exe" : "";
const rustupCargo = join(homedir(), ".cargo", "bin", "cargo" + exe);
const cargo = process.env.CARGO || (existsSync(rustupCargo) ? rustupCargo : "cargo");
const target = new URL("../native/target/", import.meta.url);
const build = spawnSync(cargo, ["build", "--release", "--locked", "--target-dir", fileURLToPath(target)], {
  cwd: new URL("../native/", import.meta.url), stdio: "inherit"
});
if (build.status !== 0) throw build.error || Error("SubCast engine build failed");
await mkdir("bin", {recursive:true});
await copyFile(new URL("release/subcast-engine" + exe, target), "bin/" + process.platform + "-" + process.arch + exe);
if (windows && process.env.SUBCAST_VCRT_DIR) {
  await mkdir("bin/vcrt", {recursive:true});
  for (const name of ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "vcomp140.dll"]) {
    await copyFile(join(process.env.SUBCAST_VCRT_DIR, name), join("bin", "vcrt", name));
  }
}
