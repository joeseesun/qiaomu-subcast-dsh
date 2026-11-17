window.__ModuleLoader__.load({
  id: "qiaomu-subcast-dsh",
  factory(require) {
    const {createElement: h, useState, useEffect} = require("react");
    function Panel() {
      const [url, setUrl] = useState("");
      const [error, setError] = useState("");
      const [attempt, retry] = useState(0);
      useEffect(() => {
        const controller = new AbortController();
        fetch("/qiaomu-subcast/connect", {method:"POST", headers:{"x-subcast-panel":"1"}, signal:controller.signal})
          .then(async res => { if (!res.ok) throw Error(await res.text()); return res.json(); })
          .then(data => setUrl(data.url))
          .catch(err => { if (!controller.signal.aborted) setError(err.message); });
        return () => controller.abort();
      }, [attempt]);
      if (error) return h("div", {role:"alert"}, error, h("button", {onClick:() => {setError(""); retry(attempt + 1);}}, "重试 / Retry"));
      if (!url) return h("div", {role:"status"}, "SubCast…");
      return h("iframe", {title:"SubCast", src:url, allow:"autoplay; fullscreen; clipboard-write", allowFullScreen:true,
        style:{display:"block", width:"100%", height:"100%", flex:"1 1 auto", border:0}});
    }
    function Icon({size = 18}) {
      return h("svg", {width:size, height:size, viewBox:"0 0 24 24", fill:"none", stroke:"currentColor", strokeWidth:1.8}, h("path", {d:"M3 15v-3a9 9 0 0118 0v3M3 14h4v7H5a2 2 0 01-2-2zm18 0h-4v7h2a2 2 0 002-2z"}));
    }
    return {inject:["slots"], apply(ctx) {
      const id = "qiaomu-subcast";
      ctx.slots.inject("main", () => ctx.slots.register({name:"main", key:id}, Panel));
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({name:"sidebar.panellist", id, order:48, label:() => "SubCast · 声渡"}, Icon));
    }};
  },
});
