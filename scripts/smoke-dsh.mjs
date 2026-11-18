import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const tools = resolve(process.argv[2]);
const packageDir = resolve(process.argv[3]);
const requireTool = createRequire(join(tools, "package.json"));
const { chromium, errors } = requireTool("playwright");
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const archive = join(packageDir, `${manifest.name}-${manifest.version}-${process.platform}-${process.arch}.tgz`);
const dsh = join(tools, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const profile = "subcast-smoke";
const directory = await mkdtemp(join(tmpdir(), "subcast-dsh-smoke-"));
const env = {
  ...process.env,
  DSH_HOME: directory,
  PATH: join(tools, "node_modules", ".bin") + delimiter + process.env.PATH,
};
const cli = (...args) => execFileSync(process.execPath, [dsh, ...args], {
  env, encoding: "utf8", timeout: 180_000, windowsHide: true,
});

function wavFixture() {
  const rate = 16_000;
  const length = rate * 6 * 2;
  const wav = Buffer.alloc(44 + length);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(length, 40);
  return wav;
}

const wave = wavFixture();
const title = "SubCast release playback fixture";
const fixture = createServer((req, res) => {
  const source = `http://127.0.0.1:${fixture.address().port}`;
  const routes = {
    "/feed.xml": ["application/rss+xml", Buffer.from(
      `<rss version="2.0"><channel><title>${title}</title><description>Release QA</description>` +
      '<item><guid>qa-playback</guid><title>Offline playback test</title>' +
      `<enclosure url="${source}/audio.wav" length="${wave.length}" type="audio/wav"/></item></channel></rss>`,
    )],
    "/audio.wav": ["audio/wav", wave],
  };
  if (!Object.hasOwn(routes, req.url)) return res.writeHead(404).end();
  const [type, body] = routes[req.url];
  res.writeHead(200, { "Content-Type": type, "Content-Length": body.length }).end(body);
});

let host, hostLog = "", browser;
try {
  const hostVersion = cli("--version").trim();
  assert.ok(manifest.engines.dsh.split(" || ").includes(hostVersion), hostVersion);
  cli("--profile", profile, "--from-default-profile", "web", "--dump-config");
  cli("plugin", "--profile", profile, "add", archive);
  assert.match(cli("--profile", profile, "--dump-config"), /# == qiaomu-subcast-dsh/);
  const profileDir = join(directory, "profiles", profile);
  // Exercise playback in the disposable profile without a real model account.
  await writeFile(join(profileDir, "cordis.patch.yml"),
    "- id: ui-settings-models\n  config:\n    credentialOnboarding: false\n");
  const installed = join(profileDir, "node_modules", manifest.name);
  const actual = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(actual.version, manifest.version);
  const binary = `${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
  assert.ok((await readFile(join(installed, "bin", binary))).length > 0);
  if (process.platform === "win32") {
    for (const library of ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "vcomp140.dll"]) {
      assert.ok((await readFile(join(installed, "bin", "vcrt", library))).length > 0);
    }
  }
  // Reserve a loopback port, then release it for the real DSH process.
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((complete) => reservation.close(complete));
  host = spawn(process.execPath, [dsh, "--profile", profile, "--port", String(port), "--no-open"], {
    env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  for (const stream of [host.stdout, host.stderr]) stream.on("data", (data) => { hostLog += data; });
  let launch;
  for (let tries = 0; tries < 120 && !launch; tries++) {
    assert.equal(host.exitCode, null, "DSH exited at startup");
    launch = hostLog.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
    if (!launch) await delay(250);
  }
  assert.ok(launch, "DSH did not provide its launch URL");
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");

  browser = await chromium.launch();
  const page = await browser.newPage({ locale: "zh-CN", viewport: {width: 1440, height: 960} });
  await page.goto(launch);
  const sidebar = page.getByRole("button", {name: "SubCast · 声渡", exact: true});
  await sidebar.waitFor({timeout: 30_000});
  for (let attempt = 0; ; attempt++) {
    for (const name of ["继续", "Continue"]) {
      const notice = page.getByRole("button", {name, exact:true}).first();
      if (await notice.isVisible()) await notice.click();
    }
    await page.keyboard.press("Escape");
    try {
      await sidebar.click({timeout: 2500});
      break;
    } catch (error) {
      if (!(error instanceof errors.TimeoutError) || attempt >= 7) throw error;
    }
  }
  const frame = page.frameLocator('iframe[title="SubCast"]');
  const search = frame.locator(".top-search input");
  await search.fill(`http://127.0.0.1:${fixture.address().port}/feed.xml`, {timeout: 30_000});
  await search.press("Enter");
  await frame.locator(".ep-item").filter({hasText: "Offline playback test"}).first().click({timeout: 30_000});
  await frame.getByTitle("下载，离线也能听", {exact: true}).click({timeout: 15_000});
  await frame.locator(".dl-done").waitFor({timeout: 30_000});
  // Shut down the source before playing so this proves the downloaded copy works.
  fixture.closeAllConnections();
  await new Promise((complete) => fixture.close(complete));
  await frame.locator(".cover-play").click();
  const audio = frame.locator("audio");
  await audio.waitFor({state: "attached"});
  let played = false;
  for (let attempt = 0; attempt < 48 && !played; attempt++) {
    played = await audio.evaluate((element) => element.currentTime > 0.4 && new URL(element.currentSrc).pathname.startsWith("/media/"));
    if (!played) await delay(250);
  }
  assert.ok(played, "The downloaded WAV did not play in SubCast");
  console.log(`PASS ${process.platform}-${process.arch}: DSH ${hostVersion}, clean profile, RSS subscription, download and offline playback`);
} catch (error) {
  console.error(hostLog.replace(/([?&]token=)[^\s]+/g, "$1[redacted]"));
  throw error;
} finally {
  await browser?.close();
  if (fixture.listening) {
    fixture.closeAllConnections();
    await new Promise((complete) => fixture.close(complete));
  }
  if (host && host.exitCode === null) {
    host.kill();
    await Promise.race([once(host, "close"), delay(5_000)]);
  }
  await rm(directory, {recursive: true, force: true, maxRetries: 8, retryDelay: 200});
}
