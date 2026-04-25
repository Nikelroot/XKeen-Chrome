const SESSION_KEY = "tracked_domains_by_tab";
const MAX_TRACKED_DOMAINS_PER_TAB = 500;

const trackedDomainsByTab = new Map(); // tabId -> Map(domain -> meta)

let loadedFromSession = false;
let loadPromise = null;
let persistTimer = null;

function isIPv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const num = Number(part);
    return num >= 0 && num <= 255;
  });
}

function isIPv6(host) {
  return /^[0-9a-f:]+$/i.test(host) && host.includes(":");
}

function normalizeHostname(hostname) {
  if (!hostname) return "";
  let host = String(hostname).trim().toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("www.")) {
    host = host.slice(4);
  }
  if (!host || isIPv4(host) || isIPv6(host)) {
    return "";
  }
  return host;
}

function nowMs() {
  return Date.now();
}

function statusPriority(status) {
  switch (status) {
    case "error":
      return 4;
    case "ok":
      return 3;
    case "redirect":
      return 2;
    case "pending":
      return 1;
    default:
      return 0;
  }
}

function defaultDomainMeta() {
  return {
    status: "pending",
    lastStatusCode: 0,
    hits: 0,
    updatedAt: 0,
  };
}

function toSerializableStore() {
  const store = {};

  for (const [tabId, domainMap] of trackedDomainsByTab.entries()) {
    if (!domainMap.size) continue;

    const serializedByDomain = {};
    for (const [domain, meta] of domainMap.entries()) {
      serializedByDomain[domain] = {
        status: meta.status,
        lastStatusCode: Number(meta.lastStatusCode) || 0,
        hits: Number(meta.hits) || 0,
        updatedAt: Number(meta.updatedAt) || 0,
      };
    }

    store[String(tabId)] = serializedByDomain;
  }

  return store;
}

function schedulePersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await chrome.storage.session.set({ [SESSION_KEY]: toSerializableStore() });
    } catch {
      // ignore session persistence errors
    }
  }, 350);
}

function clearTrackedDomainsForTab(tabId) {
  if (trackedDomainsByTab.delete(tabId)) {
    schedulePersist();
  }
}

function ensureDomainMap(tabId) {
  const existing = trackedDomainsByTab.get(tabId);
  if (existing) return existing;
  const created = new Map();
  trackedDomainsByTab.set(tabId, created);
  return created;
}

function upsertDomainMeta(tabId, hostname, patchFn) {
  const domain = normalizeHostname(hostname);
  if (!domain) return;

  const domainMap = ensureDomainMap(tabId);
  const existing = domainMap.get(domain) || defaultDomainMeta();

  if (!domainMap.has(domain) && domainMap.size >= MAX_TRACKED_DOMAINS_PER_TAB) {
    return;
  }

  const next = patchFn({ ...existing }, domain);
  domainMap.set(domain, next);
  schedulePersist();
}

function pickStatusForCompleted(statusCode) {
  if (statusCode >= 200 && statusCode < 300) return "ok";
  if (statusCode >= 300 && statusCode < 400) return "redirect";
  if (statusCode >= 400) return "error";
  return "pending";
}

function markDomainPending(tabId, hostname) {
  upsertDomainMeta(tabId, hostname, (meta) => {
    const incomingStatus = "pending";
    const shouldReplaceStatus = statusPriority(incomingStatus) >= statusPriority(meta.status);

    return {
      ...meta,
      status: shouldReplaceStatus ? incomingStatus : meta.status,
      lastStatusCode: meta.lastStatusCode || 0,
      hits: (meta.hits || 0) + 1,
      updatedAt: nowMs(),
    };
  });
}

function markDomainCompleted(tabId, hostname, statusCode) {
  const nextStatus = pickStatusForCompleted(Number(statusCode) || 0);

  upsertDomainMeta(tabId, hostname, (meta) => ({
    ...meta,
    status: nextStatus,
    lastStatusCode: Number(statusCode) || 0,
    hits: (meta.hits || 0) + 1,
    updatedAt: nowMs(),
  }));
}

function markDomainError(tabId, hostname) {
  upsertDomainMeta(tabId, hostname, (meta) => ({
    ...meta,
    status: "error",
    hits: (meta.hits || 0) + 1,
    updatedAt: nowMs(),
  }));
}

function serializeDomainEntriesForPopup(tabId) {
  const map = trackedDomainsByTab.get(tabId);
  if (!map) return [];

  const entries = [];
  for (const [domain, meta] of map.entries()) {
    entries.push({
      domain,
      status: meta.status || "pending",
      lastStatusCode: Number(meta.lastStatusCode) || 0,
      hits: Number(meta.hits) || 0,
      updatedAt: Number(meta.updatedAt) || 0,
    });
  }

  entries.sort((a, b) => a.domain.localeCompare(b.domain));
  return entries;
}

function restoreTabStoreEntry(tabId, value) {
  const domainMap = new Map();

  if (Array.isArray(value)) {
    // Backward compatibility: old format was ["domain1", "domain2"]
    for (const item of value) {
      const domain = normalizeHostname(item);
      if (!domain) continue;
      domainMap.set(domain, {
        status: "ok",
        lastStatusCode: 0,
        hits: 1,
        updatedAt: nowMs(),
      });
    }
    if (domainMap.size) trackedDomainsByTab.set(tabId, domainMap);
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [domainRaw, metaRaw] of Object.entries(value)) {
    const domain = normalizeHostname(domainRaw);
    if (!domain) continue;

    if (metaRaw && typeof metaRaw === "object") {
      domainMap.set(domain, {
        status: typeof metaRaw.status === "string" ? metaRaw.status : "pending",
        lastStatusCode: Number(metaRaw.lastStatusCode) || 0,
        hits: Number(metaRaw.hits) || 0,
        updatedAt: Number(metaRaw.updatedAt) || nowMs(),
      });
      continue;
    }

    // fallback for malformed entry
    domainMap.set(domain, {
      status: "pending",
      lastStatusCode: 0,
      hits: 0,
      updatedAt: nowMs(),
    });
  }

  if (domainMap.size) trackedDomainsByTab.set(tabId, domainMap);
}

async function loadFromSessionStore() {
  if (loadedFromSession) return;

  try {
    const raw = await chrome.storage.session.get(SESSION_KEY);
    const store = raw?.[SESSION_KEY];

    if (store && typeof store === "object") {
      for (const [tabIdStr, value] of Object.entries(store)) {
        const tabId = Number(tabIdStr);
        if (!Number.isInteger(tabId) || tabId < 0) continue;
        restoreTabStoreEntry(tabId, value);
      }
    }
  } catch {
    // ignore storage.session errors
  }

  loadedFromSession = true;
}

function ensureLoaded() {
  if (loadedFromSession) {
    return Promise.resolve();
  }
  if (!loadPromise) {
    loadPromise = loadFromSessionStore().finally(() => {
      loadPromise = null;
    });
  }
  return loadPromise;
}

function extractHostname(urlRaw) {
  try {
    const url = new URL(urlRaw);
    return url.hostname;
  } catch {
    return "";
  }
}

function handleBeforeRequest(details) {
  if (details.type === "main_frame") {
    clearTrackedDomainsForTab(details.tabId);
  }

  const hostname = extractHostname(details.url);
  if (!hostname) return;
  markDomainPending(details.tabId, hostname);
}

function handleCompleted(details) {
  const hostname = extractHostname(details.url);
  if (!hostname) return;
  markDomainCompleted(details.tabId, hostname, details.statusCode);
}

function handleError(details) {
  const hostname = extractHostname(details.url);
  if (!hostname) return;
  markDomainError(details.tabId, hostname);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (typeof details.tabId !== "number" || details.tabId < 0) return;

    if (loadedFromSession) {
      handleBeforeRequest(details);
      return;
    }

    void ensureLoaded().then(() => handleBeforeRequest(details));
  },
  { urls: ["<all_urls>"] },
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (typeof details.tabId !== "number" || details.tabId < 0) return;

    if (loadedFromSession) {
      handleCompleted(details);
      return;
    }

    void ensureLoaded().then(() => handleCompleted(details));
  },
  { urls: ["<all_urls>"] },
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (typeof details.tabId !== "number" || details.tabId < 0) return;

    if (loadedFromSession) {
      handleError(details);
      return;
    }

    void ensureLoaded().then(() => handleError(details));
  },
  { urls: ["<all_urls>"] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  if (loadedFromSession) {
    clearTrackedDomainsForTab(tabId);
    return;
  }

  void ensureLoaded().then(() => clearTrackedDomainsForTab(tabId));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "xkeen.getTrackedDomains") {
    return false;
  }

  const respond = () => {
    const tabId = Number(message.tabId);
    const domains = Number.isInteger(tabId) && tabId >= 0 ? serializeDomainEntriesForPopup(tabId) : [];
    sendResponse({ ok: true, domains });
  };

  if (loadedFromSession) {
    respond();
    return true;
  }

  void ensureLoaded().then(respond);
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureLoaded();
});

void ensureLoaded();
