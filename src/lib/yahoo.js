// Browser-side client for the local Yahoo Finance proxy (/api/yf/*).

export async function yf(endpoint, params = {}, signal) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
  let res;
  try {
    res = await fetch(`/api/yf/${endpoint}?${qs}`, { signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error('Could not reach the Yahoo Finance proxy. Is the app running via `npm run dev`?');
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(
      'The Yahoo Finance proxy is not available on this host. Run the app with `npm run dev`, `npm run preview` or `npm start`.',
    );
  }
  if (!res.ok) throw new Error(data?.error || `Yahoo Finance request failed (HTTP ${res.status}).`);
  return data;
}

export async function proxyHealthy() {
  try {
    return (await yf('health')).ok === true;
  } catch {
    return false;
  }
}
