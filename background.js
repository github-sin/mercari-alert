'use strict';

const ALARM_NAME = 'mercari-poll';

// ---- Setup ----

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  console.log('[MercariAlert] installed');
});

chrome.runtime.onStartup.addListener(ensureAlarm);

function ensureAlarm() {
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
      console.log('[MercariAlert] alarm created');
    }
  });
}

// ---- Polling ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    handleAlarm();
  }
});

async function handleAlarm() {
  const { isPro = false } = await chrome.storage.local.get({ isPro: false });
  await pollAllKeywords();

  if (isPro) {
    // Pro: MV3 の最小1分制約の回避策として15秒間隔で3回追加ポーリング
    setTimeout(() => pollAllKeywords(), 15_000);
    setTimeout(() => pollAllKeywords(), 30_000);
    setTimeout(() => pollAllKeywords(), 45_000);
  }
}

async function pollAllKeywords() {
  const data = await chrome.storage.local.get(['keywords', 'isPro', 'settings']);
  const keywords = data.keywords ?? [];
  const isPro = data.isPro ?? false;
  const settings = data.settings ?? {};

  if (!keywords.length) return;

  console.log('[MercariAlert] polling', keywords, { isPro });

  for (const kw of keywords) {
    try {
      await checkKeyword(kw, isPro, settings);
    } catch (err) {
      console.error(`[MercariAlert] Error checking "${kw}":`, err.message);
    }
  }
}

async function checkKeyword(keyword, isPro, settings) {
  const items = await fetchItemsViaTab(keyword);
  if (!items.length) return;

  // 有料版のみフィルタリングを適用
  const filtered = isPro ? applyFilters(items, settings) : items;

  const storeKey = `seen__${keyword}`;
  const stored = await chrome.storage.local.get(storeKey);
  const seenIds = stored[storeKey] ?? null;

  if (seenIds === null) {
    // 初回: IDを保存するだけで通知しない
    await chrome.storage.local.set({ [storeKey]: filtered.map((i) => i.id) });
    console.log(`[MercariAlert] seeded ${filtered.length} items for "${keyword}"`);
    return;
  }

  const seenSet = new Set(seenIds);
  const newItems = filtered.filter((i) => !seenSet.has(i.id));

  if (newItems.length) {
    console.log(`[MercariAlert] ${newItems.length} new item(s) for "${keyword}"`);
    const merged = [...seenSet, ...newItems.map((i) => i.id)];
    await chrome.storage.local.set({ [storeKey]: merged.slice(-500) });

    const toNotify = newItems.slice(0, 5);
    toNotify.forEach(notify);

    if (isPro) {
      await appendHistory(toNotify, keyword);
    }
  }
}

// ---- Filters (Pro only) ----

function applyFilters(items, settings) {
  const priceMin = Number(settings.priceMin) || 0;
  const priceMax = Number(settings.priceMax) || 0;
  const excludeList = (settings.excludeKeywords ?? '')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  return items.filter((item) => {
    if (priceMin > 0 && item.price < priceMin) return false;
    if (priceMax > 0 && item.price > priceMax) return false;
    if (excludeList.length > 0) {
      const lc = item.name.toLowerCase();
      if (excludeList.some((ex) => lc.includes(ex))) return false;
    }
    return true;
  });
}

// ---- History (Pro only) ----

async function appendHistory(items, keyword) {
  const { notificationHistory = [] } = await chrome.storage.local.get('notificationHistory');
  const entries = items.map((item) => ({
    id: item.id,
    name: item.name,
    price: item.price,
    keyword,
    timestamp: Date.now(),
  }));
  const updated = [...entries, ...notificationHistory].slice(0, 50);
  await chrome.storage.local.set({ notificationHistory: updated });
}

// ---- Tab-based scraping ----

async function fetchItemsViaTab(keyword) {
  const searchUrl =
    `https://jp.mercari.com/search?keyword=${encodeURIComponent(keyword)}` +
    `&sort=created_time&order=desc`;

  const tabs = await chrome.tabs.query({ url: 'https://jp.mercari.com/search*' });
  let tabId;
  let created = false;

  if (tabs.length > 0) {
    tabId = tabs[0].id;
    await chrome.tabs.update(tabId, { url: searchUrl });
  } else {
    const tab = await chrome.tabs.create({ url: searchUrl, active: false });
    tabId = tab.id;
    created = true;
  }

  await waitForTabLoad(tabId);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: scrapeItems,
  });

  if (created) {
    chrome.tabs.remove(tabId).catch(() => {});
  }

  return results[0]?.result ?? [];
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const TIMEOUT_MS = 15_000;

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return reject(new Error('Tab not found'));
      if (tab.status === 'complete') return resolve();

      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Tab load timeout'));
      }, TIMEOUT_MS);

      function listener(id, changeInfo) {
        if (id === tabId && changeInfo.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }

      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// content script として注入する関数（外部スコープ参照不可）
async function scrapeItems() {
  const MAX_WAIT_MS = 10_000;
  const POLL_MS = 500;
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT_MS) {
    if (document.querySelectorAll('a[href*="/item/m"]').length > 0) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  const items = [];
  const seen = new Set();

  for (const link of document.querySelectorAll('a[href*="/item/m"]')) {
    const match = link.href.match(/\/item\/(m\w+)/);
    if (!match) continue;

    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const img = link.querySelector('img');
    const name = (
      img?.alt?.trim() ||
      link.getAttribute('aria-label')?.trim() ||
      link
        .querySelector('[class*="name"],[class*="title"],[class*="Name"],[class*="Title"]')
        ?.textContent?.trim() ||
      link.textContent?.trim()
    )?.slice(0, 80) || '商品名不明';

    const container =
      link.closest('li,article,[data-testid],[class*="item"],[class*="Item"]') ?? link;
    const priceEl = container.querySelector(
      '[class*="price"],[class*="Price"],[data-testid*="price"]'
    );
    const price =
      parseInt((priceEl?.textContent ?? '').replace(/[^0-9]/g, ''), 10) || 0;

    items.push({ id, name, price });
    if (items.length >= 20) break;
  }

  return items;
}

// ---- Notification ----

async function notify(item) {
  const { notificationsEnabled } = await chrome.storage.local.get('notificationsEnabled');
  if (notificationsEnabled === false) {
    console.log('[MercariAlert] 通知OFF: スキップ');
    return;
  }
  const notifId = `mercari-alert-${item.id}`;
  const priceStr = item.price ? ` ¥${item.price.toLocaleString()}` : '';
  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: '🛍️ メルカリ新着アラート',
    message: `${item.name}${priceStr}`,
  });
}

chrome.notifications.onClicked.addListener((notifId) => {
  const itemId = notifId.replace(/^mercari-alert-/, '');
  if (itemId) {
    chrome.tabs.create({ url: `https://jp.mercari.com/item/${itemId}` });
  }
  chrome.notifications.clear(notifId);
});
