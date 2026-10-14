export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
