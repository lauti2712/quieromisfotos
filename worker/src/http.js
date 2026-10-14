export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// URL pública de esta API (en desarrollo, wrangler reescribe el host de req.url al de producción).
export function apiUrl(env, req) {
  return (env.API_URL || new URL(req.url).origin).replace(/\/$/, '');
}
