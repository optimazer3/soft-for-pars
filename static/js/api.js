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
    throw new Error("Нет связи с сервером. Проверьте подключение и попробуйте ещё раз.");
  }
  if (resp.status === 204) return null;
  const data = await resp.json().catch(() => null);
  if (resp.status === 401 && !url.startsWith("/api/auth/")) {
    window.dispatchEvent(new Event("auth:required"));
  }
  if (!resp.ok) {
    let msg = data?.detail ?? `Ошибка ${resp.status}`;
    if (Array.isArray(msg)) msg = msg.map((d) => d.msg?.replace(/^Value error, /, "")).join("; ");
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }
  return data;
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();

export const admin = {
  overview: () => request("GET", "/api/admin/overview"),
  users: () => request("GET", "/api/admin/users"),
  createUser: (body) => request("POST", "/api/admin/users", body),
  updateUser: (id, body) => request("PUT", `/api/admin/users/${id}`, body),
  setPassword: (id, body) => request("POST", `/api/admin/users/${id}/password`, body),
  logoutUser: (id) => request("POST", `/api/admin/users/${id}/logout`),
  deleteUser: (id) => request("DELETE", `/api/admin/users/${id}`),
  generatePassword: () => request("GET", "/api/admin/generate-password"),
  events: (params = {}) => request("GET", `/api/admin/events?${qs(params)}`),
  sessions: (params = {}) => request("GET", `/api/admin/sessions?${qs(params)}`),
  endSession: (sid) => request("POST", `/api/admin/sessions/${encodeURIComponent(sid)}/end`),
};

export const api = {
  me: () => request("GET", "/api/auth/me"),
  login: (body) => request("POST", "/api/auth/login", body),
  logout: () => request("POST", "/api/auth/logout"),
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
