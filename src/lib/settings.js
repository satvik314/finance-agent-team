// API keys and preferences. Keys stay in this browser: sessionStorage by
// default, localStorage only when the user ticks "Remember on this device".

const KEY = 'finance-agent-team:settings';
export const DEFAULT_MODEL = 'gemini-3.8-flash';

const defaults = { geminiKey: '', model: DEFAULT_MODEL, remember: false, reportStyle: 'concise' };

function read(store) {
  try {
    return JSON.parse(store.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

export function loadSettings() {
  return { ...defaults, ...(read(localStorage) || read(sessionStorage) || {}) };
}

export function saveSettings(s) {
  const data = { ...defaults, ...s };
  try {
    if (data.remember) {
      localStorage.setItem(KEY, JSON.stringify(data));
      sessionStorage.removeItem(KEY);
    } else {
      sessionStorage.setItem(KEY, JSON.stringify(data));
      // Keep non-secret preferences across visits, but never the key.
      localStorage.setItem(KEY, JSON.stringify({ ...data, geminiKey: '' }));
    }
  } catch {
    /* storage unavailable (private mode) — settings live in memory only */
  }
  return data;
}

export function clearKeys(s) {
  return saveSettings({ ...s, geminiKey: '', remember: false });
}
