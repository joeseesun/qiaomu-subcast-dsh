import assert from "node:assert/strict";
import test from "node:test";
import { createHostModel } from "../host/model.js";

test("DSH follows the selected model, preserves turns and forwards text only once", async () => {
  let selected = "first", captured;
  const cleanups = [];
  const ctx = {inject(names, start) {
    if (names.includes("sessionController")) {
      cleanups.push(start({sessionController:{ async modelCatalog() {
        return {
          default: {provider:"deepseek", model:selected},
          groups: [
            {id:"deepseek", name:"DeepSeek", models:[{id:"second", name:"DeepSeek Second"}]},
            {id:"other", name:"Other provider", models:[{id:"second", name:"Other Second"}]},
          ],
          failures: [{id:"unavailable", message:"Provider diagnostics"}],
        };
      }}}));
      return;
    }
    cleanups.push(start({
      agentDefaultModel:{currentSelection:() => ({provider:"deepseek", model:selected})},
      llm:{async *stream(request) {
        captured = request;
        yield {type:"text-delta",text:"hello"};
        yield {type:"block-end",block:{type:"text",text:"hello"}};
        yield {type:"finish",reason:{kind:"stop"}};
      }},
    }));
  }};
  const model = createHostModel(ctx);
  assert.equal(model.selection().model, "first");
  selected = "second";
  const events = [];
  const reply = await model.chat({
    requestId:"q1", system:"[00:03] Podcast transcription.",
    messages:[{role:"user",content:"What was tested?"},{role:"assistant",content:"Transcription."},{role:"user",content:"When?"}],
  }, (_, event) => events.push(event.delta));
  assert.equal(reply, "hello");
  assert.deepEqual(events, ["hello"]);
  assert.equal(captured.model, "second");
  assert.deepEqual(captured.messages.map(m => m.role), ["system","user","assistant","user"]);
  assert.match(captured.messages[0].content[0].text, /00:03/);
  const catalog = await model.catalog();
  assert.deepEqual(catalog.current, {provider:"deepseek", model:"second"});
  assert.deepEqual(catalog.groups.map((group) => group.id), ["deepseek", "other"]);
  assert.equal(catalog.failedProviders, 1);
  await model.chat({
    requestId:"q2", system:"Test the explicit route", messages:[{role:"user", content:"Hello"}],
    provider:{model:"ignored", dshModel:{provider:"other", model:"second", name:"Other Second"}},
  }, () => {});
  assert.equal(captured.provider, "other");
  assert.equal(captured.model, "second");
  assert.equal(model.selection().provider, "deepseek");
  for (const cleanup of cleanups) cleanup();
  assert.equal(model.selection(), null);
  await assert.rejects(model.chat({}, () => {}), /DSH/);
});
