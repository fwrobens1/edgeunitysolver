// ==UserScript==
// @name         answers — edgenuity / learnosity
// @namespace    local.answers
// @version      1.4.5
// @description  captures learnosity item traffic, caches correct answers, fills from cache or an ai endpoint, mobile + desktop panel, lockdown spoof
// @match        *://*.edgenuity.com/*
// @match        *://*.learnosity.com/*
// @match        *://*.il-apps.com/*
// @match        *://*.apexvs.com/*
// @match        *://*.apexlearning.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      100milionseek.top
// @connect      api.groq.com
// @connect      openrouter.ai
// @connect      generativelanguage.googleapis.com
// @connect      api.openai.com
// @connect      brainly.com
// @connect      brainly.in
// @connect      brainly.ro
// @connect      brainly.pl
// @connect      brainly.ph
// @connect      *
// @updateURL    https://raw.githubusercontent.com/fwrobens1/edgeunitysolver/main/edgyanswers.user.js
// @downloadURL  https://raw.githubusercontent.com/fwrobens1/edgeunitysolver/main/edgyanswers.user.js
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "1.4.5";
  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  // in the tampermonkey sandbox window.top and window are different proxies, so comparing the
  // page realm (unsafeWindow) is what tells the truth about the top frame
  const IS_TOP = (() => {
    try {
      if (!W.top) return true;
      if (W.top === W.self || W.top === W) return true;
      try { if (W.top.document === document) return true; } catch {}
      return false; // page realm says we are framed
    } catch {
      try { return window.top === window; } catch { return false; }
    }
  })();
  const DEFAULTS = {
    auto: false,
    ai: false,
    brainly: false,
    spoof: true,
    stealth: true,
    base: "https://100milionseek.top/v1",
    model: "deepseek-v4.1-flash-free",
    key: "",
    sniff: true,
    words: 100,
    autonext: false,
    pos: null,
    open: true,
    tab: "solve",
  };

  // region store
  const HAS_GM = typeof GM_getValue === "function" && typeof GM_setValue === "function";
  const store = {
    get(k, d) {
      try {
        if (HAS_GM) return GM_getValue(k, d);
        const raw = localStorage.getItem("ea:" + k);
        return raw == null ? d : JSON.parse(raw);
      } catch { return d; }
    },
    set(k, v) {
      try {
        if (HAS_GM) { GM_setValue(k, v); return; }
        localStorage.setItem("ea:" + k, JSON.stringify(v));
      } catch {}
    },
  };
  let cfg = Object.assign({}, DEFAULTS, store.get("cfg", {}) || {});
  const saveCfg = () => {
    const out = Object.assign({}, cfg);
    if (!out.key) delete out.key;   // never persist an empty key; a baked default can fill it
    store.set("cfg", out);
  };
  // endregion

  // region log
  const logs = [];
  function log(msg) {
    const line = new Date().toLocaleTimeString() + "  " + msg;
    logs.push(line);
    if (logs.length > 240) logs.shift();
    if (IS_TOP) { if (ui.renderLog) ui.renderLog(); }
    else { try { busUp({ ea: "log", msg }); } catch {} }
    try { console.log("[answers]", msg); } catch {}
  }
  // endregion

  // region utils
  const norm = (s) => String(s == null ? "" : s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const textOf = (s) => String(s == null ? "" : s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  };

  const tokens = (s) => new Set(norm(s).split(" ").filter(Boolean));
  function sim(a, b) {
    const A = tokens(a), B = tokens(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
  }

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const visible = (el) => {
    try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; }
  };

  // the editors on edgenuity sit in same-origin iframes and shadow roots; document.querySelectorAll stops at both
  let rootsCache = null, rootsAt = 0;
  function roots() {
    if (rootsCache && Date.now() - rootsAt < 800) return rootsCache;
    const list = [document];
    for (let i = 0; i < list.length && list.length < 24; i++) {
      let els;
      try { els = list[i].querySelectorAll("*"); } catch { continue; }
      for (const el of els) {
        try {
          if (el.shadowRoot) list.push(el.shadowRoot);
          if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
            const d = el.contentDocument;
            if (d) list.push(d);
          }
        } catch {}
      }
    }
    rootsCache = list;
    rootsAt = Date.now();
    return list;
  }

  function qAll(sel, onlyVisible) {
    const out = [];
    let own = null;
    try { own = ui && ui.host && ui.host.shadowRoot; } catch {}
    for (const r of roots()) {
      if (own && r === own) continue;
      let hits;
      try { hits = r.querySelectorAll(sel); } catch { continue; }
      for (const el of hits) {
        if (onlyVisible && !visible(el)) continue;
        out.push(el);
        if (out.length > 300) return out;
      }
    }
    return out;
  }
  // endregion

  // region net
  function req(opts) {
    return new Promise((resolve, reject) => {
      const method = opts.method || "GET";
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method,
          url: opts.url,
          headers: opts.headers || {},
          data: opts.data,
          timeout: opts.timeout || 25000,
          onload: (r) => resolve({ status: r.status, text: r.responseText || "" }),
          onerror: () => reject(new Error("network error")),
          ontimeout: () => reject(new Error("timeout")),
        });
        return;
      }
      fetch(opts.url, { method, headers: opts.headers, body: opts.data })
        .then(async (r) => resolve({ status: r.status, text: await r.text() }))
        .catch(reject);
    });
  }
  // endregion

  // region bank
  const BANK_CAP = 4000;
  let bank = store.get("bank", {}) || {};
  let bankTimer = 0;
  function flushBank() {
    clearTimeout(bankTimer);
    bankTimer = setTimeout(() => store.set("bank", bank), 400);
  }
  function bankSize() { return Object.keys(bank).length; }
  function bankPut(item, ans) {
    const key = hash(norm(item.stem));
    bank[key] = {
      q: textOf(item.stem).slice(0, 400),
      opts: item.options.map((o) => textOf(o.text).slice(0, 200)),
      ans,
      ts: Date.now(),
    };
    const keys = Object.keys(bank);
    if (keys.length > BANK_CAP) {
      keys.sort((a, b) => (bank[a].ts || 0) - (bank[b].ts || 0));
      for (const k of keys.slice(0, keys.length - BANK_CAP)) delete bank[k];
    }
    flushBank();
  }
  function bankGet(item) {
    const exact = bank[hash(norm(item.stem))];
    if (exact && exact.ans) return exact.ans;
    let best = null, bestScore = 0;
    for (const k in bank) {
      const e = bank[k];
      if (!e || !e.ans) continue;
      const s = sim(e.q, item.stem);
      if (s > bestScore) { bestScore = s; best = e; }
    }
    return bestScore >= 0.85 ? best.ans : null;
  }
  function bankImport(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("not valid json"); }
    const rows = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [];
    let added = 0;
    for (const r of rows.slice(0, 5000)) {
      const q = r.stem || r.question || r.q;
      const a = r.answer || r.a;
      if (!q || a == null) continue;
      const stem = textOf(q);
      bank[hash(norm(stem))] = {
        q: stem.slice(0, 400),
        opts: Array.isArray(r.options) ? r.options.map((o) => textOf(typeof o === "string" ? o : o.text || o.label || "")) : [],
        ans: Array.isArray(a) ? { picks: a.map((x) => ({ text: textOf(x) })) } : { text: textOf(a) },
        ts: Date.now(),
      };
      added++;
    }
    flushBank();
    return added;
  }
  function bankExport() {
    return JSON.stringify(Object.values(bank).map((e) => ({ question: e.q, answer: e.ans && e.ans.text ? e.ans.text : (e.ans && e.ans.picks ? e.ans.picks.map((p) => p.text).join(" | ") : "") })), null, 2);
  }
  // endregion

  // region item extraction
  const MAX_ITEMS = 12;
  function optionText(o) {
    if (typeof o === "string") return textOf(o);
    const label = textOf(o.label != null ? o.label : o.title != null ? o.title : "");
    const val = textOf(o.content != null ? o.content : o.value != null ? o.value : o.text != null ? o.text : "");
    if (o.content != null) return val;
    if (label && !/^\d+$/.test(label) && label.length > 1) return label;
    if (val && !/^\d+$/.test(val)) return val;
    return label || val;
  }
  function optList(q, holder) {
    const cands = [q.options, q.choices, q.answers, holder.options, holder.choices];
    for (const c of cands) {
      if (!Array.isArray(c) || c.length < 2 || c.length > 12) continue;
      if (c.every((o) => typeof o === "string" || (o && typeof o === "object"))) return c;
    }
    return [];
  }
  function extractItems(json) {
    const out = [];
    const seen = new Set();
    const push = (q, holder) => {
      if (out.length >= MAX_ITEMS) return;
      const opts = optList(q, holder);
      const stem = textOf(
        q.stimulus || q.stem || q.content || q.prompt || q.questionText || q.text ||
        holder.stimulus || holder.content || holder.prompt || holder.questionText ||
        (typeof holder.text === "string" ? holder.text : "")
      );
      if (!stem || opts.length < 2) return;
      const ref = String(q.response_id || q.reference || q.id || q.itemId || holder.reference || holder.id || "");
      const sig = ref + "|" + norm(stem);
      if (seen.has(sig)) return;
      seen.add(sig);
      out.push({
        ref: String(q.response_id || q.reference || q.id || q.itemId || holder.reference || ""),
        type: String(q.type || holder.type || "mcq"),
        stem,
        options: opts.slice(0, 12).map((o) => ({
          label: typeof o === "string" ? o : String(o.label != null ? o.label : o.value != null ? o.value : o.id != null ? o.id : ""),
          text: optionText(o),
        })),
      });
    };
    const visit = (node, depth) => {
      if (!node || depth > 7 || out.length >= MAX_ITEMS) return;
      if (Array.isArray(node)) { for (const n of node) visit(n, depth + 1); return; }
      if (typeof node !== "object") return;
      if (Array.isArray(node.questions)) for (const q of node.questions) push(q, node);
      else if (Array.isArray(node.options) && typeof node.type === "string") push(node, node);
      else if (Array.isArray(node.choices) && (node.prompt || node.questionText || node.stem)) push(node, node);
      for (const k in node) visit(node[k], depth + 1);
    };
    try { visit(json, 0); } catch {}
    return out;
  }
  // endregion

  // region capture
  const ITEM_URL = /^https:\/\/(questions|items)\.learnosity\.com\/v\d{4}\.\d+\.LTS(\/|$)/;
  const VERDICT_URL = /questionresponses/i;
  const MAYBE_ITEM = /learnosity|il-apps|\/api\/|lmsapi|item|question|assess|activity|task|guide|data\.cw|\/data\//i;
  let lastItem = null;
  let remoteItem = null;
  let remoteRefs = "";
  const pendingVerdicts = [];
  const autoFilled = new Set();
  const sniffSeen = new Set();
  let jsonTries = 0;

  function autoFill(item) {
    const key = (item.ref || "") + "|" + norm(item.stem);
    if (autoFilled.has(key)) return;
    autoFilled.add(key);
    fillOrFetch(item, 0);
  }

  function isItemRequest(url) { return ITEM_URL.test(String(url || "")); }
  function isVerdictRequest(url) { return VERDICT_URL.test(String(url || "")); }

  function bodyText(body) {
    try {
      if (typeof body === "string") return body;
      if (body instanceof URLSearchParams || body instanceof FormData) return body.toString();
      return "";
    } catch { return ""; }
  }

  function hostPath(url) {
    try { const u = new URL(url, location.href); return u.host + u.pathname; } catch { return String(url || "").slice(0, 90); }
  }

  function sniffLog(method, url, status, len) {
    if (!cfg.sniff) return;
    const key = method + " " + url + " " + status;
    if (sniffSeen.has(key) || sniffSeen.size > 90) return;
    sniffSeen.add(key);
    log("net " + method + " " + hostPath(url) + " -> " + status + " " + (len > 1024 ? Math.round(len / 1024) + "KB" : len + "B"));
  }

  function parseMaybe(text) {
    if (typeof text !== "string" || !text) return null;
    let t = text.trim();
    if (t.startsWith(")]}'")) t = t.replace(/^\)\]\}',?\s*/, "");
    if (t[0] !== "{" && t[0] !== "[") return null;
    try { return JSON.parse(t); } catch { return null; }
  }

  function ingest(items, url) {
    for (const it of items) {
      if (!bank[hash(norm(it.stem))]) bankPut(it, null);
      lastItem = it;
    }
    log("item captured: " + items.length + " · " + hostPath(url) + " · " + items[0].stem.slice(0, 60));
    busUp({ ea: "item", n: items.length, stem: items[0].stem.slice(0, 90), item: items[items.length - 1] });
    if (cfg.auto) for (const it of items) autoFill(it);
  }

  function onItemResponse(url, text) {
    if (!text || text.length > 4000000) return;
    const parsed = parseMaybe(text);
    if (!parsed) return;
    const items = extractItems(parsed);
    if (items.length) ingest(items, url);
  }

  function scanResponse(url, text) {
    if (!MAYBE_ITEM.test(String(url || ""))) return;
    if (jsonTries > 80) return;
    jsonTries++;
    onItemResponse(url, text);
  }

  function collectValues(node, out, depth) {
    if (depth > 6 || out.length > 12) return;
    if (node == null) return;
    if (["string", "number", "boolean"].includes(typeof node)) { out.push(node); return; }
    if (Array.isArray(node)) { for (const n of node) collectValues(n, out, depth + 1); return; }
    if (typeof node === "object") {
      for (const k in node) {
        if (/response|answer|value|option|choice/i.test(k)) collectValues(node[k], out, depth + 1);
      }
    }
  }

  function resolvePicks(item, rawValues) {
    const picks = [];
    for (const raw of rawValues) {
      const s = String(raw);
      let o = item.options.find((x) => x.label === s);
      if (!o) o = item.options.find((x) => norm(x.text) === norm(s));
      if (!o && /^\d+$/.test(s)) o = item.options[Number(s)];
      if (o && !picks.includes(o)) picks.push(o);
    }
    return picks;
  }

  function learnFromVerdict(item, sentBody, responseText) {
    if (!item) return;
    let resp;
    try { resp = JSON.parse(responseText || "{}"); } catch { return; }
    const score = resp.score != null ? resp.score : (resp.meta && resp.meta.score);
    const correct = score != null ? Number(score) >= 1 : resp.correct === true;
    if (!correct) return;
    let sent;
    try { sent = JSON.parse(sentBody || "{}"); } catch { sent = null; }
    const values = [];
    if (sent) collectValues(sent, values, 0);
    else if (sentBody) for (const v of new URLSearchParams(sentBody).values()) values.push(v);
    const picks = resolvePicks(item, values);
    if (picks.length) {
      bankPut(item, { picks: picks.map((p) => ({ text: p.text })) });
      log("learned answer for: " + item.stem.slice(0, 48));
      busUp({ ea: "verdict", ok: true });
    } else if (values.length === 1 && typeof values[0] === "string" && values[0].length < 200) {
      bankPut(item, { text: values[0] });
      log("learned text answer");
      busUp({ ea: "verdict", ok: true });
    }
  }

  function onVerdict(url, text, sentBody) {
    const p = pendingVerdicts.shift();
    learnFromVerdict((p && p.item) || lastItem, (p && p.body) || sentBody, text);
  }

  function hookXHR(win) {
    const proto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    if (!proto || proto.__ea) return;
    proto.__ea = true;
    const open = proto.open, send = proto.send;
    proto.open = function (m, u) {
      try { this.__ea_url = String(u); this.__ea_method = m; } catch {}
      return open.apply(this, arguments);
    };
    proto.send = function (body) {
      const url = this.__ea_url || "";
      const method = this.__ea_method || "GET";
      try {
        if (isVerdictRequest(url)) {
          pendingVerdicts.push({ item: lastItem, body: bodyText(body) });
          if (pendingVerdicts.length > 4) pendingVerdicts.shift();
        }
        this.addEventListener("loadend", () => {
          let text = "", len = 0, status = 0;
          try { text = this.responseText || ""; len = text.length; status = this.status; } catch {}
          try { sniffLog(method, url, status, len); } catch {}
          try {
            if (isItemRequest(url)) onItemResponse(url, text);
            else if (isVerdictRequest(url)) onVerdict(url, text, bodyText(body));
            else scanResponse(url, text);
          } catch (e) { log("scan: " + e.message); }
        }, { once: true });
      } catch {}
      return send.apply(this, arguments);
    };
  }

  function hookFetch(win) {
    const orig = win.fetch;
    if (!orig || orig.__ea) return;
    const wrapped = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = (init && init.method) || (input && input.method) || "GET";
      const out = orig.apply(this, arguments);
      try {
        if (isVerdictRequest(url)) {
          pendingVerdicts.push({ item: lastItem, body: bodyText(init && init.body) });
          if (pendingVerdicts.length > 4) pendingVerdicts.shift();
        }
        out.then((r) => r.clone().text().then((t) => {
          try { sniffLog(method, url, r.status, t.length); } catch {}
          try {
            if (isItemRequest(url)) onItemResponse(url, t);
            else if (isVerdictRequest(url)) onVerdict(url, t, init && init.body);
            else scanResponse(url, t);
          } catch {}
        }).catch(() => {})).catch(() => {});
      } catch {}
      return out;
    };
    wrapped.__ea = true;
    win.fetch = wrapped;
  }

  try { hookXHR(W); hookFetch(W); } catch (e) { log("hook failed: " + e.message); }
  // endregion

  // region fill
  let lastFillAt = 0;
  const answered = new Map(); // itemKey -> when the click landed, so advance can prove the page is done
  const itemKey = (it) => it.type + "|" + norm(it.stem);

  function optionNodes() {
    const out = [];
    for (const [, opts] of allGroups()) for (const o of opts) out.push({ node: o.node, text: o.text });
    return out;
  }

  function clickNode(n) {
    try {
      n.scrollIntoView({ block: "center" });
      n.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      n.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      n.click();
    } catch { try { n.click(); } catch {} }
  }

  function setEditable(el, val) {
    const doc = el.ownerDocument || document;
    el.focus();
    try {
      const sel = doc.getSelection && doc.getSelection();
      if (sel) {
        const range = doc.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        if (doc.execCommand && doc.execCommand("insertText", false, val)) return;
      }
    } catch {}
    el.textContent = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function setFieldValue(el, val) {
    if (el.isContentEditable) { setEditable(el, val); return; }
    const proto = el instanceof W.HTMLTextAreaElement ? W.HTMLTextAreaElement.prototype
      : el instanceof W.HTMLInputElement ? W.HTMLInputElement.prototype
      : W.HTMLElement.prototype;
    try {
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, val); else el.value = val;
    } catch { el.value = val; }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function textFields() {
    const sel = 'textarea,input[type="text"],input:not([type]),[contenteditable="true"],[contenteditable=""],[contenteditable]:not([contenteditable="false"])';
    return qAll(sel, true);
  }

  // the writing box on edgenuity is a rich editor, not a plain input
  function openFields() {
    const sel = 'textarea,[contenteditable="true"],[contenteditable=""],[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
    return qAll(sel, true).filter((el) => !el.closest('[aria-hidden="true"]'));
  }

  function fieldArea(el) {
    try { const r = el.getBoundingClientRect(); return r.width * r.height; } catch { return 0; }
  }

  function applyAnswer(item, ans) {
    if (!ans) return false;
    if (ans.picks && ans.picks.length) {
      const nodes = optionNodes();
      if (!nodes.length) return false;
      let hit = 0;
      for (const p of ans.picks) {
        const want = norm(p.text);
        if (!want) continue;
        const n = nodes.find((x) => norm(x.text) === want)
          || nodes.find((x) => norm(x.text).includes(want) || want.includes(norm(x.text)));
        if (n) { clickNode(n.node); hit++; }
      }
      if (hit) { lastFillAt = Date.now(); answered.set(itemKey(item), Date.now()); try { busUp({ ea: "answered", key: itemKey(item) }); } catch {} log("filled " + hit + " option(s)"); }
      return hit > 0;
    }
    if (ans.text) {
      const open = openFields().sort((a, b) => fieldArea(b) - fieldArea(a));
      const fields = open.length ? open : textFields();
      if (!fields.length) return false;
      setFieldValue(fields[0], ans.text);
      lastFillAt = Date.now();
      answered.set(itemKey(item), Date.now());
      try { busUp({ ea: "answered", key: itemKey(item) }); } catch {}
      log("filled text answer");
      return true;
    }
    return false;
  }

  function fillOrFetch(item, depth) {
    if (!item) return;
    if (item.answered && item.options && item.options.length) {
      // a selection is already sitting there — never flip it on a revisit
      answered.set(itemKey(item), Date.now());
      return;
    }
    const cached = bankGet(item);
    if (cached) { applyAnswer(item, cached); return; }
    const open = !item.options || item.options.length === 0;
    if (open) {
      if (!cfg.ai) { log("open response — turn on use ai to write it"); return; }
      const t0 = Date.now();
      log("writing for: " + item.stem.slice(0, 44));
      aiWrite(item).then((text) => {
        const ok = applyAnswer(item, { text });
        if (!ok) { log("wrote it but found no box to put it in"); return; }
        bankPut(item, { text });
        log("wrote " + text.split(/\s+/).filter(Boolean).length + " words in " + (Date.now() - t0) + "ms");
      }).catch((e) => log("ai write failed: " + e.message));
      return;
    }
    if (cfg.ai) aiAnswer(item).then((ans) => {
      if (ans) { applyAnswer(item, ans); bankPut(item, ans); }
    }).catch((e) => log("ai: " + e.message));
    else if (cfg.brainly && depth === 0) {
      brainlyAnswer(item).then((ans) => { if (ans) { applyAnswer(item, ans); bankPut(item, ans); } }).catch(() => {});
    }
  }
  // endregion

  // region dom capture
  // the item payload often lands before the hook exists, and open-response activities never
  // send one at all, so the visible question is the source of truth when the net is quiet.
  const UI_NOISE = /^(read more|show more|show less|hide|expand|collapse|prompt|next|previous|back|submit|save|save and exit|check answer|try again|skip|please select the best answer from the choices provided|select the best answer from the choices provided|select the best answer|choose the best answer|mark this and return|show me|show answer|review|flag)[\s»>….:!]*$/i;
  const domKeys = new Set();

  function cleanText(s) {
    return String(s || "")
      .replace(/\u00a0/g, " ")
      .split(/\n+/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => l && !UI_NOISE.test(l))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function promptFor(el) {
    let cur = el;
    for (let d = 0; d < 9 && cur; d++) {
      cur = cur.parentElement;
      if (!cur) break;
      const parts = [];
      for (const sib of cur.children) {
        if (sib === el || sib.contains(el)) continue;
        if (sib.querySelector("textarea,[contenteditable=true],[role=radio],input,button,a,[role=button],select")) continue;
        const t = cleanText(sib.innerText || sib.textContent || "");
        if (t.length > 3 && t.length < 1500) parts.push(t);
      }
      const joined = cleanText(parts.join(" "));
      if (joined.length >= 15) return joined.slice(0, 1500);
    }
    return "";
  }

  function promptDeep(el) {
    const local = promptFor(el);
    if (local) return local;
    let doc = el.ownerDocument;
    for (let d = 0; d < 4 && doc && doc !== document; d++) {
      let fe = null;
      try { fe = doc.defaultView && doc.defaultView.frameElement; } catch {}
      if (!fe) break;
      const p = promptFor(fe);
      if (p) return p;
      doc = fe.ownerDocument;
    }
    return "";
  }

  // styled radios hide the real input (opacity 0, 1px, or display:none), so the node itself is
  // never the visibility gate - the group container is.
  const CHOICE_SEL = '[role="radio"],[role="checkbox"],[role="option"],input[type="radio"],input[type="checkbox"]';

  function optionLabel(n) {
    let box = null;
    try { box = n.closest('label,[role="radio"],[role="checkbox"],[role="option"],li'); } catch {}
    if (!box) box = n.parentElement || n;
    const raw = (box.innerText || "") || n.getAttribute("aria-label") || n.value || "";
    // letters get reshuffled between attempts; the text is the only stable handle
    return cleanText(raw).replace(/^[a-hA-H][.)]\s+/, "");
  }

  function radioGroup(node) {
    const name = node.getAttribute && node.getAttribute("name");
    if (name) {
      let cur = node.parentElement;
      for (let d = 0; d < 6 && cur; d++) {
        let same = [];
        try { same = cur.querySelectorAll('input[name="' + CSS.escape(name) + '"]'); } catch {}
        if (same.length >= 2) return cur;
        cur = cur.parentElement;
      }
    }
    // tightest ancestor holding two choices: works for role=radio rows and label-wrapped inputs
    let cur = node.parentElement;
    for (let d = 0; d < 6 && cur; d++) {
      let same = [];
      try { same = cur.querySelectorAll(CHOICE_SEL); } catch {}
      if (same.length >= 2) return cur;
      cur = cur.parentElement;
    }
    let g = null;
    try { g = node.closest('[role="radiogroup"],[role="group"],fieldset,ul,ol'); } catch {}
    return g || node.parentElement;
  }

  function choiceGroups() {
    const map = new Map();
    for (const n of qAll(CHOICE_SEL, false)) {
      try { if (n.closest('[aria-hidden="true"]')) continue; } catch {}
      const g = radioGroup(n);
      if (!g || !visible(g)) continue;
      const text = optionLabel(n);
      if (!text) continue;
      let hit = n;
      try { hit = n.closest("label") || n; } catch {}
      if (!map.has(g)) map.set(g, []);
      const arr = map.get(g);
      if (arr.some((o) => o.text === text)) continue;
      arr.push({ node: hit, text });
    }
    for (const [g, arr] of [...map]) if (arr.length < 2 || arr.length > 12) map.delete(g);
    return map;
  }

  // no input at all: the choices are plain clickable rows, so group short-text siblings
  function textGroups() {
    const map = new Map();
    const cands = qAll('label,li,[role="option"],[class*="answer"],[class*="choice"],[class*="option"]', true);
    for (const el of cands) {
      try { if (el.closest('[aria-hidden="true"]')) continue; } catch {}
      if (el.querySelector("input,textarea,select,[contenteditable]")) continue;
      if (el.querySelector("button,a")) continue;
      const t = cleanText(el.innerText || "");
      if (!t || t.length > 160) continue;
      const p = el.parentElement;
      if (!p || !visible(p)) continue;
      const tags = String(p.className || "") + " " + (p.getAttribute("role") || "");
      if (/nav|menu|tab|header|footer|breadcrumb|pagination|toolbar/i.test(tags)) continue;
      if (!map.has(p)) map.set(p, []);
      const arr = map.get(p);
      if (arr.some((o) => o.text === t)) continue;
      arr.push({ node: el, text: t });
    }
    for (const [p, arr] of [...map]) if (arr.length < 2 || arr.length > 12) map.delete(p);
    return map;
  }

  function allGroups() {
    const g = choiceGroups();
    if (g.size) return g;
    return textGroups();
  }

  // ground truth lives in the DOM, not in whichever realm clicked: the shell and the activity
  // frame each hold their own state, and only the checked input tells both of them the same truth
  function groupAnswered(nodes) {
    for (const o of nodes) {
      const n = o.node;
      try {
        if (n.matches && n.matches("input") && n.checked) return true;
        if (n.querySelector && n.querySelector('input:checked')) return true;
        const rc = n.closest && n.closest('[aria-checked="true"],[aria-selected="true"]');
        if (rc) return true;
        const cls = String((n.className && n.className.baseVal) || n.className || "");
        if (/(^|[\s_-])(selected|checked|chosen|active|sel)([\s_-]|$)/i.test(cls)) return true;
      } catch {}
    }
    return false;
  }

  function fieldFilled(f) {
    try {
      const v = f.isContentEditable ? f.innerText : f.value;
      return String(v || "").trim().length > 0;
    } catch { return false; }
  }

  function domItems() {
    const out = [];
    const seen = new Set();
    for (const [g, nodes] of allGroups()) {
      const options = [];
      for (const n of nodes) options.push({ label: String(options.length), text: n.text });
      if (options.length < 2) continue;
      let stem = promptFor(g) || promptFor(nodes[0].node);
      if (!stem) {
        const anc = g.closest('[class*="question"],[class*="prompt"],[class*="item"],[class*="response"]');
        if (anc) {
          let t = cleanText(anc.innerText || "");
          for (const o of options) t = cleanText(t.split(o.text).join(" "));
          stem = t;
        }
      }
      if (stem.length < 8) continue;
      const k = "mcq|" + norm(stem);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ref: "", type: "mcq", stem, options: options.slice(0, 12), answered: groupAnswered(nodes) });
    }
    for (const f of openFields()) {
      if (f.tagName === "TEXTAREA" && fieldArea(f) < 3000) continue;
      const stem = promptDeep(f);
      if (stem.length < 12) continue;
      const k = "open|" + norm(stem);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ref: "", type: "open", stem, options: [], answered: fieldFilled(f) });
    }
    return out;
  }

  let lastDiagAt = 0;
  function domScan() {
    let list = [];
    try { list = domItems(); } catch { return []; }
    const fresh = [];
    for (const it of list) {
      const k = it.type + "|" + norm(it.stem);
      if (domKeys.has(k)) continue;
      domKeys.add(k);
      fresh.push(it);
    }
    if (fresh.length) ingest(fresh, "dom://" + location.host);
    else if (!domKeys.size && Date.now() - lastDiagAt > 12000) {
      lastDiagAt = Date.now();
      let groups = 0, choices = 0, boxes = 0;
      try { const gs = allGroups(); groups = gs.size; for (const [, o] of gs) choices += o.length; } catch {}
      try { boxes = openFields().length; } catch {}
      log("scan: " + choices + " choice(s) in " + groups + " group(s), " + boxes + " write box(es), " + roots().length + " root(s)");
    }
    return list;
  }

  function probeDom() {
    const rootsLen = roots().length;
    const gs = allGroups();
    const out = [];
    for (const [g, opts] of gs) {
      out.push({
        tag: g.tagName,
        cls: String(g.className || "").slice(0, 80),
        texts: opts.map((o) => o.text.slice(0, 40)),
      });
    }
    return { roots: rootsLen, inputs: qAll(CHOICE_SEL, false).length, groups: out };
  }

  function fillLocal() {
    if (!IS_TOP) busUp({ ea: "refs?" });
    const opened = expandToggles(3);
    const run = () => {
      let list = [];
      try { list = domScan(); } catch {}
      if (list.length) { for (const it of list) fillOrFetch(it, 0); return; }
      if (lastItem) { fillOrFetch(lastItem, 0); return; }
      if (remoteItem) { fillOrFetch(remoteItem, 0); return; }
      let boxes = 0;
      try { boxes = openFields().length; } catch {}
      if (boxes) log(boxes + " writing box(es) found, no prompt read");
      let kids = 0;
      try { kids = window.frames.length; } catch {}
      if (kids) busDown({ ea: "fill" });
      else if (!boxes) log("no question found — open the activity and let it load");
    };
    // the toggle needs a tick to swap the text in before we read it
    if (opened) setTimeout(run, 450); else run();
  }

  const MORE_RE = /^(read more|show more|see more|view more|more info|expand|show all|learn more)\b/i;

  // "Read More >>" is a plain click target that hides the actual instructions
  function expandToggles(max) {
    let n = 0;
    const els = document.querySelectorAll('a,button,[role="button"],summary,[onclick]');
    for (const el of els) {
      if (n >= (max || 3)) break;
      if (!visible(el)) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      // raw text here: cleanText() strips these exact labels as noise
      const t = String(el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 30 || !MORE_RE.test(t) || /less/i.test(t)) continue;
      try { el.click(); n++; } catch {}
    }
    if (n) log("expanded " + n + " collapsed section(s)");
    return n;
  }

  function pageContext(limit) {
    const main = document.querySelector('main,[role="main"],[class*="activity"],[class*="content-area"],[class*="assignment"]') || document.body;
    return cleanText(main.innerText || main.textContent || "").slice(0, limit || 2500);
  }

  // notes/transcript tabs are hidden panels, already in the DOM — read them without switching tabs
  function referenceText(limit) {
    const parts = [];
    let total = 0;
    for (const el of document.querySelectorAll('[role="tabpanel"],[class*="note"],[class*="transcript"],[class*="glossary"]')) {
      const t = cleanText(el.textContent || "");
      if (t.length < 60) continue;
      parts.push(t);
      total += t.length;
      if (total > (limit || 1500)) break;
    }
    return cleanText(parts.join(" ")).slice(0, limit || 1500);
  }

  let domTimer = 0;
  function kickDomScan() {
    if (domTimer) return;
    domTimer = setTimeout(() => { domTimer = 0; try { domScan(); } catch {} }, 500);
  }
  try {
    if (typeof MutationObserver === "function" && (document.body || document.documentElement)) {
      new MutationObserver(kickDomScan).observe(document.documentElement || document.body, { childList: true, subtree: true });
    }
    setInterval(() => { if (!document.hidden) { try { domScan(); } catch {} } }, 3000);
  } catch {}
  // endregion

  // region ai
  function aiPrompt(item) {
    const opts = item.options.map((o, i) => i + ". " + textOf(o.text)).join("\n");
    return "Answer this school question. Reply with ONLY compact JSON, no prose:\n" +
      '{"pick": <0-based option index, or null for short answer>, "text": "<short answer text or empty>", "why": "<6 words max>"}\n\n' +
      "Question:\n" + textOf(item.stem).slice(0, 1500) + "\n\nOptions:\n" + opts;
  }

  function parseAiJson(text) {
    let s = String(text || "").replace(/```[a-z]*|```/gi, "").trim();
    const first = s.indexOf("{"), last = s.lastIndexOf("}");
    if (first === -1 || last <= first) return null;
    const slice = s.slice(first, last + 1);
    try { return JSON.parse(slice); } catch {}
    try { return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1").replace(/'/g, '"')); } catch {}
    return null;
  }

  // the model answers with an index, a letter, or the option text itself, depending on the mood
  function resolvePick(parsed, item) {
    const raw = parsed.pick != null ? parsed.pick
      : parsed.answer != null ? parsed.answer
      : parsed.choice != null ? parsed.choice
      : parsed.index;
    if (raw == null) return -1;
    if (typeof raw === "number" && item.options[raw]) return raw;
    const s = String(raw).trim();
    if (/^\d+$/.test(s) && item.options[Number(s)]) return Number(s);
    const letter = s.match(/^([a-h])\s*[.):]?$/i);
    if (letter) {
      const i = letter[1].toLowerCase().charCodeAt(0) - 97;
      if (item.options[i]) return i;
    }
    const want = norm(s);
    if (want) {
      let i = item.options.findIndex((o) => norm(o.text) === want);
      if (i >= 0) return i;
      i = item.options.findIndex((o) => norm(o.text).startsWith(want) || want.startsWith(norm(o.text)));
      if (i >= 0) return i;
    }
    return -1;
  }

  function aiPromptTerse(item) {
    const opts = item.options.map((o, i) => i + ". " + textOf(o.text)).join("\n");
    return "Question:\n" + textOf(item.stem).slice(0, 1200) + "\n\nOptions:\n" + opts +
      "\n\nReply with only the number of the correct option.";
  }

  function aiAnswer(item, retry) {
    if (!cfg.key) return Promise.reject(new Error("no api key set"));
    const url = cfg.base.replace(/\/+$/, "") + "/chat/completions";
    const body = retry ? {
      model: cfg.model,
      temperature: 0,
      max_tokens: 20,
      messages: [
        { role: "system", content: "Reply with only the option number. Nothing else." },
        { role: "user", content: aiPromptTerse(item) },
      ],
    } : {
      model: cfg.model,
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        { role: "system", content: "You answer exam questions accurately and return strict JSON." },
        { role: "user", content: aiPrompt(item) },
      ],
    };
    return req({
      method: "POST",
      url,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
      data: JSON.stringify(body),
      timeout: 60000,
    }).then((r) => {
      if (r.status < 200 || r.status >= 300) throw new Error("http " + r.status + " " + r.text.slice(0, 100));
      let data;
      try { data = JSON.parse(r.text); } catch { throw new Error("bad response json"); }
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (retry) {
        const n = parseInt(String(content || "").match(/-?\d+/)?.[0], 10);
        if (Number.isInteger(n) && item.options[n]) {
          log("ai pick " + n + " (plain)");
          return { picks: [{ text: item.options[n].text }] };
        }
        throw new Error("model returned no answer");
      }
      const parsed = parseAiJson(content);
      if (parsed) {
        const i = resolvePick(parsed, item);
        if (i >= 0) {
          log("ai pick " + i + (parsed.why ? " (" + parsed.why + ")" : ""));
          return { picks: [{ text: item.options[i].text }] };
        }
        if (parsed.text && String(parsed.text).trim()) {
          const t = String(parsed.text).trim();
          const hit = item.options.findIndex((o) => norm(o.text) === norm(t));
          if (hit >= 0) { log("ai pick " + hit + " (text)"); return { picks: [{ text: item.options[hit].text }] }; }
        }
      }
      log("ai: no usable json, asking again for a bare number");
      return aiAnswer(item, true);
    });
  }

  function aiWrite(item) {
    if (!cfg.key) return Promise.reject(new Error("no api key set"));
    const words = clamp(Number(cfg.words) || 100, 40, 400);
    const context = pageContext(2500);
    const refs = (referenceText(1500) + " " + remoteRefs).trim().slice(0, 1500);
    let user = "Task:\n" + String(item.stem).slice(0, 2000);
    if (context && norm(context) !== norm(item.stem)) user += "\n\nPage instructions:\n" + context;
    if (refs) user += "\n\nReference material from the page:\n" + refs;
    user += "\n\nWrite about " + words + " words. Follow every instruction above (language, counts, format). Output only the text to submit.";
    const body = {
      model: cfg.model,
      temperature: 0.5,
      max_tokens: 900,
      messages: [
        { role: "system", content: "You do school coursework. Write exactly what the prompt asks for. Plain text only: no markdown, no quoting, no preamble, no explanation of what you are doing." },
        { role: "user", content: user },
      ],
    };
    return req({
      method: "POST",
      url: cfg.base.replace(/\/+$/, "") + "/chat/completions",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
      data: JSON.stringify(body),
      timeout: 90000,
    }).then((r) => {
      if (r.status < 200 || r.status >= 300) throw new Error("http " + r.status + " " + r.text.slice(0, 100));
      let data;
      try { data = JSON.parse(r.text); } catch { throw new Error("bad response json"); }
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      const text = String(content || "").trim();
      if (!text) throw new Error("model returned nothing");
      return text;
    });
  }

  function probeAi() {
    if (!cfg.key) { log("ai test: no key set"); return; }
    const t0 = Date.now();
    req({
      method: "POST",
      url: cfg.base.replace(/\/+$/, "") + "/chat/completions",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
      data: JSON.stringify({
        model: cfg.model,
        max_tokens: 24,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
      timeout: 60000,
    }).then((r) => {
      if (r.status !== 200) throw new Error("http " + r.status + " " + r.text.slice(0, 80));
      const j = JSON.parse(r.text);
      const out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      log("ai test ok in " + (Date.now() - t0) + "ms: " + String(out || "").slice(0, 40));
    }).catch((e) => log("ai test failed: " + e.message));
  }
  // endregion

  // region brainly
  function brainlyAnswer(item) {
    const q = textOf(item.stem).slice(0, 200);
    const url = "https://brainly.com/search?source=topbar&q=" + encodeURIComponent(q);
    return req({ url, headers: { "Accept": "text/html" } }).then((r) => {
      if (r.status !== 200 || !r.text) return null;
      const doc = new DOMParser().parseFromString(r.text, "text/html");
      const want = tokens(item.stem);
      let best = "", bestScore = 0;
      for (const p of doc.querySelectorAll("p, div[data-testid], article")) {
        const t = textOf(p.innerText || p.textContent || "");
        if (t.length < 40 || t.length > 600) continue;
        if (/brainly|cookie|sign in|log in/i.test(t)) continue;
        let hit = 0;
        for (const w of tokens(t)) if (want.has(w)) hit++;
        const score = hit / Math.max(6, want.size);
        if (score > bestScore) { bestScore = score; best = t; }
      }
      if (bestScore < 0.35 || !best) return null;
      log("brainly: candidate found (" + Math.round(bestScore * 100) + "% overlap)");
      return { text: best.slice(0, 400) };
    });
  }
  // endregion

  // region patches
  function spoofLockdown(win) {
    try {
      const P = win.JSON && win.JSON.parse;
      if (!P || P.__ea) return;
      const wrapped = function (text, reviver) {
        const v = P.call(this, text, reviver);
        try {
          if (v && v.Navigation && v.Navigation.lockDownBrowserEnabled === true) {
            v.Navigation.lockDownBrowserEnabled = false;
          }
          if (v && v.lockDownBrowserEnabled === true) v.lockDownBrowserEnabled = false;
        } catch {}
        return v;
      };
      wrapped.__ea = true;
      win.JSON.parse = wrapped;
      log("lockdown spoof armed");
    } catch (e) { log("spoof failed: " + e.message); }
  }

  function stealth(win) {
    try {
      const ls = win.localStorage;
      if (ls && !ls.__ea) {
        const set = ls.setItem.bind(ls);
        ls.setItem = function (k, v) {
          if (/RecentPageID|WrongPageID/i.test(String(k))) return;
          return set(k, v);
        };
        ls.__ea = true;
      }
    } catch {}
    try {
      Object.defineProperty(win.document, "domain", {
        configurable: true,
        get: () => location.hostname,
        set: () => {},
      });
    } catch {}
  }
  // endregion

  // region advance
  // auto next / submit: only fires after something was actually filled, so a page with no
  // answer never gets skipped, and the top-level "next activity" waits for a child click.
  const ADVANCE_RE = /^(next|next activity|next question|next page|submit|submit answer|submit assessment|submit activity|submit quiz|submit response|check answer|finish|finish activity|turn in|save and next|save & next)$/i;
  const ENTER_RE = /^(start|start activity|begin|resume|continue|open|let'?s go)$/i;
  const CONFIRM_RE = /^(yes|yes,? submit|ok|okay|confirm|submit|turn in|continue)$/i;
  const AVOID_RE = /previous|back|exit|log ?out|tutor|help|settings|menu|cancel|discard|close|save and exit|review|print|flag/i;
  let lastAdvanceAt = 0;
  let lastChildAdv = 0;
  let lastChildState = 0;
  let lastStateAt = 0;
  let advanceCooldown = 0;
  let advanceCount = 0;
  let lastClickText = "";
  let lastClickAt = 0;
  let lastWarnAt = 0;
  let lastWaitAt = 0;
  const fillTry = new Map();

  function buttonText(el) {
    return String(el.innerText || el.value || el.textContent || el.getAttribute("aria-label") || el.title || "")
      .replace(/\s+/g, " ").trim();
  }

  function findButton(re, modalOnly, skipDedupe) {
    for (const el of qAll('button,a,[role="button"],input[type="submit"],input[type="button"]', true)) {
      if (el.closest('[aria-hidden="true"]')) continue;
      if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") continue;
      const t = buttonText(el);
      if (!t || t.length > 40 || AVOID_RE.test(t) || !re.test(t)) continue;
      if (modalOnly && !el.closest('[role="dialog"],[role="alertdialog"],[class*="modal"],[class*="dialog"]')) continue;
      if (!skipDedupe && t === lastClickText && Date.now() - lastClickAt < 6000) continue;
      return el;
    }
    return null;
  }

  function clickButton(re, modalOnly) {
    const el = findButton(re, modalOnly, false);
    if (!el) return "";
    const t = buttonText(el);
    try { el.scrollIntoView({ block: "center" }); el.click(); } catch {}
    lastClickText = t;
    lastClickAt = Date.now();
    return t;
  }

  const UNANSWERED_WARN = /unanswered|not answered|incomplete|answer all|all questions|questions? remaining/i;

  function modalText() {
    let m = null;
    try { m = document.querySelector('[role="dialog"],[role="alertdialog"],[class*="modal"],[class*="dialog"]'); } catch {}
    return m ? cleanText(m.innerText || "") : "";
  }

  // findButton skips anything matching AVOID_RE, so the dialog's own Cancel needs its own path
  function clickModalCancel() {
    let m = null;
    try { m = document.querySelector('[role="dialog"],[role="alertdialog"],[class*="modal"],[class*="dialog"]'); } catch {}
    if (!m) return "";
    for (const el of m.querySelectorAll('button,a,[role="button"],input[type="button"]')) {
      const t = buttonText(el);
      if (!/^(cancel|stay|no|go back|return|review|close)$/i.test(t)) continue;
      try { el.click(); return t; } catch {}
    }
    return "";
  }

  // every question detected on this page must be answered before we move on — checked in the DOM
  // first, since the realm that clicked is not necessarily the realm that advances
  function pageState() {
    let list = [];
    try { list = domItems(); } catch {}
    const seen = new Set();
    const missing = [];
    for (const it of list) {
      const k = itemKey(it);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!it.answered && !answered.has(k)) missing.push(it);
    }
    return { count: seen.size, missing, ready: seen.size > 0 && missing.length === 0 };
  }

  function advanceTick(force) {
    if (!force && !cfg.autonext) return;
    if (Date.now() < advanceCooldown || (!force && advanceCount > 300)) return;
    if (!IS_TOP && Date.now() - lastStateAt > 5000) {
      // tell the shell whether this frame still has a step of its own to take
      if (findButton(ADVANCE_RE, false, true)) { lastStateAt = Date.now(); busUp({ ea: "state", can: true }); }
    }

    const modal = modalText();
    if (modal) {
      if (UNANSWERED_WARN.test(modal)) {
        if (Date.now() - lastWarnAt > 5000) {
          lastWarnAt = Date.now();
          const c = clickModalCancel();
          log("dialog: \"" + modal.slice(0, 90) + "\" — " + (c ? "dismissed with " + c : "not confirming"));
        }
        return;
      }
      if (Date.now() - lastAdvanceAt < 20000) {
        const c = clickButton(CONFIRM_RE, true);
        if (c) {
          lastAdvanceAt = Date.now(); advanceCooldown = Date.now() + 1500; advanceCount++;
          log("auto: " + c + " (dialog)");
        }
      }
      return; // a modal owns the page; never click through it
    }

    const st = pageState();
    if (st.missing.length && !force) {
      // autonext fills what it can, then waits — it never walks past an unanswered page
      if (cfg.autonext) {
        const now = Date.now();
        for (const it of st.missing) {
          const k = itemKey(it);
          if (now - (fillTry.get(k) || 0) < 25000) continue;
          fillTry.set(k, now);
          fillOrFetch(it, 0);
        }
      }
      if (Date.now() - lastWaitAt > 8000) {
        lastWaitAt = Date.now();
        log("holding: " + st.missing.length + "/" + st.count + " unanswered");
      }
      return;
    }
    if (!st.ready && !force) {
      if (st.count) return; // questions here, not all answered yet
      // nothing detectable: entering or continuing is safe, advancing is not
      const e = clickButton(ENTER_RE, false);
      if (e) {
        lastAdvanceAt = Date.now(); advanceCooldown = Date.now() + 2500; advanceCount++;
        log("auto: " + e);
      }
      return;
    }

    const hasFrames = (() => { try { return window.frames.length > 0; } catch { return false; } })();
    // let a child take its own step, but only briefly — a child that reports and then does
    // nothing must not stall the shell
    const topGate = !force && IS_TOP && hasFrames &&
      (Date.now() - lastChildAdv < 8000 || Date.now() - lastChildState < 4000);
    if (!topGate) {
      const a = clickButton(ADVANCE_RE, false);
      if (a) {
        lastAdvanceAt = Date.now(); advanceCooldown = Date.now() + 2200; advanceCount++;
        log("auto: " + a);
        if (!IS_TOP) busUp({ ea: "adv", text: a });
        return;
      }
    }
    if (!st.count) {
      const e = clickButton(ENTER_RE, false);
      if (e) {
        lastAdvanceAt = Date.now(); advanceCooldown = Date.now() + 2500; advanceCount++;
        log("auto: " + e);
      }
    }
  }

  setInterval(() => { if (!document.hidden) { try { advanceTick(false); } catch {} } }, 2000);
  // endregion

  // region bus
  function busUp(msg) {
    try { window.parent.postMessage(msg, "*"); } catch {}
  }
  function busDown(msg) {
    for (let i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage(msg, "*"); } catch {}
    }
  }
  if (IS_TOP) {
    window.addEventListener("message", (e) => {
      const m = e.data;
      if (!m || typeof m !== "object" || !m.ea) return;
      if (m.ea === "item") { ui.items += m.n || 1; ui.last = m.stem || ""; if (ui.renderSolve) ui.renderSolve(); if (m.item) busDown({ ea: "last", item: m.item }); }
      if (m.ea === "verdict") { ui.learned++; if (ui.renderSolve) ui.renderSolve(); }
      if (m.ea === "log" && m.msg) log("frame: " + m.msg);
      if (m.ea === "adv") { lastChildAdv = Date.now(); lastFillAt = Date.now(); }
      if (m.ea === "answered" && m.key) answered.set(m.key, Date.now());
      if (m.ea === "state" && m.can) lastChildState = Date.now();
      if (m.ea === "refs?") {
        const t = referenceText(1200) || pageContext(1200);
        if (t) busDown({ ea: "refs", text: t });
      }
      if (m.ea === "fill") fillLocal();
    });
  } else {
    window.addEventListener("message", (e) => {
      const m = e.data;
      if (!m || typeof m !== "object") return;
      if ((m.ea === "item" || m.ea === "verdict") && !m.relay) {
        busUp(Object.assign({}, m, { relay: true }));
      }
      if (m.ea === "last" && m.item && m.item.stem) {
        remoteItem = m.item;
        if (!m.relay) busDown(Object.assign({}, m, { relay: true }));
      }
      if (m.ea === "refs" && m.text) {
        remoteRefs = String(m.text).slice(0, 1500);
        if (!m.relay) busDown(Object.assign({}, m, { relay: true }));
      }
      if (m.ea === "refs?") busUp({ ea: "refs?" });
      if (m.ea === "adv") busUp({ ea: "adv", text: m.text });
      if (m.ea === "answered" && m.key && !m.relay) busUp({ ea: "answered", key: m.key, relay: true });
      if (m.ea === "state" && m.can) busUp({ ea: "state", can: true });
      if (m.ea === "fill") fillLocal();
    });
  }
  // endregion

  // region ui
  const ui = { items: 0, learned: 0, last: "", root: null, logEl: null, solveEl: null, host: null, setOpen: null };

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === "style") el.style.cssText = props[k];
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), props[k]);
      else if (k === "class") el.className = props[k];
      else if (k in el) el[k] = props[k];
      else el.setAttribute(k, props[k]);
    }
    for (const kid of kids) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  const CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
    ".wrap{position:fixed;z-index:2147483647;right:14px;bottom:14px;width:340px;max-height:70vh;",
    "background:#0d0f0e;color:#cfe8d8;border:1px solid #2a3a31;border-radius:10px;",
    "box-shadow:0 10px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;font-size:12px;",
    "transition:transform .18s ease, opacity .18s ease}",
    ".wrap.dragging{transition:none}",
    ".wrap.hidden{display:none}",
    ".bar{position:relative;display:flex;align-items:center;gap:8px;padding:8px 10px;background:#121815;cursor:grab;",
    "touch-action:none;user-select:none;-webkit-user-select:none;border-bottom:1px solid #222d27}",
    ".bar:active{cursor:grabbing}",
    ".grab{position:absolute;left:50%;top:4px;width:34px;height:4px;margin-left:-17px;border-radius:2px;",
    "background:#2f4738;display:none}",
    ".dot{width:8px;height:8px;border-radius:50%;background:#3ad17f;flex:0 0 auto}",
    ".name{flex:1;font-weight:600;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".btn{background:#18231d;color:#cfe8d8;border:1px solid #2d4036;border-radius:6px;",
    "padding:8px 10px;font-size:12px;cursor:pointer;min-height:36px;-webkit-tap-highlight-color:transparent}",
    ".btn:active{background:#22332a}",
    ".btn.go{background:#1c4a33;border-color:#2f7a52;color:#d6ffe9}",
    ".btn.off{opacity:.55}",
    ".icon{min-height:28px;padding:2px 9px;font-size:15px;line-height:1;flex:0 0 auto}",
    ".tabs{display:flex;border-bottom:1px solid #222d27}",
    ".tab{flex:1;text-align:center;padding:11px 4px;cursor:pointer;color:#7fa08e;-webkit-tap-highlight-color:transparent}",
    ".tab.on{color:#cfe8d8;box-shadow:inset 0 -2px 0 #3ad17f}",
    ".body{padding:10px;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}",
    ".row{display:flex;gap:8px;margin-bottom:8px;align-items:center}",
    ".row .btn{flex:1}",
    ".kv{display:flex;justify-content:space-between;padding:3px 0;color:#8fb3a0}",
    ".kv b{color:#cfe8d8;font-weight:600}",
    ".q{background:#101714;border:1px solid #223029;border-radius:6px;padding:8px;",
    "margin:8px 0;max-height:90px;overflow:auto;line-height:1.4;color:#a9c4b4}",
    "label.f{display:block;margin:8px 0 3px;color:#8fb3a0}",
    "input.t,textarea.t{width:100%;background:#0a100d;border:1px solid #26382f;border-radius:6px;",
    "color:#d6efe1;padding:9px;font-size:16px}",
    "textarea.t{min-height:80px;resize:vertical}",
    ".log{white-space:pre-wrap;line-height:1.45;color:#9db8a9;max-height:40vh;overflow:auto}",
    ".fab{position:fixed;z-index:2147483647;right:14px;bottom:calc(14px + env(safe-area-inset-bottom));",
    "width:52px;height:52px;border-radius:26px;border:1px solid #2f7a52;background:#163a28;color:#d6ffe9;",
    "font:600 11px ui-monospace,monospace;letter-spacing:.04em;display:none;align-items:center;justify-content:center;",
    "box-shadow:0 8px 24px rgba(0,0,0,.55);cursor:pointer;-webkit-tap-highlight-color:transparent}",
    ".fab.show{display:flex}",
    ".fab:active{background:#1c4a33}",
    "@media (max-width:640px){",
    ".wrap{right:0;left:0;bottom:0;width:100%;max-height:58vh;border-radius:14px 14px 0 0;",
    "border-bottom:0;padding-bottom:env(safe-area-inset-bottom)}",
    ".bar{padding:14px 12px 10px}",
    ".grab{display:block}",
    ".btn{min-height:44px;padding:11px 12px;font-size:13px}",
    ".tab{padding:13px 4px;font-size:13px}",
    ".fab{right:16px;bottom:calc(96px + env(safe-area-inset-bottom));width:56px;height:56px;border-radius:28px}",
    "}",
  ].join("");

  function mkBtn(label, onClick, cls) {
    return h("button", { class: "btn" + (cls ? " " + cls : ""), onclick: onClick, type: "button" }, label);
  }

  function mount() {
    if (!IS_TOP || ui.host) return;
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:auto;z-index:2147483647";
    document.documentElement.appendChild(host);
    ui.host = host;
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    const wrap = h("div", { class: "wrap" });

    const dot = h("span", { class: "dot" });
    const name = h("span", { class: "name" }, "answers " + (bankSize() ? "· " + bankSize() : ""));
    const hideBtn = h("button", { class: "btn icon", type: "button", title: "hide panel", onclick: () => setOpen(false) }, "–");
    const bar = h("div", { class: "bar" }, h("span", { class: "grab" }), dot, name, hideBtn);
    wrap.appendChild(bar);

    const fab = h("button", { class: "fab", type: "button", title: "answers", "aria-label": "open answers panel", onclick: () => setOpen(true) }, "ea");

    const isMobile = () => window.matchMedia("(max-width: 640px)").matches;

    function applyLayout() {
      if (isMobile()) {
        // the sheet is CSS-anchored to the bottom; stale drag coords are what pinned it to the top
        wrap.style.left = "";
        wrap.style.top = "";
        wrap.style.right = "";
        return;
      }
      if (!cfg.pos) {
        for (const p of ["left", "top", "right", "bottom"]) wrap.style[p] = "";
        return;
      }
      const r = wrap.getBoundingClientRect();
      const w = r.width || 340;
      const x = clamp(cfg.pos.x, 4, Math.max(4, innerWidth - w - 4));
      const y = clamp(cfg.pos.y, 4, Math.max(4, innerHeight - 80));
      cfg.pos = { x, y };
      wrap.style.left = x + "px";
      wrap.style.top = y + "px";
      wrap.style.right = "auto";
      wrap.style.bottom = "auto";
    }

    function setOpen(v) {
      cfg.open = !!v;
      saveCfg();
      wrap.classList.toggle("hidden", !v);
      fab.classList.toggle("show", !v);
      if (v) {
        wrap.style.transform = "";
        try { requestAnimationFrame(applyLayout); } catch { applyLayout(); }
      }
    }

    const tabs = h("div", { class: "tabs" });
    const body = h("div", { class: "body" });
    wrap.appendChild(tabs);
    wrap.appendChild(body);

    const pane = { solve: h("div"), cfg: h("div"), log: h("div") };
    const logBox = h("div", { class: "log" });
    pane.log.appendChild(h("div", { class: "row" }, mkBtn("clear log", () => { logs.length = 0; ui.renderLog(); })));
    pane.log.appendChild(logBox);
    body.appendChild(pane.solve);
    body.appendChild(pane.cfg);
    body.appendChild(pane.log);

    function setTab(t) {
      cfg.tab = t; saveCfg();
      pane.solve.style.display = t === "solve" ? "" : "none";
      pane.cfg.style.display = t === "cfg" ? "" : "none";
      pane.log.style.display = t === "log" ? "" : "none";
      for (const el of tabs.children) el.className = "tab" + (el.dataset.t === t ? " on" : "");
      if (t === "log") ui.renderLog();
    }
    for (const [id, label] of [["solve", "solve"], ["cfg", "settings"], ["log", "log"]]) {
      const t = h("div", { class: "tab", "data-t": id, onclick: () => setTab(id) }, label);
      tabs.appendChild(t);
    }

    // solve pane
    ui.solveEl = h("div");
    pane.solve.appendChild(ui.solveEl);
    pane.solve.appendChild(h("div", { class: "row" },
      mkBtn("fill current", () => {
        log("fill broadcast");
        fillLocal();
      }, "go")));
    const autoBtn = mkBtn("auto-fill", () => { cfg.auto = !cfg.auto; saveCfg(); ui.renderSolve(); });
    const aiBtn = mkBtn("use ai", () => { cfg.ai = !cfg.ai; saveCfg(); ui.renderSolve(); });
    const brnBtn = mkBtn("brainly", () => { cfg.brainly = !cfg.brainly; saveCfg(); ui.renderSolve(); });
    pane.solve.appendChild(h("div", { class: "row" }, autoBtn, aiBtn, brnBtn));
    const nextBtn = mkBtn("auto next", () => {
      cfg.autonext = !cfg.autonext;
      saveCfg();
      ui.renderSolve();
      log("auto next " + (cfg.autonext ? "on — fills, submits, moves on" : "off"));
    });
    pane.solve.appendChild(h("div", { class: "row" }, nextBtn, mkBtn("next now", () => advanceTick(true), "go")));

    // settings pane
    const f = (label, key, opts) => {
      const p = h("div");
      p.appendChild(h("label", { class: "f" }, label));
      const inp = h(opts && opts.area ? "textarea" : "input", { class: "t" });
      inp.type = opts && opts.pass ? "password" : "text";
      inp.value = cfg[key] || "";
      inp.placeholder = (opts && opts.ph) || "";
      inp.onchange = () => { cfg[key] = inp.value.trim(); saveCfg(); log(key + " saved"); };
      p.appendChild(inp);
      return p;
    };
    const cfgPane = pane.cfg;
    cfgPane.appendChild(f("api base (openai-compatible)", "base", { ph: "https://api.groq.com/openai/v1" }));
    cfgPane.appendChild(f("model", "model", { ph: "llama-3.3-70b-versatile" }));
    cfgPane.appendChild(f("written answer length (words)", "words", { ph: "100" }));
    cfgPane.appendChild(f("api key", "key", { pass: true, ph: "stored locally, never sent anywhere but your base url" }));
    cfgPane.appendChild(h("div", { class: "row", style: "margin-top:8px" },
      mkBtn("test ai", () => { probeAi(); }, "go")));
    const spoofBtn = mkBtn("lockdown spoof", () => { cfg.spoof = !cfg.spoof; saveCfg(); ui.renderCfgButtons(); });
    const stealthBtn = mkBtn("stealth", () => { cfg.stealth = !cfg.stealth; saveCfg(); ui.renderCfgButtons(); });
    const sniffBtn = mkBtn("sniff net", () => { cfg.sniff = !cfg.sniff; saveCfg(); ui.renderCfgButtons(); });
    ui.renderCfgButtons = () => {
      spoofBtn.className = "btn " + (cfg.spoof ? "go" : "off");
      stealthBtn.className = "btn " + (cfg.stealth ? "go" : "off");
      sniffBtn.className = "btn " + (cfg.sniff ? "go" : "off");
    };
    cfgPane.appendChild(h("div", { class: "row", style: "margin-top:10px" }, spoofBtn, stealthBtn, sniffBtn));
    cfgPane.appendChild(h("div", { class: "row" },
      mkBtn("reset panel", () => {
        cfg.pos = null;
        wrap.style.cssText = "";
        saveCfg();
        applyLayout();
        setOpen(true);
        log("panel reset");
      })));
    cfgPane.appendChild(h("label", { class: "f" }, "import answer bank (json: [{question, answer}])"));
    const importArea = h("textarea", { class: "t", placeholder: '[{"question":"2+2","answer":"4"}]' });
    cfgPane.appendChild(importArea);
    cfgPane.appendChild(h("div", { class: "row", style: "margin-top:8px" },
      mkBtn("import", () => {
        try { const n = bankImport(importArea.value); log("imported " + n); importArea.value = ""; ui.renderSolve(); }
        catch (e) { log("import failed: " + e.message); }
      }, "go"),
      mkBtn("export", () => { importArea.value = bankExport(); log("bank in the box, copy it"); }),
      mkBtn("clear", () => { bank = {}; flushBank(); log("bank cleared"); ui.renderSolve(); })));

    ui.renderSolve = () => {
      if (!ui.solveEl) return;
      ui.solveEl.textContent = "";
      ui.solveEl.appendChild(h("div", { class: "kv" }, h("span", null, "questions captured"), h("b", null, String(ui.items))));
      ui.solveEl.appendChild(h("div", { class: "kv" }, h("span", null, "answers learned"), h("b", null, String(ui.learned))));
      ui.solveEl.appendChild(h("div", { class: "kv" }, h("span", null, "bank size"), h("b", null, String(bankSize()))));
      if (ui.last) ui.solveEl.appendChild(h("div", { class: "q" }, ui.last));
      else ui.solveEl.appendChild(h("div", { class: "q" }, "no question captured yet — open an activity, the learnosity frame reports in."));
      autoBtn.className = "btn " + (cfg.auto ? "go" : "off");
      aiBtn.className = "btn " + (cfg.ai ? "go" : "off");
      brnBtn.className = "btn " + (cfg.brainly ? "go" : "off");
      nextBtn.className = "btn " + (cfg.autonext ? "go" : "off");
    };
    ui.renderLog = () => {
      const counts = new Map();
      for (const line of logs) {
        const body = line.replace(/^\d{1,2}:\d{2}:\d{2}\s+/, "");
        counts.set(body, (counts.get(body) || 0) + 1);
      }
      const out = [];
      for (const [body, n] of counts) out.push(n > 1 ? body + "   ×" + n : body);
      logBox.textContent = out.join("\n");
      logBox.scrollTop = logBox.scrollHeight;
    };

    // drag on desktop, swipe-down on mobile
    let drag = null;
    let raf = 0;
    const paint = () => {
      raf = 0;
      if (!drag) return;
      if (drag.mobile) {
        wrap.style.transform = "translateY(" + Math.max(0, drag.dy) + "px)";
        return;
      }
      const left = clamp(drag.rect.left + drag.dx, 4, Math.max(4, innerWidth - drag.rect.width - 4));
      const top = clamp(drag.rect.top + drag.dy, 4, Math.max(4, innerHeight - 80));
      wrap.style.left = left + "px";
      wrap.style.top = top + "px";
      wrap.style.right = "auto";
      wrap.style.bottom = "auto";
    };
    bar.addEventListener("pointerdown", (e) => {
      if (e.target === hideBtn) return;
      drag = { x: e.clientX, y: e.clientY, dx: 0, dy: 0, moved: false, mobile: isMobile(), rect: wrap.getBoundingClientRect() };
      try { bar.setPointerCapture(e.pointerId); } catch {}
    });
    bar.addEventListener("pointermove", (e) => {
      if (!drag) return;
      drag.dx = e.clientX - drag.x;
      drag.dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(drag.dx) + Math.abs(drag.dy) > 6) {
        drag.moved = true;
        wrap.classList.add("dragging");
      }
      if (drag.moved && !raf) raf = requestAnimationFrame(paint);
    });
    const endDrag = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      wrap.classList.remove("dragging");
      if (d.mobile) {
        wrap.style.transform = "";
        if (d.dy > 70) { setOpen(false); return; }
        return;
      }
      if (!d.moved) return;
      const r = wrap.getBoundingClientRect();
      cfg.pos = { x: r.left, y: r.top };
      saveCfg();
      applyLayout();
    };
    bar.addEventListener("pointerup", endDrag);
    bar.addEventListener("pointercancel", endDrag);

    // keep the sheet above the on-screen keyboard
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const fit = () => {
        if (!isMobile()) { wrap.style.bottom = ""; return; }
        const off = Math.max(0, innerHeight - vv.height - vv.offsetTop);
        wrap.style.bottom = off ? off + "px" : "";
      };
      vv.addEventListener("resize", fit);
      vv.addEventListener("scroll", fit);
    }

    root.appendChild(wrap);
    root.appendChild(fab);
    ui.setOpen = setOpen;

    ui.renderSolve();
    ui.renderCfgButtons();
    setTab(cfg.tab || "solve");
    setOpen(cfg.open !== false);
    window.addEventListener("resize", applyLayout);
    log("panel mounted on " + location.hostname + " · v" + VERSION);
  }
  // endregion

  // region boot
  if (cfg.spoof) spoofLockdown(W);
  if (cfg.stealth) stealth(W);

  if (IS_TOP) {
    const mountFail = (e) => {
      log("mount failed: " + e.message);
      try {
        if (document.getElementById("ea-fail")) return;
        const b = document.createElement("button");
        b.id = "ea-fail";
        b.textContent = "ea";
        b.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;width:48px;height:48px;border-radius:24px;background:#141414;color:#fff;border:1px solid #444;font:600 14px system-ui;cursor:pointer";
        b.onclick = () => { try { b.remove(); mount(); } catch (err) { alert("answers: " + err.message); } };
        (document.documentElement || document.body).appendChild(b);
      } catch {}
    };
    const boot = () => { try { mount(); } catch (e) { mountFail(e); } };
    const ensure = () => {
      try {
        if (!ui.host) { mount(); return; }
        if (ui.host.isConnected) return;
        // the player rewrites the document (document.open/write or a fresh html node) and drops the host
        (document.documentElement || document.body).appendChild(ui.host);
        log("panel re-attached after page rewrite");
        if (ui.setOpen) ui.setOpen(cfg.open !== false);
      } catch (e) { mountFail(e); }
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
    setInterval(ensure, 1500);
    window.addEventListener("pageshow", ensure);
  }

  try {
    W.__answers = { version: VERSION, extractItems, bankGet, bankPut, bankImport, bankExport, norm, sim, hash, cfg, saveCfg, probeAi, probeDom, parseAiJson, resolvePick, domItems, domScan, fillLocal, expandToggles, pageContext, referenceText, advanceTick };
  } catch {}

  log("ready on " + location.hostname + (IS_TOP ? "" : " (frame)") + " · v" + VERSION);
  try {
    const p = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
    log("hooks " + (p && p.__ea ? "xhr ok" : "xhr MISSING") + " · sniff " + (cfg.sniff ? "on" : "off") + " · realm " + (W === window ? "page" : "isolated"));
  } catch {}
  // endregion
})();
