import './style.css';
import { createTeam, MEMBERS, REPORT_STYLES } from './agents/team.js';
import { listModels } from './lib/gemini.js';
import { proxyHealthy } from './lib/yahoo.js';
import { renderMarkdown, escapeHtml } from './lib/markdown.js';
import { loadSettings, saveSettings, clearKeys, DEFAULT_MODEL } from './lib/settings.js';
import { sparkline } from './ui/sparkline.js';

const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  messages: $('#messages'),
  empty: $('#empty'),
  setupCallout: $('#setup-callout'),
  composer: $('#composer'),
  prompt: $('#prompt'),
  send: $('#send'),
  members: $('#members'),
  log: $('#log'),
  snapshotPanel: $('#snapshot-panel'),
  snapshots: $('#snapshots'),
  side: $('#side'),
  modelLabel: $('#model-label'),
  keyDot: $('#key-dot'),
  dialog: $('#settings'),
  keyInput: $('#gemini-key'),
  modelInput: $('#model'),
  modelList: $('#model-list'),
  modelStatus: $('#model-status'),
  proxyStatus: $('#proxy-status'),
  remember: $('#remember'),
};

let settings = loadSettings();
let team = createTeam();
let controller = null;
const snapshots = new Map(); // symbol -> { quote, series, period }
const memberState = Object.fromEntries(MEMBERS.map((m) => [m.id, { status: 'idle', tools: 0, task: '' }]));
const memberName = Object.fromEntries(MEMBERS.map((m) => [m.id, m.name]));

// ------------------------------------------------------------- settings --

function refreshHeader() {
  const hasKey = Boolean(settings.geminiKey);
  els.modelLabel.textContent = hasKey ? settings.model : 'No API key';
  els.keyDot.classList.toggle('ok', hasKey);
  els.setupCallout.hidden = hasKey;
  document.querySelector(`input[name="style"][value="${settings.reportStyle}"]`).checked = true;
}

let proxyChecked = false;
async function checkProxy() {
  els.proxyStatus.textContent = 'Checking the local Yahoo Finance proxy…';
  const ok = await proxyHealthy();
  proxyChecked = ok;
  els.proxyStatus.innerHTML = ok
    ? '<b class="ok-text">Connected.</b> No API key needed — data is fetched through this app\'s built-in proxy.'
    : '<b class="err-text">Proxy not reachable.</b> Run the app with <code>npm run dev</code>, <code>npm run preview</code> or <code>npm start</code> so market data works.';
}

function openSettings() {
  els.keyInput.value = settings.geminiKey;
  els.modelInput.value = settings.model;
  els.remember.checked = settings.remember;
  els.keyInput.type = 'password';
  $('#toggle-key').textContent = 'Show';
  els.dialog.showModal();
  if (!proxyChecked) checkProxy();
  (settings.geminiKey ? els.modelInput : els.keyInput).focus();
}

let validatedKey = '';
async function loadModelList({ quiet = false } = {}) {
  const key = els.keyInput.value.trim();
  if (!key) {
    els.modelStatus.textContent = 'Enter your Gemini API key first.';
    return false;
  }
  els.modelStatus.textContent = 'Checking key…';
  try {
    const models = await listModels(key);
    els.modelList.innerHTML = models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join('');
    validatedKey = key;
    const ids = models.map((m) => m.id);
    const current = els.modelInput.value.trim();
    if (ids.length && !ids.includes(current)) {
      const fallback = ids.includes(DEFAULT_MODEL)
        ? DEFAULT_MODEL
        : ids.find((id) => id === 'gemini-flash-latest') || ids.find((id) => /flash/.test(id)) || ids[0];
      els.modelInput.value = fallback;
      els.modelStatus.innerHTML = `<b class="ok-text">Key works.</b> “${escapeHtml(current)}” isn't available to this key, so switched to <code>${escapeHtml(fallback)}</code>. ${ids.length} models available.`;
    } else {
      els.modelStatus.innerHTML = `<b class="ok-text">Key works.</b> ${ids.length} models available — pick one from the list.`;
    }
    return true;
  } catch (err) {
    if (!quiet) els.modelStatus.innerHTML = `<b class="err-text">${escapeHtml(err.message)}</b>`;
    return false;
  }
}

$('#open-settings').addEventListener('click', openSettings);
$('#model-pill').addEventListener('click', openSettings);
$('#close-settings').addEventListener('click', () => els.dialog.close());
$('#load-models').addEventListener('click', () => loadModelList());
$('#toggle-key').addEventListener('click', (e) => {
  const show = els.keyInput.type === 'password';
  els.keyInput.type = show ? 'text' : 'password';
  e.currentTarget.textContent = show ? 'Hide' : 'Show';
});
$('#clear-keys').addEventListener('click', () => {
  settings = clearKeys(settings);
  els.keyInput.value = '';
  els.remember.checked = false;
  els.modelStatus.textContent = 'Key cleared from this browser.';
  refreshHeader();
});
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-settings]')) openSettings();
});

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = els.keyInput.value.trim();
  // A new, unchecked key: validate it and pick a model it can use before saving.
  if (key && key !== settings.geminiKey && key !== validatedKey) {
    $('#save-settings').disabled = true;
    await loadModelList();
    $('#save-settings').disabled = false;
  }
  settings = saveSettings({
    ...settings,
    geminiKey: key,
    model: els.modelInput.value.trim() || DEFAULT_MODEL,
    remember: els.remember.checked,
  });
  refreshHeader();
  els.dialog.close();
  els.prompt.focus();
});

document.querySelectorAll('input[name="style"]').forEach((r) =>
  r.addEventListener('change', () => {
    settings = saveSettings({ ...settings, reportStyle: r.value });
  }),
);

// ---------------------------------------------------------- side panel --

function renderMembers() {
  els.members.innerHTML = MEMBERS.map((m) => {
    const s = memberState[m.id];
    const label = { idle: 'Idle', working: 'Working', done: 'Done', error: 'Issue' }[s.status];
    return `<li class="member ${s.status}">
      <div class="member-top">
        <span class="avatar">${m.name.split(' ').map((w) => w[0]).join('').slice(0, 2)}</span>
        <div class="member-name"><b>${escapeHtml(m.name)}</b><small>${m.googleSearch ? 'Google Search' : `${m.tools.length} Yahoo Finance tools`}</small></div>
        <span class="status">${label}${s.tools ? ` · ${s.tools} calls` : ''}</span>
      </div>
      ${s.task && s.status === 'working' ? `<p class="member-task">${escapeHtml(s.task)}</p>` : ''}
    </li>`;
  }).join('');
}

function logItem(html, cls = '') {
  $('.log-empty', els.log)?.remove();
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = html;
  els.log.append(li);
  els.log.scrollTop = els.log.scrollHeight;
  return li;
}

const fmtArgs = (args) =>
  Object.values(args ?? {})
    .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
    .join(', ');

const toolEls = new Map();
function onEvent(ev, ui) {
  switch (ev.type) {
    case 'leader:start':
      logItem('<b>Team Leader</b> is planning the work', 'leader');
      ui.status('Team leader is planning…');
      break;
    case 'leader:note':
      logItem(`<b>Team Leader:</b> ${escapeHtml(ev.text.slice(0, 280))}`, 'leader');
      break;
    case 'member:start':
      Object.assign(memberState[ev.member], { status: 'working', task: ev.task });
      logItem(`Delegated to <b>${escapeHtml(memberName[ev.member])}</b>: ${escapeHtml(ev.task)}`, 'delegate');
      ui.status(`${memberName[ev.member]} is working…`);
      ui.addMember(ev.member);
      break;
    case 'member:end':
      memberState[ev.member].status = ev.ok ? 'done' : 'error';
      logItem(
        ev.ok
          ? `<b>${escapeHtml(memberName[ev.member])}</b> reported back`
          : `<b>${escapeHtml(memberName[ev.member])}</b> hit a problem: ${escapeHtml(ev.error)}`,
        ev.ok ? 'done' : 'error',
      );
      break;
    case 'search':
      logItem(`<span class="tag">web</span> ${escapeHtml(memberName[ev.member])} searched “${escapeHtml(ev.query)}”`, 'tool ok');
      break;
    case 'tool:start':
      memberState[ev.member].tools += 1;
      toolEls.set(
        ev.callId,
        logItem(`<span class="tag">yf</span> <code>${escapeHtml(ev.tool)}(${escapeHtml(fmtArgs(ev.args))})</code>`, 'tool running'),
      );
      ui.status(`${memberName[ev.member]} → ${ev.tool}`);
      break;
    case 'tool:end': {
      const li = toolEls.get(ev.callId);
      if (li) {
        li.classList.remove('running');
        li.classList.add(ev.ok ? 'ok' : 'error');
        if (!ev.ok && ev.error) li.insertAdjacentHTML('beforeend', `<small>${escapeHtml(ev.error)}</small>`);
      }
      break;
    }
    case 'quote':
      upsertSnapshot(ev.quote.symbol, { quote: ev.quote, series: ev.series, period: '1mo' });
      break;
    case 'history':
      upsertSnapshot(ev.symbol, { series: ev.series, period: ev.period, currency: ev.currency });
      break;
    case 'leader:end':
      logItem('<b>Team Leader</b> wrote the answer', 'leader');
      break;
  }
  renderMembers();
}

// ------------------------------------------------------------ snapshots --

function upsertSnapshot(symbol, data) {
  snapshots.set(symbol, { ...(snapshots.get(symbol) || { symbol }), ...data });
  renderSnapshots();
}

const money = (n, cur) => {
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: n < 10 ? 4 : 2 }).format(n);
  } catch {
    return n.toFixed(2);
  }
};

function renderSnapshots() {
  const list = [...snapshots.values()].slice(-4).reverse();
  els.snapshotPanel.hidden = !list.length;
  els.snapshots.innerHTML = list
    .map((s) => {
      const q = s.quote || {};
      const series = s.series || [];
      const price = q.price ?? series.at(-1)?.close;
      const cur = q.currency || s.currency;
      const first = series[0]?.close;
      const periodChange = Number.isFinite(first) && Number.isFinite(series.at(-1)?.close) ? (series.at(-1).close / first - 1) * 100 : undefined;
      const dayUp = (q.change_percent ?? periodChange ?? 0) >= 0;
      const trendUp = (periodChange ?? q.change_percent ?? 0) >= 0;
      return `<article class="snap">
        <div class="snap-head">
          <div><b>${escapeHtml(s.symbol)}</b><small>${escapeHtml(q.name || '')}</small></div>
          <div class="snap-price"><b>${money(price, cur)}</b>
            ${Number.isFinite(q.change_percent) ? `<span class="${dayUp ? 'up' : 'down'}">${dayUp ? '▲' : '▼'} ${Math.abs(q.change_percent).toFixed(2)}% today</span>` : ''}
          </div>
        </div>
        ${series.length > 1 ? sparkline(series.map((p) => p.close), trendUp) : ''}
        <div class="snap-foot">
          <span>${escapeHtml(s.period || '')}${Number.isFinite(periodChange) ? ` <b class="${trendUp ? 'up' : 'down'}">${periodChange >= 0 ? '+' : ''}${periodChange.toFixed(1)}%</b>` : ''}</span>
          ${q.as_of ? `<span>as of ${new Date(q.as_of).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>` : ''}
        </div>
      </article>`;
    })
    .join('');
}

// ------------------------------------------------------------ messages --

function addUserMessage(text) {
  els.empty.hidden = true;
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  els.messages.append(div);
  scrollToBottom(true);
}

function addAssistantMessage() {
  const div = document.createElement('div');
  div.className = 'msg assistant pending';
  div.innerHTML = `
    <div class="msg-head"><span class="avatar lead">TL</span><b>Team Leader</b><span class="used"></span></div>
    <div class="working"><span class="spinner"></span><span class="working-text">Starting…</span></div>
    <div class="content md"></div>
    <div class="sources" hidden></div>
    <div class="msg-actions" hidden><button type="button" class="link copy">Copy</button><span class="elapsed"></span></div>`;
  els.messages.append(div);
  scrollToBottom(true);

  const content = $('.content', div);
  let text = '';
  let frame = 0;
  const render = () => {
    frame = 0;
    content.innerHTML = renderMarkdown(text);
    scrollToBottom();
  };
  const used = new Set();
  const started = performance.now();

  return {
    el: div,
    status(t) {
      $('.working-text', div).textContent = t;
    },
    addMember(id) {
      used.add(id);
      $('.used', div).innerHTML = [...used].map((m) => `<span class="badge">${escapeHtml(memberName[m])}</span>`).join('');
    },
    append(delta) {
      div.classList.remove('pending');
      div.classList.add('streaming');
      text += delta;
      if (!frame) frame = requestAnimationFrame(render);
    },
    reset() {
      text = '';
      content.innerHTML = '';
      div.classList.add('pending');
      div.classList.remove('streaming');
    },
    finish({ text: finalText, sources = [] }) {
      cancelAnimationFrame(frame);
      text = finalText || text;
      content.innerHTML = renderMarkdown(text);
      div.classList.remove('pending', 'streaming');
      if (sources.length) {
        const box = $('.sources', div);
        box.hidden = false;
        box.innerHTML = `<details${sources.length <= 6 ? ' open' : ''}><summary>Sources (${sources.length})</summary><ol>${sources
          .map((s) => {
            let host = '';
            try {
              host = new URL(s.url).hostname.replace(/^www\./, '');
            } catch {
              /* ignore */
            }
            return `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title || host)}</a>${host && host !== s.title ? ` <small>${escapeHtml(host)}</small>` : ''}</li>`;
          })
          .join('')}</ol></details>`;
      }
      const actions = $('.msg-actions', div);
      actions.hidden = false;
      $('.elapsed', div).textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`;
      $('.copy', div).addEventListener('click', async (e) => {
        try {
          await navigator.clipboard.writeText(text);
          e.target.textContent = 'Copied';
          setTimeout(() => (e.target.textContent = 'Copy'), 1500);
        } catch {
          /* clipboard blocked */
        }
      });
      scrollToBottom();
    },
    fail(message, { stopped = false, settingsHint = false } = {}) {
      cancelAnimationFrame(frame);
      div.classList.remove('pending', 'streaming');
      if (text) content.innerHTML = renderMarkdown(text);
      div.insertAdjacentHTML(
        'beforeend',
        `<div class="${stopped ? 'notice' : 'error-box'}">${escapeHtml(message)}${
          settingsHint ? ' <button type="button" class="link" data-open-settings>Open settings</button>' : ''
        }</div>`,
      );
      scrollToBottom();
    },
  };
}

function scrollToBottom(force = false) {
  const m = els.messages;
  const near = m.scrollHeight - m.scrollTop - m.clientHeight < 160;
  if (force || near) m.scrollTop = m.scrollHeight;
}

// ------------------------------------------------------------- running --

function setBusy(busy) {
  document.body.classList.toggle('busy', busy);
  els.send.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  els.send.innerHTML = busy
    ? '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z"/></svg>';
}

async function ask(prompt) {
  prompt = prompt.trim();
  if (!prompt) return;
  if (!settings.geminiKey) {
    openSettings();
    return;
  }

  addUserMessage(prompt);
  els.prompt.value = '';
  autosize();
  const ui = addAssistantMessage();
  for (const s of Object.values(memberState)) Object.assign(s, { status: 'idle', tools: 0, task: '' });
  renderMembers();
  if (els.log.children.length && !$('.log-empty', els.log)) logItem(`<hr />`, 'divider');

  controller = new AbortController();
  setBusy(true);
  try {
    const result = await team.run(prompt, {
      apiKey: settings.geminiKey,
      model: settings.model,
      signal: controller.signal,
      extraInstructions: [REPORT_STYLES[settings.reportStyle] || REPORT_STYLES.concise],
      emit: (ev) => onEvent(ev, ui),
      onText: (t) => ui.append(t),
      onTextReset: () => ui.reset(),
    });
    ui.finish(result);
  } catch (err) {
    if (err?.name === 'AbortError') {
      ui.fail('Stopped.', { stopped: true });
      logItem('Run stopped by you', 'error');
    } else {
      const settingsHint = [400, 401, 403, 404].includes(err?.status);
      ui.fail(err?.message || String(err), { settingsHint });
      logItem(`Error: ${escapeHtml(err?.message || String(err))}`, 'error');
    }
    for (const s of Object.values(memberState)) if (s.status === 'working') s.status = 'error';
    renderMembers();
  } finally {
    controller = null;
    setBusy(false);
  }
}

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (controller) controller.abort();
  else ask(els.prompt.value);
});

els.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!controller) ask(els.prompt.value);
  }
});

function autosize() {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, 200)}px`;
}
els.prompt.addEventListener('input', autosize);

$('#suggestions').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip && !controller) ask(chip.textContent);
});

$('#new-chat').addEventListener('click', () => {
  controller?.abort();
  team = createTeam();
  els.messages.querySelectorAll('.msg').forEach((m) => m.remove());
  els.empty.hidden = false;
  snapshots.clear();
  renderSnapshots();
  for (const s of Object.values(memberState)) Object.assign(s, { status: 'idle', tools: 0, task: '' });
  renderMembers();
  els.log.innerHTML = '<li class="log-empty">Agent steps and tool calls will appear here.</li>';
  els.prompt.focus();
});

$('#clear-log').addEventListener('click', () => {
  els.log.innerHTML = '<li class="log-empty">Agent steps and tool calls will appear here.</li>';
});

$('#toggle-side').addEventListener('click', () => document.body.classList.toggle('side-open'));

// --------------------------------------------------------------- start --

refreshHeader();
renderMembers();
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('ready')));
if (!settings.geminiKey) openSettings();
else els.prompt.focus();
