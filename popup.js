const DEFAULT_API_BASE = "http://192.168.28.1:1000";
const DEFAULT_ROUTING_PATH = "/opt/etc/xray/configs/05_routing.json";
const DEFAULT_INBOUND_TAGS = [];
const DEFAULT_OUTBOUND_TAG = "";
const AUTH_HINT = "Открой XKeen-UI и войди в панель, потом повтори действие.";

const state = {
  currentDomain: "",
  availableInboundTags: [],
  availableOutboundTags: [],
};
let autoSaveTimerId = null;

const el = {
  currentDomain: document.getElementById("current-domain"),
  apiBase: document.getElementById("api-base"),
  listPath: document.getElementById("list-path"),
  inboundTag: document.getElementById("inbound-tag"),
  outboundTag: document.getElementById("outbound-tag"),
  checkBtn: document.getElementById("check-btn"),
  restartBtn: document.getElementById("restart-btn"),
  addBtn: document.getElementById("add-btn"),
  removeBtn: document.getElementById("remove-btn"),
  status: document.getElementById("status"),
  hint: document.getElementById("hint"),
  serviceStatus: document.getElementById("service-status"),
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
}

function setServiceStatus(text) {
  el.serviceStatus.textContent = text;
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
  return `Файл роутинга: ${ctx.routingPath} | inboundTags: [${ctx.inboundTags.join(", ")}] | outboundTag: ${ctx.outboundTag}`;
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
  };
}

function toActionContext(settings) {
  return {
    ...settings,
    routingPath: toRoutingPath(settings.routingPath),
    inboundTags: uniqSortedTags(settings.inboundTags),
    outboundTag: toTag(settings.outboundTag),
  };
}

async function saveSettingsToStorage(settings) {
  await chrome.storage.sync.set({
    apiBase: settings.apiBase,
    routingPath: settings.routingPath,
    inboundTags: settings.inboundTags,
    inboundTag: settings.inboundTags[0] || "",
    outboundTag: settings.outboundTag,
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

function lineForDomain(domain) {
  return `domain:${domain}`;
}

async function getActiveTabDomain() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) return "";

  const tab = tabs[0];
  if (!tab.url) return "";

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

async function getSettingsFromStorage() {
  const result = await chrome.storage.sync.get({
    apiBase: DEFAULT_API_BASE,
    routingPath: DEFAULT_ROUTING_PATH,
    listPath: DEFAULT_ROUTING_PATH,
    listPathTemplate: DEFAULT_ROUTING_PATH,
    inboundTags: DEFAULT_INBOUND_TAGS,
    inboundTag: "",
    outboundTag: DEFAULT_OUTBOUND_TAG,
  });

  const inboundTags = Array.isArray(result.inboundTags)
    ? uniqSortedTags(result.inboundTags)
    : uniqSortedTags([result.inboundTag]);

  return {
    apiBase: toApiBase(result.apiBase),
    routingPath: toRoutingPath(result.routingPath || result.listPath || result.listPathTemplate),
    inboundTags,
    outboundTag: toTag(result.outboundTag),
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

function extractAvailableTagsFromConfigs(configResponse) {
  const inboundSet = new Set();
  const outboundSet = new Set();
  const files = extractConfigFiles(configResponse);

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

async function refreshServiceStatus() {
  const { apiBase } = getSettingsFromInputs();
  const paths = ["/api/control", "/api/status"];
  let lastStatus = 0;

  for (const path of paths) {
    const resp = await apiRequestPath(apiBase, path, "GET");
    lastStatus = resp.status;
    if (!resp.ok) continue;
    setServiceStatus(parseServiceStatus(resp.data));
    return;
  }

  if (lastStatus >= 500) {
    throw createError("connection", "Ошибка подключения");
  }

  setServiceStatus("Неизвестно");
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

async function refreshTagOptions(selectedInbounds = [], selectedOutbound = "") {
  const settings = getSettingsFromInputs();
  const response = await apiRequest(settings.apiBase, "GET");
  if (!response.ok) {
    throw createError("request_failed", `Ошибка API: ${response.status}`);
  }

  const tags = extractAvailableTagsFromConfigs(response.data);
  state.availableInboundTags = tags.inboundTags;
  state.availableOutboundTags = tags.outboundTags;

  const inboundValues = selectedInbounds.length ? selectedInbounds : getSelectedValues(el.inboundTag);
  const outboundValue = selectedOutbound || toTag(el.outboundTag.value);

  setMultiSelectOptions(el.inboundTag, state.availableInboundTags, inboundValues);
  setSingleSelectOptions(el.outboundTag, state.availableOutboundTags, outboundValue);
}

async function readRoutingFile(apiBase, routingPath) {
  const response = await apiRequest(apiBase, "GET");
  if (!response.ok) {
    throw createError("request_failed", `Ошибка API: ${response.status}`);
  }

  const files = extractConfigFiles(response.data);
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
    if (resp.ok) return;
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
  const line = lineForDomain(state.currentDomain);
  const existsForAll = ctx.inboundTags.every((inboundTag) =>
    findRulesForInbound(rules, inboundTag, ctx.outboundTag).some((rule) => getRuleDomains(rule).includes(line)),
  );

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
  const routingFile = await readRoutingFile(ctx.apiBase, ctx.routingPath);
  if (!routingFile.exists) {
    setStatus("Не найдено", `Файл роутинга не найден: ${ctx.routingPath}`);
    await refreshServiceStatus();
    return;
  }

  const root = parseRoutingJson(routingFile.content);
  const rules = ensureRules(root, true);
  const line = lineForDomain(state.currentDomain);
  let changed = false;
  const rulesToInsert = [];

  for (const inboundTag of ctx.inboundTags) {
    const matched = findRulesForInbound(rules, inboundTag, ctx.outboundTag);
    const existsInMatched = matched.some((rule) => getRuleDomains(rule).includes(line));
    if (existsInMatched) {
      continue;
    }

    if (matched.length > 0) {
      const domains = getRuleDomains(matched[0]);
      domains.push(line);
      setRuleDomains(matched[0], domains);
      changed = true;
      continue;
    }

    rulesToInsert.push({
      type: "field",
      inboundTag: [inboundTag],
      outboundTag: ctx.outboundTag,
      domain: [line],
    });
    changed = true;
  }

  insertRulesBeforeEndField(rules, rulesToInsert);

  if (!changed) {
    setStatus("Уже есть", buildRoutingHint(ctx));
    await refreshServiceStatus();
    return;
  }

  await writeRoutingFile(ctx.apiBase, ctx.routingPath, serializeJson(root));
  setStatus("Добавлено", buildRoutingHint(ctx));
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
  const line = lineForDomain(state.currentDomain);

  let removed = false;

  for (const inboundTag of ctx.inboundTags) {
    const matched = findRulesForInbound(rules, inboundTag, ctx.outboundTag);
    for (const rule of matched) {
      const domains = getRuleDomains(rule);
      const filtered = domains.filter((item) => item !== line);
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
  await refreshServiceStatus();
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

  setMultiSelectOptions(el.inboundTag, [], settings.inboundTags);
  setSingleSelectOptions(el.outboundTag, [], settings.outboundTag);

  await refreshTagOptions(settings.inboundTags, settings.outboundTag);

  state.currentDomain = await getActiveTabDomain();
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
    await refreshTagOptions(getSelectedValues(el.inboundTag), toTag(el.outboundTag.value));
    await saveSettingsToStorage(getSettingsFromInputs());
    setSavedSettingsStatus("Сохранено автоматически");
  }),
);
el.apiBase.addEventListener("input", scheduleAutoSave);
el.listPath.addEventListener("input", scheduleAutoSave);
el.inboundTag.addEventListener("change", scheduleAutoSave);
el.outboundTag.addEventListener("change", scheduleAutoSave);
el.checkBtn.addEventListener("click", () => runAction(performCheck));
el.restartBtn.addEventListener("click", () => runAction(performRestartService));
el.addBtn.addEventListener("click", () => runAction(performAdd));
el.removeBtn.addEventListener("click", () => runAction(performRemove));

document.addEventListener("DOMContentLoaded", () => {
  runAction(initialize);
});
