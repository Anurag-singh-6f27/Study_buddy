export async function api(url, { method, body, form } = {}) {
  const r = await fetch(url, {
    method: method || (body || form ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}

// POST and read the reply as it arrives; onText gets the full text so far.
export async function stream(url, body, onText) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  const reader = r.body.getReader(), dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    onText(text);
  }
  return text;
}