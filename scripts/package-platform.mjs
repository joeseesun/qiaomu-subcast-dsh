import { execFileSync } from "node:child_process";
import { mkdir, rename } from "node:fs/promises";
import { resolve, join } from "node:path";

const destination = resolve(process.argv[2] || "artifacts");
await mkdir(destination, {recursive:true});
// Invoke the npm script directly on Windows as well as on Unix.
const result = execFileSync(process.execPath, [
  process.env.npm_execpath, "pack", "--ignore-scripts", "--json", "--pack-destination", destination,
], {encoding:"utf8"});
const [{filename, name, version}] = JSON.parse(result);
const archive = join(destination, `${name}-${version}-${process.platform}-${process.arch}.tgz`);
await rename(join(destination, filename), archive);
console.log(archive);
