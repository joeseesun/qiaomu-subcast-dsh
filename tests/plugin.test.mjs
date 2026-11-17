import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createSurface } from "../host/surface.js";

// Exercise the actual packaged engine through the same HTTP transport as the panel.
test("subscribe, read, download, seek, chat and reopen the saved library", {timeout: 30000}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "subcast-plugin-"));
  const audio = Buffer.from("0123456789".repeat(100));
  const fixture = createServer((req, res) => {
    if (req.url === "/ep.wav") return res.end(audio);
    if (req.url === "/episode.vtt") return res.end("WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nA fixture caption.\n");
    if (req.url === "/chat/completions") {
      res.writeHead(200, {"Content-Type":"text/event-stream"});
      return res.end('data: {"choices":[{"delta":{"content":"A reply."}}]}\n\ndata: [DONE]\n\n');
    }
    res.end(`<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
        <title>Test podcast</title><item><guid>ep</guid><title>A test episode</title>
        <enclosure url="${feed}/ep.wav" type="audio/wav"/>
        <podcast:transcript url="${feed}/episode.vtt" type="text/vtt"/></item></channel></rss>`);
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const feed = "http://127.0.0.1:" + fixture.address().port;
  let surface = createSurface(directory);
  t.after(async () => { surface.dispose(); fixture.closeAllConnections(); fixture.close(); await rm(directory, {recursive:true, force:true}); });
  let url = new URL(await surface.connect(feed));
  async function rpc(method, args = {}) {
    const res = await fetch(url.origin + "/rpc", {method:"POST", headers:{Origin:url.origin, Authorization:"Bearer " + url.hash.slice(1), "content-type":"application/json"}, body:JSON.stringify({method,args})});
    const result = await res.json();
    if (!res.ok) throw new Error(result.error);
    return result.value;
  }
  assert.equal((await fetch(url.origin + "/rpc", {method:"POST"})).status, 403);
  await assert.rejects(rpc("unknown"), /Unknown SubCast command/);
  const {show} = await rpc("add_subscription", {input:feed + "/feed.xml"});
  const [ep] = await rpc("list_episodes", {showId:show.id});
  const transcript = await rpc("fetch_official_transcript", {episodeId:ep.id});
  assert.equal(transcript.segments[0].text, "A fixture caption.");
  const saved = await rpc("download_episode", {episodeId:ep.id});
  assert.deepEqual(await readFile(saved.path), audio);
  const media = url.origin + "/media/" + basename(saved.path);
  assert.equal((await fetch(media)).status, 403);
  const part = await fetch(media + "?key=" + url.hash.slice(1), {headers:{Range:"bytes=2-6"}});
  assert.equal(part.status, 206); assert.equal(await part.text(), "23456");
  await rpc("set_progress", {id:ep.id, seconds:13});
  const abort = new AbortController();
  const events = await fetch(url.origin + "/events?key=" + url.hash.slice(1), {signal:abort.signal});
  try {
    const reply = await rpc("llm_chat", {requestId:"test",provider:{id:"fixture", baseUrl:feed,protocol:"openai",model:"fixture"},system:"Answer briefly",messages:[{role:"user",content:"Hello"}]});
    assert.equal(reply, "A reply.");
    let text = "";
    for await (const chunk of events.body) {
      text += Buffer.from(chunk).toString();
      if (text.includes("A reply.")) break;
    }
    assert.match(text, /event: llm/);
  } finally { abort.abort(); }
  surface.dispose();
  surface = createSurface(directory);
  url = new URL(await surface.connect(feed));
  assert.equal((await rpc("get_episode", {id:ep.id})).progress, 13);
  assert.equal((await rpc("list_downloads")).length, 1);
  assert.equal((await rpc("load_transcript", {episodeId:ep.id})).segments.length, 1);
});
