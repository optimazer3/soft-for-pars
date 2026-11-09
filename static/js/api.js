// Thin wrapper over the backend JSON API.
async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let resp;
  try {
    resp = await fetch(url, opts);
  } catch {
    throw new Error("Нет связи с локальным сервером. Он запущен?");
  }
  if (resp.status === 204) return null;
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    let msg = data?.detail ?? `Ошибка ${resp.status}`;
    if (Array.isArray(msg)) msg = msg.map((d) => d.msg?.replace(/^Value error, /, "")).join("; ");
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }
  return data;
}

export const api = {
  dashboard: () => request("GET", "/api/dashboard"),
  clients: () => request("GET", "/api/clients"),
  client: (id) => request("GET", `/api/clients/${id}`),
  createClient: (body) => request("POST", "/api/clients", body),
  updateClient: (id, body) => request("PUT", `/api/clients/${id}`, body),
  deleteClient: (id) => request("DELETE", `/api/clients/${id}`),
  testConnection: (body) => request("POST", "/api/clients/test", body),
  syncClient: (id) => request("POST", `/api/clients/${id}/sync`),
  syncAll: () => request("POST", "/api/sync"),
  syncStatus: () => request("GET", "/api/sync/status"),
  snapshot: (id) => request("GET", `/api/clients/${id}/snapshot`),
  settings: () => request("GET", "/api/settings"),
  saveSettings: (body) => request("PUT", "/api/settings", body),
};
