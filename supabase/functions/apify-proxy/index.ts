import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const APIFY_BASE = "https://api.apify.com/v2";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Não autenticado." }, 401);

    const token = Deno.env.get("APIFY_TOKEN");
    if (!token) return json({ error: "Secret APIFY_TOKEN não configurado no Supabase." }, 500);

    const body = await req.json();
    const action = body?.action;
    let url = "";
    let options: RequestInit = { headers: { Authorization: `Bearer ${token}` } };

    if (action === "start") {
      const actorId = String(body.actorId || "").replace("/", "~");
      if (!actorId) return json({ error: "Actor inválido." }, 400);
      url = `${APIFY_BASE}/actors/${encodeURIComponent(actorId)}/runs`;
      options = {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body.input || {}),
      };
    } else if (action === "status") {
      if (!body.runId) return json({ error: "Run ID ausente." }, 400);
      url = `${APIFY_BASE}/actor-runs/${encodeURIComponent(body.runId)}`;
    } else if (action === "dataset") {
      if (!body.datasetId) return json({ error: "Dataset ID ausente." }, 400);
      url = `${APIFY_BASE}/datasets/${encodeURIComponent(body.datasetId)}/items?format=json&clean=true`;
    } else {
      return json({ error: "Ação inválida." }, 400);
    }

    const response = await fetch(url, options);
    const text = await response.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!response.ok) {
      const message = typeof data === "object" && data && "error" in data
        ? (data as any).error?.message || `Apify HTTP ${response.status}`
        : `Apify HTTP ${response.status}`;
      return json({ error: message }, response.status);
    }

    return json(data, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Erro inesperado." }, 500);
  }
});

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
