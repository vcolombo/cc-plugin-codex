export function extractFromStream(text) {
  let sessionId = null;
  let result = null;
  let isError = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev.session_id) sessionId = ev.session_id;
    if (ev.type === 'result') {
      result = ev.result ?? null;
      isError = Boolean(ev.is_error);
    }
  }
  return { sessionId, result, isError };
}
