import { randomUUID } from "node:crypto";

// LLM messages follow the DSH 0.2.2 identified-message contract.
function message(role, text, source) {
  return {id:randomUUID(), role, content:[{type:"text", text}], source};
}

export function createHostModel(ctx) {
  let services;
  const jobs = new Map();
  ctx.inject(["llm", "agentDefaultModel"], scope => {
    services = scope;
    return () => {
      services = undefined;
      for (const controller of jobs.values()) controller.abort();
    };
  });
  let sessionController;
  ctx.inject(["sessionController"], scope => {
    sessionController = scope.sessionController;
    return () => { sessionController = undefined; };
  });
  function selection() {
    const current = services?.agentDefaultModel.currentSelection();
    return current?.model && current?.provider ? {model:current.model, provider:current.provider} : null;
  }
  return {
    selection,
    async catalog() {
      if (!sessionController) throw Error("DSH model catalog is unavailable");
      const { groups, default: current, failures } = await sessionController.modelCatalog();
      return {
        current: current?.provider && current?.model ? {provider: current.provider, model: current.model} : null,
        groups: groups.map(({id, name, models}) => ({
          id, name, models: models.map(({id, name}) => ({id, name})),
        })),
        failedProviders: failures.length,
      };
    },
    cancel: id => jobs.get(id)?.abort(),
    async chat(args, emit) {
      const chosen = args.provider?.dshModel;
      const model = chosen == null ? selection() : {provider: chosen.provider, model: chosen.model};
      if (!model) throw Error("请在 DSH 中登录并选择默认模型");
      if (!services || typeof model.provider !== "string" || !model.provider || typeof model.model !== "string" || !model.model)
        throw Error("Invalid DSH model selection");
      const {requestId, system, messages} = args;
      if (typeof requestId !== "string" || typeof system !== "string" || !Array.isArray(messages) || jobs.has(requestId))
        throw Error("Invalid SubCast chat request");
      const history = [message("system", system, {kind:"system-prompt"})];
      for (const turn of messages) {
        if (!["user","assistant"].includes(turn?.role) || typeof turn.content !== "string") throw Error("Invalid chat history");
        history.push(message(turn.role, turn.content, turn.role === "user" ? {kind:"user"} : {kind:"model", ...model}));
      }
      const controller = new AbortController();
      jobs.set(requestId, controller);
      let answer = "";
      let block = "";
      try {
        const stream = services.llm.stream({...model, messages:history, signal:controller.signal, maxTokens:args.maxTokens});
        for await (const chunk of stream) {
          if (controller.signal.aborted) throw Error("Cancelled");
          if (chunk.type === "text-delta") {
            block += chunk.text;
            answer += chunk.text;
            emit("llm", {requestId, delta:chunk.text});
          } else if (chunk.type === "block-end" && chunk.block?.type === "text") {
            if (!block) {
              answer += chunk.block.text;
              emit("llm", {requestId, delta:chunk.block.text});
            }
            block = "";
          } else if (chunk.type === "finish") {
            if (chunk.reason?.kind === "error") throw Error(chunk.reason.failure?.message || "DSH model request failed");
            if (chunk.reason?.kind === "aborted") throw Error("Cancelled");
            break;
          }
        }
        if (controller.signal.aborted) throw Error("Cancelled");
        if (!answer.trim()) throw Error("DSH returned an empty answer");
        return answer;
      } finally { jobs.delete(requestId); }
    },
  };
}
