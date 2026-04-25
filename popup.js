const DEFAULT_API_BASE = "http://192.168.28.1:1000";
const DEFAULT_ROUTING_PATH = "/opt/etc/xray/configs/05_routing.json";
const DEFAULT_INBOUND_TAGS = [];
const DEFAULT_OUTBOUND_TAG = "";
const DEFAULT_INCLUDE_ROOT_DOMAIN = false;
const AUTH_HINT = "Открой XKeen-UI и войди в панель, потом повтори действие.";
const CONFIG_CACHE_TTL_MS = 3000;
const SERVICE_STATUS_CACHE_TTL_MS = 1500;

const state = {
  activeTabId: -1,
  currentDomain: "",
  trackedDomains: [],
  selectedTrackedDomains: new Set(),
  availableInboundTags: [],
  availableOutboundTags: [],
};
let autoSaveTimerId = null;
const runtimeCache = {
  configsByApiBase: new Map(),
  serviceStatusByApiBase: new Map(),
};

const el = {
  currentDomain: document.getElementById("current-domain"),
  apiBase: document.getElementById("api-base"),
  listPath: document.getElementById("list-path"),
  inboundTag: document.getElementById("inbound-tag"),
  outboundTag: document.getElementById("outbound-tag"),
  includeRootDomain: document.getElementById("include-root-domain"),
  checkBtn: document.getElementById("check-btn"),
  restartBtn: document.getElementById("restart-btn"),
  addBtn: document.getElementById("add-btn"),
  removeBtn: document.getElementById("remove-btn"),
  addTrackedBtn: document.getElementById("add-tracked-btn"),
  selectAllTrackedBtn: document.getElementById("select-all-tracked-btn"),
  status: document.getElementById("status"),
  hint: document.getElementById("hint"),
  serviceStatus: document.getElementById("service-status"),
  trackedDomainsMeta: document.getElementById("tracked-domains-meta"),
  trackedDomains: document.getElementById("tracked-domains"),
};

function setStatus(status, hint = "") {
  el.status.textContent = status;
  el.hint.textContent = hint;
}

function setLoading(loading) {
  el.checkBtn.disabled = loading;
  el.restartBtn.disabled = loading;
  el.addBtn.disabled = loading;
  el.removeBtn.disabled = loading;
  el.addTrackedBtn.disabled = loading;
  el.selectAllTrackedBtn.disabled = loading;
}

function setServiceStatus(text) {
  el.serviceStatus.textContent = text;
}

function nowMs() {
  return Date.now();
}

function invalidateConfigCache(apiBase) {
  if (!apiBase) return;
  runtimeCache.configsByApiBase.delete(apiBase);
}

function setCachedServiceStatus(apiBase, status) {
  if (!apiBase) return;
  runtimeCache.serviceStatusByApiBase.set(apiBase, {
    status,
    at: nowMs(),
  });
}

function normalizeTrackedDomainItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];

  const items = [];
  for (const item of rawItems) {
    if (typeof item === "string") {
      const domain = toTag(item);
      if (!domain) continue;
      items.push({
        domain,
        status: "ok",
        hits: 0,
        lastStatusCode: 0,
      });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const domain = toTag(item.domain);
    if (!domain) continue;
    items.push({
      domain,
      status: toTag(item.status) || "pending",
      hits: Number(item.hits) || 0,
      lastStatusCode: Number(item.lastStatusCode) || 0,
    });
  }

  const statusRank = (status) => {
    const key = statusVisual(status).key;
    if (key === "error") return 0;
    if (key === "pending") return 1;
    if (key === "redirect") return 2;
    if (key === "ok") return 3;
    return 9;
  };

  items.sort((a, b) => {
    const rankDiff = statusRank(a.status) - statusRank(b.status);
    if (rankDiff !== 0) return rankDiff;
    return a.domain.localeCompare(b.domain);
  });
  return items;
}

function statusVisual(status) {
  switch (status) {
    case "ok":
      return { key: "ok", label: "OK" };
    case "redirect":
      return { key: "redirect", label: "Redirect" };
    case "error":
      return { key: "error", label: "Error" };
    default:
      return { key: "pending", label: "Pending" };
  }
}

function buildTrackedDomainsMeta(items, selectedCount) {
  const counters = {
    ok: 0,
    redirect: 0,
    error: 0,
    pending: 0,
  };

  for (const item of items) {
    const key = statusVisual(item.status).key;
    counters[key] += 1;
  }

  return `Найдено: ${items.length} | выбрано: ${selectedCount} | OK: ${counters.ok} | Redirect: ${counters.redirect} | Error: ${counters.error} | Pending: ${counters.pending}`;
}

function updateTrackedDomainsMetaAndToggle(metaText = "") {
  const items = state.trackedDomains;
  const selectedCount = state.selectedTrackedDomains.size;
  const allSelected = selectedCount > 0 && selectedCount === items.length;
  el.selectAllTrackedBtn.textContent = allSelected ? "Снять выбор" : "Выбрать все";
  el.trackedDomainsMeta.textContent = metaText || buildTrackedDomainsMeta(items, selectedCount);
}

function renderTrackedDomains(domainItems, metaText = "") {
  const items = normalizeTrackedDomainItems(domainItems);
  const selected = new Set(items.map((item) => item.domain).filter((domain) => state.selectedTrackedDomains.has(domain)));
  state.selectedTrackedDomains = selected;
  state.trackedDomains = items;

  el.trackedDomains.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "tracked-empty";
    empty.textContent = "Пока нет запросов";
    el.trackedDomains.appendChild(empty);
    el.selectAllTrackedBtn.textContent = "Выбрать все";
    el.trackedDomainsMeta.textContent = metaText || "Открой страницу и выполни сетевые запросы.";
    return;
  }

  for (const item of items) {
    const visual = statusVisual(item.status);
    const li = document.createElement("li");
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const text = document.createElement("span");
    const badge = document.createElement("span");

    label.className = "tracked-domain-row";
    label.classList.add(`req-${visual.key}`);
    text.className = "tracked-domain-text";
    badge.className = `tracked-domain-badge req-${visual.key}`;
    checkbox.type = "checkbox";
    checkbox.dataset.domain = item.domain;
    checkbox.checked = selected.has(item.domain);
    text.textContent = item.domain;
    badge.textContent = visual.label;

    label.appendChild(checkbox);
    label.appendChild(text);
    label.appendChild(badge);
    li.appendChild(label);
    el.trackedDomains.appendChild(li);
  }

  updateTrackedDomainsMetaAndToggle(metaText);
}

function getSelectedTrackedDomains() {
  return [...state.selectedTrackedDomains].sort((a, b) => a.localeCompare(b));
}

function toggleSelectAllTrackedDomains() {
  if (!state.trackedDomains.length) return;

  const selectedCount = state.selectedTrackedDomains.size;
  if (selectedCount === state.trackedDomains.length) {
    state.selectedTrackedDomains = new Set();
  } else {
    state.selectedTrackedDomains = new Set(state.trackedDomains.map((item) => item.domain));
  }

  const checkboxes = el.trackedDomains.querySelectorAll('input[type="checkbox"][data-domain]');
  checkboxes.forEach((checkbox) => {
    const domain = toTag(checkbox.dataset.domain);
    checkbox.checked = state.selectedTrackedDomains.has(domain);
  });
  updateTrackedDomainsMetaAndToggle();
}

function buildDomainLines(domains, options = {}) {
  const includeRootDomain = Boolean(options.includeRootDomain);
  const candidates = [];

  for (const raw of domains || []) {
    const normalized = normalizeDomain(raw);
    if (!normalized) continue;
    candidates.push(normalized);

    if (includeRootDomain) {
      const registrable = toRegistrableDomain(normalized);
      if (registrable) {
        candidates.push(registrable);
      }
    }
  }

  return uniqSortedTags(candidates).map(lineForDomain);
}

async function addDomainLinesForContext(ctx, domainLines) {
  const routingFile = await readRoutingFile(ctx.apiBase, ctx.routingPath);
  if (!routingFile.exists) {
    return {
      status: "Не найдено",
      hint: `Файл роутинга не найден: ${ctx.routingPath}`,
    };
  }

  const root = parseRoutingJson(routingFile.content);
  const rules = ensureRules(root, true);
  let changed = false;
  const rulesToInsert = [];

  for (const inboundTag of ctx.inboundTags) {
    const matched = findManagedRulesForInbound(rules, inboundTag, ctx.outboundTag);
    const existingInAny = new Set();
    for (const rule of matched) {
      for (const domain of getRuleDomains(rule)) {
        existingInAny.add(domain);
      }
    }

    const missingLines = domainLines.filter((line) => !existingInAny.has(line));
    if (!missingLines.length) {
      continue;
    }

    const newRule = {
      type: "field",
      comment: "xkeen-auto-domain",
      inboundTag: [inboundTag],
      outboundTag: ctx.outboundTag,
      domain: [...missingLines],
    };
    rulesToInsert.push(newRule);
    changed = true;
  }

  insertRulesBeforeEndField(rules, rulesToInsert);

  if (!changed) {
    return {
      status: "Уже есть",
      hint: `${buildRoutingHint(ctx)} | доменов: ${domainLines.length}`,
    };
  }

  await writeRoutingFile(ctx.apiBase, ctx.routingPath, serializeJson(root));
  return {
    status: "Добавлено",
    hint: `${buildRoutingHint(ctx)} | доменов: ${domainLines.length}`,
  };
}

function toApiBase(value) {
  const base = (value || "").trim() || DEFAULT_API_BASE;
  return base.replace(/\/+$/, "");
}

function toRoutingPath(value) {
  return (value || "").trim() || DEFAULT_ROUTING_PATH;
}

function toTag(value) {
  return (value || "").trim();
}

function uniqSortedTags(tags) {
  return [...new Set((tags || []).map(toTag).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function getSelectedValues(selectEl) {
  return uniqSortedTags(Array.from(selectEl.selectedOptions).map((option) => option.value));
}

function buildRoutingHint(ctx) {
  const domainMode = ctx.includeRootDomain ? "поддомен + корневой" : "поддомен";
  return `Файл роутинга: ${ctx.routingPath} | inboundTags: [${ctx.inboundTags.join(", ")}] | outboundTag: ${ctx.outboundTag} | домен: ${domainMode}`;
}

function setSavedSettingsStatus(prefix = "Сохранено") {
  const settings = getSettingsFromInputs();
  if (settings.inboundTags.length && settings.outboundTag) {
    setStatus(prefix, buildRoutingHint(toActionContext(settings)));
    return;
  }
  setStatus(prefix, "Выбери inboundTag (можно несколько) и outboundTag.");
}

function assertTagsSelected(settings) {
  if (!settings.inboundTags.length || !settings.outboundTag) {
    throw createError("missing_tags", "Выбери один или несколько inboundTag и один outboundTag.");
  }
}

function getSettingsFromInputs() {
  return {
    apiBase: toApiBase(el.apiBase.value),
    routingPath: toRoutingPath(el.listPath.value),
    inboundTags: getSelectedValues(el.inboundTag),
    outboundTag: toTag(el.outboundTag.value),
    includeRootDomain: Boolean(el.includeRootDomain.checked),
  };
}

function toActionContext(settings) {
  return {
    ...settings,
    routingPath: toRoutingPath(settings.routingPath),
    inboundTags: uniqSortedTags(settings.inboundTags),
    outboundTag: toTag(settings.outboundTag),
    includeRootDomain: Boolean(settings.includeRootDomain),
  };
}

async function saveSettingsToStorage(settings) {
  await chrome.storage.sync.set({
    apiBase: settings.apiBase,
    routingPath: settings.routingPath,
    inboundTags: settings.inboundTags,
    inboundTag: settings.inboundTags[0] || "",
    outboundTag: settings.outboundTag,
    includeRootDomain: Boolean(settings.includeRootDomain),
    listPath: settings.routingPath,
  });
}

function looksLikeHtml(text) {
  const sample = (text || "").trim().slice(0, 120).toLowerCase();
  return sample.startsWith("<!doctype html") || sample.startsWith("<html") || sample.includes("<body");
}

function createError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

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

function isIpAddress(host) {
  return isIPv4(host) || isIPv6(host);
}

function normalizeDomain(hostname) {
  if (!hostname) return "";
  let domain = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (domain.startsWith("www.")) {
    domain = domain.slice(4);
  }
  if (!domain || isIpAddress(domain)) {
    return "";
  }
  return domain;
}

function toRegistrableDomain(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return "";

  const labels = normalized.split(".").filter(Boolean);
  if (labels.length <= 2) {
    return normalized;
  }

  const commonSecondLevelSuffixes = new Set([
    "co.uk",
    "org.uk",
    "gov.uk",
    "ac.uk",
    "co.jp",
    "com.au",
    "net.au",
    "org.au",
    "co.nz",
    "com.br",
    "com.tr",
    "com.cn",
    "com.hk",
    "com.sg",
    "com.my",
    "co.id",
    "co.in",
    "firm.in",
    "net.in",
    "org.in",
    "gen.in",
    "ind.in",
    "co.kr",
    "or.kr",
    "ne.kr",
    "re.kr",
    "ac.kr",
    "co.il",
    "org.il",
    "gov.il",
    "ac.il",
    "com.mx",
    "com.ar",
    "com.ua",
    "co.za",
  ]);

  const lastTwo = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`;
  if (commonSecondLevelSuffixes.has(lastTwo) && labels.length >= 3) {
    return `${labels[labels.length - 3]}.${lastTwo}`;
  }

  return lastTwo;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) return null;
  return tabs[0];
}

function getDomainFromTab(tab) {
  if (!tab || !tab.url) return "";

  let parsed;
  try {
    parsed = new URL(tab.url);
  } catch {
    return "";
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    return "";
  }

  return normalizeDomain(parsed.hostname);
}

async function getActiveTabDomain(tab) {
  const activeTab = tab || (await getActiveTab());
  return getDomainFromTab(activeTab);
}

function lineForDomain(domain) {
  return `domain:${domain}`;
}

async function refreshTrackedDomainsForTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    state.trackedDomains = [];
    renderTrackedDomains([], "Текущая вкладка не определена.");
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "xkeen.getTrackedDomains",
      tabId,
    });

    const domains = normalizeTrackedDomainItems(response?.domains);
    renderTrackedDomains(domains);
  } catch {
    state.trackedDomains = [];
    renderTrackedDomains([], "Не удалось получить домены запросов.");
  }
}

async function getSettingsFromStorage() {
  const result = await chrome.storage.sync.get({
    apiBase: DEFAULT_API_BASE,
    routingPath: DEFAULT_ROUTING_PATH,
    listPath: DEFAULT_ROUTING_PATH,
    listPathTemplate: DEFAULT_ROUTING_PATH,
    inboundTags: DEFAULT_INBOUND_TAGS,
    inboundTag: "",
    outboundTag: DEFAULT_OUTBOUND_TAG,
    includeRootDomain: DEFAULT_INCLUDE_ROOT_DOMAIN,
  });

  const inboundTags = Array.isArray(result.inboundTags)
    ? uniqSortedTags(result.inboundTags)
    : uniqSortedTags([result.inboundTag]);

  return {
    apiBase: toApiBase(result.apiBase),
    routingPath: toRoutingPath(result.routingPath || result.listPath || result.listPathTemplate),
    inboundTags,
    outboundTag: toTag(result.outboundTag),
    includeRootDomain: Boolean(result.includeRootDomain),
  };
}

function setSingleSelectOptions(selectEl, values, selectedValue) {
  const unique = uniqSortedTags(values);
  selectEl.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = unique.length ? "Выбери тег" : "Теги не найдены";
  selectEl.appendChild(placeholder);

  for (const value of unique) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    selectEl.appendChild(option);
  }

  if (selectedValue && !unique.includes(selectedValue)) {
    const saved = document.createElement("option");
    saved.value = selectedValue;
    saved.textContent = `${selectedValue} (сохраненный)`;
    selectEl.appendChild(saved);
  }

  selectEl.value = selectedValue || "";
}

function setMultiSelectOptions(selectEl, values, selectedValues) {
  const unique = uniqSortedTags(values);
  const selectedSet = new Set(uniqSortedTags(selectedValues));
  selectEl.innerHTML = "";

  for (const value of unique) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = selectedSet.has(value);
    selectEl.appendChild(option);
  }

  for (const selected of selectedSet) {
    if (unique.includes(selected)) continue;
    const saved = document.createElement("option");
    saved.value = selected;
    saved.textContent = `${selected} (сохраненный)`;
    saved.selected = true;
    selectEl.appendChild(saved);
  }

  if (!selectEl.options.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Теги не найдены";
    empty.disabled = true;
    selectEl.appendChild(empty);
  }
}

function pushTags(targetSet, value) {
  if (Array.isArray(value)) {
    value.forEach((item) => pushTags(targetSet, item));
    return;
  }

  if (typeof value === "string") {
    const tag = toTag(value);
    if (tag) targetSet.add(tag);
  }
}

function collectTagsFromJson(value, inboundSet, outboundSet) {
  if (!value) return;

  if (Array.isArray(value)) {
    value.forEach((item) => collectTagsFromJson(item, inboundSet, outboundSet));
    return;
  }

  if (typeof value !== "object") return;

  if (Array.isArray(value.inbounds)) {
    value.inbounds.forEach((item) => {
      if (item && typeof item.tag === "string") {
        inboundSet.add(toTag(item.tag));
      }
    });
  }

  if (Array.isArray(value.outbounds)) {
    value.outbounds.forEach((item) => {
      if (item && typeof item.tag === "string") {
        outboundSet.add(toTag(item.tag));
      }
    });
  }

  if ("inboundTag" in value) {
    pushTags(inboundSet, value.inboundTag);
  }

  if ("outboundTag" in value) {
    pushTags(outboundSet, value.outboundTag);
  }

  Object.values(value).forEach((nested) => collectTagsFromJson(nested, inboundSet, outboundSet));
}

function flattenObjects(value, acc = []) {
  if (!value) return acc;
  if (Array.isArray(value)) {
    value.forEach((item) => flattenObjects(item, acc));
    return acc;
  }
  if (typeof value === "object") {
    acc.push(value);
    Object.values(value).forEach((item) => flattenObjects(item, acc));
  }
  return acc;
}

function pickString(obj, keys) {
  for (const key of keys) {
    if (typeof obj[key] === "string") {
      return { found: true, value: obj[key] };
    }
  }
  return { found: false, value: "" };
}

function extractConfigFiles(configResponse) {
  const objects = flattenObjects(configResponse);
  const filesMap = new Map();

  for (const obj of objects) {
    const pathRes = pickString(obj, ["path", "filePath", "file", "filename", "name"]);
    if (!pathRes.found || filesMap.has(pathRes.value)) continue;

    const contentRes = pickString(obj, ["content", "data", "text", "value", "body"]);
    if (!contentRes.found) continue;

    filesMap.set(pathRes.value, contentRes.value);
  }

  return filesMap;
}

function extractAvailableTagsFromFiles(files) {
  const inboundSet = new Set();
  const outboundSet = new Set();

  for (const [path, content] of files.entries()) {
    if (!path.endsWith(".json")) {
      continue;
    }

    try {
      const parsed = JSON.parse(content);
      collectTagsFromJson(parsed, inboundSet, outboundSet);
    } catch {
      continue;
    }
  }

  return {
    inboundTags: [...inboundSet].sort((a, b) => a.localeCompare(b)),
    outboundTags: [...outboundSet].sort((a, b) => a.localeCompare(b)),
  };
}

async function getConfigSnapshot(apiBase, options = {}) {
  const force = Boolean(options.force);
  const key = toApiBase(apiBase);
  const cached = runtimeCache.configsByApiBase.get(key);
  const current = nowMs();

  if (!force && cached && current - cached.at < CONFIG_CACHE_TTL_MS) {
    return cached;
  }

  const response = await apiRequest(key, "GET");
  if (!response.ok) {
    throw createError("request_failed", `Ошибка API: ${response.status}`);
  }

  const files = extractConfigFiles(response.data);
  const tags = extractAvailableTagsFromFiles(files);
  const snapshot = {
    at: current,
    files,
    tags,
  };

  runtimeCache.configsByApiBase.set(key, snapshot);
  return snapshot;
}

async function apiRequest(apiBase, method, body) {
  let response;
  try {
    response = await fetch(`${apiBase}/api/configs`, {
      method,
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw createError("connection", "Ошибка подключения");
  }

  if (response.status === 401 || response.status === 403) {
    throw createError("auth", "Ошибка авторизации");
  }

  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html") || looksLikeHtml(text)) {
    throw createError("auth", "Ошибка авторизации");
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function apiRequestPath(apiBase, path, method = "GET", body) {
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method,
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw createError("connection", "Ошибка подключения");
  }

  if (response.status === 401 || response.status === 403) {
    throw createError("auth", "Ошибка авторизации");
  }

  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html") || looksLikeHtml(text)) {
    throw createError("auth", "Ошибка авторизации");
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

function deepFindByKeys(value, keys) {
  if (!value) return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindByKeys(item, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (typeof value !== "object") return undefined;

  for (const key of keys) {
    if (key in value) {
      return value[key];
    }
  }

  for (const nested of Object.values(value)) {
    const found = deepFindByKeys(nested, keys);
    if (found !== undefined) return found;
  }

  return undefined;
}

function parseServiceStatus(data) {
  const candidate = deepFindByKeys(data, [
    "xkeenRunning",
    "xkeen_running",
    "running",
    "isRunning",
    "is_running",
    "active",
    "enabled",
    "serviceRunning",
    "service_running",
    "status",
  ]);

  if (typeof candidate === "boolean") {
    return candidate ? "Запущен" : "Остановлен";
  }

  if (typeof candidate === "number") {
    return candidate > 0 ? "Запущен" : "Остановлен";
  }

  if (typeof candidate === "string") {
    const value = candidate.trim().toLowerCase();
    if (["running", "run", "active", "started", "up", "on", "ok", "true", "1"].includes(value)) {
      return "Запущен";
    }
    if (["stopped", "stop", "inactive", "down", "off", "false", "0"].includes(value)) {
      return "Остановлен";
    }
  }

  return "Неизвестно";
}

async function refreshServiceStatus(options = {}) {
  const { apiBase } = getSettingsFromInputs();
  const force = Boolean(options.force);
  const cached = runtimeCache.serviceStatusByApiBase.get(apiBase);
  const current = nowMs();

  if (!force && cached && current - cached.at < SERVICE_STATUS_CACHE_TTL_MS) {
    setServiceStatus(cached.status);
    return;
  }

  const paths = ["/api/control", "/api/status"];
  let lastStatus = 0;

  for (const path of paths) {
    const resp = await apiRequestPath(apiBase, path, "GET");
    lastStatus = resp.status;
    if (!resp.ok) continue;
    const status = parseServiceStatus(resp.data);
    setServiceStatus(status);
    setCachedServiceStatus(apiBase, status);
    return;
  }

  if (lastStatus >= 500) {
    throw createError("connection", "Ошибка подключения");
  }

  setServiceStatus("Неизвестно");
  setCachedServiceStatus(apiBase, "Неизвестно");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestServiceRestart(apiBase) {
  const attempts = [
    { path: "/api/control/restart", method: "POST" },
    { path: "/api/control", method: "POST", body: { action: "restart" } },
    { path: "/api/control", method: "PUT", body: { action: "restart" } },
    { path: "/api/service/restart", method: "POST" },
    { path: "/api/restart", method: "POST" },
  ];

  let lastStatus = 0;
  for (const attempt of attempts) {
    const resp = await apiRequestPath(apiBase, attempt.path, attempt.method, attempt.body);
    lastStatus = resp.status;
    if (resp.ok) {
      return;
    }
    if (resp.status !== 404 && resp.status !== 405) {
      break;
    }
  }

  throw createError("request_failed", `Не удалось перезапустить сервис (API status: ${lastStatus || "n/a"})`);
}

async function refreshTagOptions(selectedInbounds = [], selectedOutbound = "", options = {}) {
  const settings = getSettingsFromInputs();
  const snapshot = await getConfigSnapshot(settings.apiBase, options);
  const tags = snapshot.tags;
  state.availableInboundTags = tags.inboundTags;
  state.availableOutboundTags = tags.outboundTags;

  const inboundValues = selectedInbounds.length ? selectedInbounds : getSelectedValues(el.inboundTag);
  const outboundValue = selectedOutbound || toTag(el.outboundTag.value);

  setMultiSelectOptions(el.inboundTag, state.availableInboundTags, inboundValues);
  setSingleSelectOptions(el.outboundTag, state.availableOutboundTags, outboundValue);
}

async function readRoutingFile(apiBase, routingPath) {
  const snapshot = await getConfigSnapshot(apiBase);
  const files = snapshot.files;
  if (!files.has(routingPath)) {
    return {
      exists: false,
      content: "",
    };
  }

  return {
    exists: true,
    content: files.get(routingPath),
  };
}

function parseRoutingJson(content) {
  try {
    return JSON.parse(content || "{}");
  } catch {
    throw createError("routing_parse", "Файл роутинга содержит некорректный JSON");
  }
}

function toTagArray(value) {
  if (Array.isArray(value)) {
    return uniqSortedTags(value);
  }
  if (typeof value === "string") {
    const single = toTag(value);
    return single ? [single] : [];
  }
  return [];
}

function matchesSingleInboundRule(rule, inboundTag, outboundTag) {
  if (!rule || typeof rule !== "object") return false;
  if (rule.type && rule.type !== "field") return false;

  const ruleInboundTags = toTagArray(rule.inboundTag);
  const ruleOutboundTags = toTagArray(rule.outboundTag);
  if (ruleInboundTags.length !== 1 || ruleInboundTags[0] !== inboundTag) return false;
  return ruleOutboundTags.includes(outboundTag);
}

function findRulesForInbound(rules, inboundTag, outboundTag) {
  if (!Array.isArray(rules)) return [];
  return rules.filter((rule) => matchesSingleInboundRule(rule, inboundTag, outboundTag));
}

function isManagedDomainRule(rule) {
  if (!rule || typeof rule !== "object") return false;
  if (isEndFieldRule(rule)) return false;

  const hasSpecialSelectors =
    "ip" in rule ||
    "port" in rule ||
    "network" in rule ||
    "protocol" in rule ||
    "source" in rule ||
    "sourcePort" in rule ||
    "sourceIp" in rule;
  if (hasSpecialSelectors) return false;

  const domains = getRuleDomains(rule);
  if (!domains.length) return false;
  return domains.every((line) => line.startsWith("domain:"));
}

function findManagedRulesForInbound(rules, inboundTag, outboundTag) {
  return findRulesForInbound(rules, inboundTag, outboundTag).filter(isManagedDomainRule);
}

function isEndFieldRule(rule) {
  if (!rule || typeof rule !== "object") return false;
  return typeof rule.comment === "string" && rule.comment.trim().toLowerCase() === "end field";
}

function insertRulesBeforeEndField(rules, newRules) {
  if (!newRules.length) return;
  const index = rules.findIndex((rule) => isEndFieldRule(rule));
  if (index === -1) {
    rules.push(...newRules);
    return;
  }
  rules.splice(index, 0, ...newRules);
}

function getRuleDomains(rule) {
  if (!rule || typeof rule !== "object") return [];

  if (Array.isArray(rule.domain)) {
    return rule.domain.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof rule.domain === "string") {
    const value = rule.domain.trim();
    return value ? [value] : [];
  }

  return [];
}

function setRuleDomains(rule, domains) {
  const unique = [...new Set(domains.map((item) => String(item).trim()).filter(Boolean))];
  rule.domain = unique;
}

function ensureRules(root, createIfMissing) {
  if (!root || typeof root !== "object") {
    throw createError("routing_parse", "Файл роутинга содержит некорректный JSON");
  }

  if (!root.routing || typeof root.routing !== "object") {
    if (!createIfMissing) return [];
    root.routing = {};
  }

  if (!Array.isArray(root.routing.rules)) {
    if (!createIfMissing) return [];
    root.routing.rules = [];
  }

  return root.routing.rules;
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeRoutingFile(apiBase, routingPath, content) {
  const payloads = [
    { path: routingPath, content },
    { filePath: routingPath, content },
    { file: routingPath, content },
    { name: routingPath, content },
    { config: { path: routingPath, content } },
  ];

  for (const payload of payloads) {
    const resp = await apiRequest(apiBase, "PUT", payload);
    if (resp.ok) {
      invalidateConfigCache(apiBase);
      return;
    }
  }

  throw createError("request_failed", "Не удалось обновить файл роутинга");
}

function scheduleAutoSave() {
  if (autoSaveTimerId) {
    clearTimeout(autoSaveTimerId);
  }

  autoSaveTimerId = setTimeout(async () => {
    try {
      const settings = getSettingsFromInputs();
      await saveSettingsToStorage(settings);
      setSavedSettingsStatus("Сохранено автоматически");
    } catch {
      // Автосохранение не должно блокировать основные операции.
    }
  }, 350);
}

async function performCheck() {
  if (!state.currentDomain) {
    setStatus("Не найдено", "Текущая вкладка не содержит поддерживаемый домен.");
    return;
  }

  const settings = getSettingsFromInputs();
  assertTagsSelected(settings);
  await saveSettingsToStorage(settings);

  const ctx = toActionContext(settings);
  const checkResult = await checkDomainRules(ctx);
  setStatus(checkResult.status, checkResult.hint);
  await refreshServiceStatus();
}

async function checkDomainRules(ctx) {
  const routingFile = await readRoutingFile(ctx.apiBase, ctx.routingPath);
  if (!routingFile.exists) {
    return {
      status: "Не найдено",
      hint: `Файл роутинга не найден: ${ctx.routingPath}`,
    };
  }

  const root = parseRoutingJson(routingFile.content);
  const rules = ensureRules(root, false);
  const lines = buildDomainLines([state.currentDomain], { includeRootDomain: ctx.includeRootDomain });
  const existsForAll = ctx.inboundTags.every((inboundTag) => {
    const matched = findManagedRulesForInbound(rules, inboundTag, ctx.outboundTag);
    return lines.every((line) => matched.some((rule) => getRuleDomains(rule).includes(line)));
  });

  return {
    status: existsForAll ? "Уже есть" : "Не найдено",
    hint: buildRoutingHint(ctx),
  };
}

async function performAdd() {
  if (!state.currentDomain) {
    setStatus("Не найдено", "Текущая вкладка не содержит поддерживаемый домен.");
    return;
  }

  const settings = getSettingsFromInputs();
  assertTagsSelected(settings);
  await saveSettingsToStorage(settings);

  const ctx = toActionContext(settings);
  const lines = buildDomainLines([state.currentDomain], { includeRootDomain: ctx.includeRootDomain });
  if (!lines.length) {
    setStatus("Не найдено", "Текущий домен не подходит для добавления.");
    await refreshServiceStatus();
    return;
  }

  const result = await addDomainLinesForContext(ctx, lines);
  setStatus(result.status, result.hint);
  await refreshServiceStatus();
}

async function performAddTrackedDomains() {
  const selectedDomains = getSelectedTrackedDomains();
  if (!selectedDomains.length) {
    setStatus("Не найдено", "Выбери домены запросов для добавления.");
    return;
  }

  const settings = getSettingsFromInputs();
  assertTagsSelected(settings);
  await saveSettingsToStorage(settings);

  const ctx = toActionContext(settings);
  const lines = buildDomainLines(selectedDomains, { includeRootDomain: ctx.includeRootDomain });
  if (!lines.length) {
    setStatus("Не найдено", "Нет доменов, подходящих для добавления.");
    await refreshServiceStatus();
    return;
  }

  const result = await addDomainLinesForContext(ctx, lines);
  setStatus(result.status, result.hint);
  await refreshServiceStatus();
}

async function performRemove() {
  if (!state.currentDomain) {
    setStatus("Не найдено", "Текущая вкладка не содержит поддерживаемый домен.");
    return;
  }

  const settings = getSettingsFromInputs();
  assertTagsSelected(settings);
  await saveSettingsToStorage(settings);

  const ctx = toActionContext(settings);
  const routingFile = await readRoutingFile(ctx.apiBase, ctx.routingPath);
  if (!routingFile.exists) {
    setStatus("Не найдено", `Файл роутинга не найден: ${ctx.routingPath}`);
    await refreshServiceStatus();
    return;
  }

  const root = parseRoutingJson(routingFile.content);
  const rules = ensureRules(root, false);
  const linesToRemove = new Set(buildDomainLines([state.currentDomain], { includeRootDomain: ctx.includeRootDomain }));
  if (!linesToRemove.size) {
    setStatus("Не найдено", "Текущий домен не подходит для удаления.");
    await refreshServiceStatus();
    return;
  }

  let removed = false;

  for (const inboundTag of ctx.inboundTags) {
    const matched = findManagedRulesForInbound(rules, inboundTag, ctx.outboundTag);
    for (const rule of matched) {
      const domains = getRuleDomains(rule);
      const filtered = domains.filter((item) => !linesToRemove.has(item));
      if (filtered.length !== domains.length) {
        removed = true;
        setRuleDomains(rule, filtered);
      }
    }
  }

  if (!removed) {
    setStatus("Не найдено", buildRoutingHint(ctx));
    await refreshServiceStatus();
    return;
  }

  await writeRoutingFile(ctx.apiBase, ctx.routingPath, serializeJson(root));
  setStatus("Удалено", buildRoutingHint(ctx));
  await refreshServiceStatus();
}

async function performRestartService() {
  const settings = getSettingsFromInputs();
  await saveSettingsToStorage(settings);

  await requestServiceRestart(settings.apiBase);
  setStatus("Перезапуск выполнен");

  await sleep(1200);
  await refreshServiceStatus({ force: true });
}

function mapOperationError(error) {
  if (error && error.code === "auth") {
    return { status: "Ошибка авторизации", hint: AUTH_HINT };
  }
  if (error && error.code === "missing_tags") {
    return { status: "Не найдено", hint: "Выбери inboundTag (можно несколько) и outboundTag." };
  }
  if (error && error.code === "routing_parse") {
    return { status: "Ошибка подключения", hint: error.message };
  }
  if (error && error.code === "request_failed") {
    return { status: "Ошибка подключения", hint: error.message || "Ошибка API" };
  }
  if (error && error.code === "connection") {
    return { status: "Ошибка подключения", hint: "" };
  }
  return { status: "Ошибка подключения", hint: "" };
}

async function runAction(handler) {
  setLoading(true);
  setStatus("Выполняется...");

  try {
    await handler();
  } catch (error) {
    const mapped = mapOperationError(error);
    setStatus(mapped.status, mapped.hint);
    if (mapped.status === "Ошибка авторизации") {
      setServiceStatus("Ошибка авторизации");
    } else if (mapped.status === "Ошибка подключения") {
      setServiceStatus("Ошибка подключения");
    }
  } finally {
    setLoading(false);
  }
}

async function initialize() {
  setServiceStatus("Проверка...");
  renderTrackedDomains([], "Загрузка...");
  const serviceStatusPromise = refreshServiceStatus().catch((error) => {
    const mapped = mapOperationError(error);
    if (mapped.status === "Ошибка авторизации") {
      setServiceStatus("Ошибка авторизации");
      return;
    }
    if (mapped.status === "Ошибка подключения") {
      setServiceStatus("Ошибка подключения");
      return;
    }
    setServiceStatus("Неизвестно");
  });

  const settings = await getSettingsFromStorage();
  el.apiBase.value = settings.apiBase;
  el.listPath.value = settings.routingPath;
  el.includeRootDomain.checked = Boolean(settings.includeRootDomain);

  setMultiSelectOptions(el.inboundTag, [], settings.inboundTags);
  setSingleSelectOptions(el.outboundTag, [], settings.outboundTag);
  const tagsPromise = refreshTagOptions(settings.inboundTags, settings.outboundTag, { force: true });
  const activeTabPromise = getActiveTab();
  await tagsPromise;
  const activeTab = await activeTabPromise;
  state.activeTabId = typeof activeTab?.id === "number" ? activeTab.id : -1;
  await refreshTrackedDomainsForTab(state.activeTabId);
  state.currentDomain = await getActiveTabDomain(activeTab);
  el.currentDomain.textContent = state.currentDomain || "Недоступно";

  if (!state.currentDomain) {
    setStatus("Не найдено", "Открой сайт с обычным HTTP/HTTPS-доменом.");
    await serviceStatusPromise;
    return;
  }

  if (settings.inboundTags.length && settings.outboundTag) {
    const ctx = toActionContext(settings);
    const checkResult = await checkDomainRules(ctx);
    setStatus(checkResult.status, checkResult.hint);
  } else {
    setStatus("Готово", "Выбери inboundTag (можно несколько) и outboundTag.");
  }

  await serviceStatusPromise;
}

el.apiBase.addEventListener("change", () =>
  runAction(async () => {
    await refreshTagOptions(getSelectedValues(el.inboundTag), toTag(el.outboundTag.value), { force: true });
    await saveSettingsToStorage(getSettingsFromInputs());
    setSavedSettingsStatus("Сохранено автоматически");
  }),
);
el.apiBase.addEventListener("input", scheduleAutoSave);
el.listPath.addEventListener("input", scheduleAutoSave);
el.inboundTag.addEventListener("change", scheduleAutoSave);
el.outboundTag.addEventListener("change", scheduleAutoSave);
el.includeRootDomain.addEventListener("change", scheduleAutoSave);
el.trackedDomains.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.type !== "checkbox") return;
  const domain = toTag(target.dataset.domain);
  if (!domain) return;

  if (target.checked) {
    state.selectedTrackedDomains.add(domain);
  } else {
    state.selectedTrackedDomains.delete(domain);
  }
  updateTrackedDomainsMetaAndToggle();
});
el.selectAllTrackedBtn.addEventListener("click", toggleSelectAllTrackedDomains);
el.addTrackedBtn.addEventListener("click", () => runAction(performAddTrackedDomains));
el.checkBtn.addEventListener("click", () => runAction(performCheck));
el.restartBtn.addEventListener("click", () => runAction(performRestartService));
el.addBtn.addEventListener("click", () => runAction(performAdd));
el.removeBtn.addEventListener("click", () => runAction(performRemove));

document.addEventListener("DOMContentLoaded", () => {
  runAction(initialize);
});
