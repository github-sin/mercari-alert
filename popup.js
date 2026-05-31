'use strict';

const FREE_MAX = 3;
const GUMROAD_PRODUCT_ID = '_CFxnskFNsu8xdMyvV1UMg==';

// ---- State ----

const state = {
  isPro: false,
  keywords: [],
  settings: { excludeKeywords: '', priceMin: '', priceMax: '' },
  notificationsEnabled: true,
  licenseKey: '',
};

// ---- Init ----

document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get([
    'isPro', 'keywords', 'settings', 'notificationsEnabled', 'licenseKey',
  ]);
  state.isPro = data.isPro ?? false;
  state.keywords = data.keywords ?? [];
  state.settings = data.settings ?? { excludeKeywords: '', priceMin: '', priceMax: '' };
  state.notificationsEnabled = data.notificationsEnabled ?? true;
  state.licenseKey = data.licenseKey ?? '';

  // ライセンスキーがある場合は必ず Pro 扱いにする
  if (state.licenseKey) {
    state.isPro = true;
  }

  renderAll();
  bindEvents();
});

// ---- Render ----

function renderAll() {
  renderHeader();
  renderKeywords();
  renderSettings();
  renderNotificationStatus();
  renderLicenseStatus();
}

function renderHeader() {
  const badge = document.getElementById('plan-badge');
  const status = document.getElementById('status-text');

  if (state.isPro) {
    badge.textContent = 'PRO版';
    badge.classList.add('is-pro');
    status.textContent = '15秒ごとに自動チェック中';
  } else {
    badge.textContent = '無料版';
    badge.classList.remove('is-pro');
    status.textContent = '60秒ごとに自動チェック中';
  }
}

function renderKeywords() {
  const list = document.getElementById('keyword-list');
  const countEl = document.getElementById('count');
  const maxLabel = document.getElementById('max-label');
  const input = document.getElementById('keyword-input');
  const addBtn = document.getElementById('add-btn');

  const max = state.isPro ? Infinity : FREE_MAX;
  countEl.textContent = state.keywords.length;
  maxLabel.textContent = state.isPro ? '' : ` / ${FREE_MAX}`;

  const full = state.keywords.length >= max;
  input.disabled = full;
  addBtn.disabled = full;

  list.innerHTML = '';
  state.keywords.forEach((kw, i) => {
    const li = document.createElement('li');
    li.className = 'keyword-item';

    const span = document.createElement('span');
    span.className = 'kw-text';
    span.textContent = kw;

    const btn = document.createElement('button');
    btn.className = 'del-btn';
    btn.textContent = '削除';
    btn.addEventListener('click', () => deleteKeyword(i));

    li.append(span, btn);
    list.appendChild(li);
  });
}

function renderSettings() {
  const excludeInput = document.getElementById('exclude-keywords');
  const priceMinInput = document.getElementById('price-min');
  const priceMaxInput = document.getElementById('price-max');
  const hintExclude = document.getElementById('hint-exclude');
  const hintPrice = document.getElementById('hint-price');

  const locked = !state.isPro;
  excludeInput.disabled = locked;
  priceMinInput.disabled = locked;
  priceMaxInput.disabled = locked;

  hintExclude.classList.toggle('hidden', !locked);
  hintPrice.classList.toggle('hidden', !locked);

  excludeInput.value = state.settings.excludeKeywords ?? '';
  priceMinInput.value = state.settings.priceMin ?? '';
  priceMaxInput.value = state.settings.priceMax ?? '';
}

function renderNotificationStatus() {
  const toggle = document.getElementById('notif-toggle');
  const label = document.getElementById('notif-toggle-label');
  const badge = document.getElementById('notif-off-badge');

  toggle.checked = state.notificationsEnabled;
  label.textContent = state.notificationsEnabled ? 'ON' : 'OFF';
  badge.classList.toggle('hidden', state.notificationsEnabled);
}

function renderLicenseStatus() {
  const input = document.getElementById('license-input');
  const btn = document.getElementById('license-btn');
  const statusEl = document.getElementById('license-status');

  if (state.licenseKey) {
    // 認証済み: 入力欄にマスク表示、ボタンを「解除」に変更
    input.value = maskKey(state.licenseKey);
    input.disabled = true;
    btn.textContent = '解除';
    btn.classList.add('license-btn-revoke');
    btn.disabled = false;
    statusEl.textContent = '✅ Pro版認証済み';
    statusEl.className = 'license-status license-ok';
  } else {
    // 未認証
    input.value = '';
    input.disabled = false;
    btn.textContent = '認証する';
    btn.classList.remove('license-btn-revoke');
    btn.disabled = false;
    statusEl.textContent = '';
    statusEl.className = 'license-status';
  }
}

async function renderHistory() {
  const locked = document.getElementById('history-locked');
  const list = document.getElementById('history-list');

  if (!state.isPro) {
    locked.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }

  locked.classList.add('hidden');

  const { notificationHistory = [] } = await chrome.storage.local.get('notificationHistory');
  list.innerHTML = '';

  if (!notificationHistory.length) {
    const li = document.createElement('li');
    li.className = 'history-empty';
    li.textContent = 'まだ通知履歴がありません';
    list.appendChild(li);
    return;
  }

  for (const entry of notificationHistory) {
    const li = document.createElement('li');
    li.className = 'history-item';

    const d = new Date(entry.timestamp);
    const timeStr =
      `${d.getMonth() + 1}/${d.getDate()} ` +
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const priceStr = entry.price ? `¥${Number(entry.price).toLocaleString()}` : '-';

    const a = document.createElement('a');
    a.className = 'history-name';
    a.textContent = entry.name;
    a.href = `https://jp.mercari.com/item/${entry.id}`;
    a.dataset.url = `https://jp.mercari.com/item/${entry.id}`;

    const meta = document.createElement('div');
    meta.className = 'history-meta';

    const price = document.createElement('span');
    price.className = 'history-price';
    price.textContent = priceStr;

    const kw = document.createElement('span');
    kw.className = 'history-kw';
    kw.textContent = entry.keyword;

    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = timeStr;

    meta.append(price, kw, time);
    li.append(a, meta);
    list.appendChild(li);
  }
}

// ---- License ----

async function verifyLicense() {
  const input = document.getElementById('license-input');
  const btn = document.getElementById('license-btn');
  const statusEl = document.getElementById('license-status');

  // 解除モード
  if (state.licenseKey) {
    state.licenseKey = '';
    state.isPro = false;
    await chrome.storage.local.set({ isPro: false, licenseKey: '' });
    renderAll();
    return;
  }

  const key = input.value.trim();
  if (!key) return;

  // 認証中
  btn.disabled = true;
  btn.textContent = '確認中…';
  statusEl.textContent = '';
  statusEl.className = 'license-status';

  try {
    const res = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        product_id: GUMROAD_PRODUCT_ID,
        license_key: key,
      }),
    });

    const data = await res.json();

    if (data.success) {
      state.licenseKey = key;
      state.isPro = true;
      await chrome.storage.local.set({ isPro: true, licenseKey: key });
      renderAll();
    } else {
      statusEl.textContent = '❌ ライセンスキーが無効です';
      statusEl.className = 'license-status license-error';
      btn.disabled = false;
      btn.textContent = '認証する';
    }
  } catch {
    statusEl.textContent = '❌ 認証に失敗しました（通信エラー）';
    statusEl.className = 'license-status license-error';
    btn.disabled = false;
    btn.textContent = '認証する';
  }
}

function maskKey(key) {
  if (!key) return '';
  // 先頭4文字を残してマスク: "ABCD-****-****-****"
  const visible = key.slice(0, 4);
  return `${visible}-****-****-****`;
}

// ---- Events ----

function bindEvents() {
  // タブ切り替え
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'history') await renderHistory();
    });
  });

  // キーワード追加
  document.getElementById('add-btn').addEventListener('click', addKeyword);
  document.getElementById('keyword-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addKeyword();
  });

  // 設定の自動保存
  ['exclude-keywords', 'price-min', 'price-max'].forEach((id) => {
    document.getElementById(id).addEventListener('input', saveSettings);
  });

  // 通知ON/OFFトグル
  document.getElementById('notif-toggle').addEventListener('change', async (e) => {
    state.notificationsEnabled = e.target.checked;
    await chrome.storage.local.set({ notificationsEnabled: state.notificationsEnabled });
    renderNotificationStatus();
  });

  // ライセンス認証
  document.getElementById('license-btn').addEventListener('click', verifyLicense);
  document.getElementById('license-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verifyLicense();
  });

  // 履歴リンクを新しいタブで開く
  document.getElementById('history-list').addEventListener('click', (e) => {
    const a = e.target.closest('a.history-name');
    if (a) {
      e.preventDefault();
      chrome.tabs.create({ url: a.dataset.url });
    }
  });

}

// ---- Actions ----

async function addKeyword() {
  const input = document.getElementById('keyword-input');
  const kw = input.value.trim();
  clearError();
  if (!kw) return;

  const max = state.isPro ? Infinity : FREE_MAX;

  if (state.keywords.length >= max) {
    showError(`無料版は最大 ${FREE_MAX} 件まで（有料版で無制限）`);
    return;
  }
  if (state.keywords.includes(kw)) {
    showError('そのキーワードはすでに登録されています');
    return;
  }

  state.keywords.push(kw);
  await chrome.storage.local.set({ keywords: state.keywords });
  input.value = '';
  renderKeywords();
}

async function deleteKeyword(index) {
  const removed = state.keywords.splice(index, 1)[0];
  await chrome.storage.local.set({ keywords: state.keywords });
  if (removed) await chrome.storage.local.remove(`seen__${removed}`);
  renderKeywords();
}

async function saveSettings() {
  state.settings = {
    excludeKeywords: document.getElementById('exclude-keywords').value,
    priceMin: document.getElementById('price-min').value,
    priceMax: document.getElementById('price-max').value,
  };
  await chrome.storage.local.set({ settings: state.settings });
}


// ---- Helpers ----

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError() {
  const el = document.getElementById('error-msg');
  el.textContent = '';
  el.classList.add('hidden');
}
