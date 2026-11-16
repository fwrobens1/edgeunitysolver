// ==UserScript==
// @name         answers — edgenuity / learnosity
// @namespace    local.answers
// @version      1.1.0
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

  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const IS_TOP = (() => { try { return window.top === window; } catch { return false; } })();
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
    pos: null,
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
  const MAYBE_ITEM = /learnosity|il-apps|\/api\/|lmsapi|item|question|assess|activity|task/i;
  let lastItem = null;
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
    busUp({ ea: "item", n: items.length, stem: items[0].stem.slice(0, 90) });
    if (cfg.auto) autoFill(items[0]);
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
  function optionNodes() {
    const sel = '[role="radio"],[role="checkbox"],input[type="radio"],input[type="checkbox"]';
    const nodes = [];
    for (const n of document.querySelectorAll(sel)) {
      if (!visible(n)) continue;
      const box = n.closest('label,[role="radio"],[role="checkbox"],li') || n.parentElement || n;
      const text = box === n ? (n.value || n.getAttribute("aria-label") || "") : (box.innerText || n.value || "");
      nodes.push({ node: n, text: textOf(text) });
    }
    return nodes;
  }

  function clickNode(n) {
    try {
      n.scrollIntoView({ block: "center" });
      n.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      n.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      n.click();
    } catch { try { n.click(); } catch {} }
  }

  function setFieldValue(el, val) {
    if (el.isContentEditable) {
      el.focus();
      el.textContent = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return;
    }
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
    const sel = 'textarea,input[type="text"],input:not([type]),[contenteditable="true"],[contenteditable=""]';
    return [...document.querySelectorAll(sel)].filter(visible);
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
      if (hit) log("filled " + hit + " option(s)");
      return hit > 0;
    }
    if (ans.text) {
      const fields = textFields();
      if (!fields.length) return false;
      setFieldValue(fields[0], ans.text);
      log("filled text answer");
      return true;
    }
    return false;
  }

  function fillOrFetch(item, depth) {
    if (!item) return;
    const cached = bankGet(item);
    if (cached) { applyAnswer(item, cached); return; }
    if (cfg.ai) aiAnswer(item).then((ans) => {
      if (ans) { applyAnswer(item, ans); bankPut(item, ans); }
    }).catch((e) => log("ai: " + e.message));
    else if (cfg.brainly && depth === 0) {
      brainlyAnswer(item).then((ans) => { if (ans) { applyAnswer(item, ans); bankPut(item, ans); } }).catch(() => {});
    }
  }
  // endregion

  // region ai
  function aiPrompt(item) {
    const opts = item.options.map((o, i) => i + ". " + textOf(o.text)).join("\n");
    return "Answer this school question. Reply with ONLY compact JSON, no prose:\n" +
      '{"pick": <0-based option index, or null for short answer>, "text": "<short answer text or empty>", "why": "<6 words max>"}\n\n' +
      "Question:\n" + textOf(item.stem).slice(0, 1500) + "\n\nOptions:\n" + opts;
  }

  function parseAiJson(text) {
    const s = String(text || "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }

  function aiAnswer(item) {
    if (!cfg.key) return Promise.reject(new Error("no api key set"));
    const url = cfg.base.replace(/\/+$/, "") + "/chat/completions";
    const body = {
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
      const parsed = parseAiJson(content);
      if (!parsed) throw new Error("model returned no json");
      if (parsed.pick != null && item.options[parsed.pick]) {
        const o = item.options[parsed.pick];
        log("ai pick " + parsed.pick + (parsed.why ? " (" + parsed.why + ")" : ""));
        return { picks: [{ text: o.text }] };
      }
      if (parsed.text) { log("ai text: " + String(parsed.text).slice(0, 40)); return { text: String(parsed.text) }; }
      throw new Error("model returned no answer");
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
      if (m.ea === "item") { ui.items += m.n || 1; ui.last = m.stem || ""; if (ui.renderSolve) ui.renderSolve(); }
      if (m.ea === "verdict") { ui.learned++; if (ui.renderSolve) ui.renderSolve(); }
      if (m.ea === "log" && m.msg) log("frame: " + m.msg);
    });
  } else {
    window.addEventListener("message", (e) => {
      const m = e.data;
      if (!m || typeof m !== "object") return;
      if ((m.ea === "item" || m.ea === "verdict") && !m.relay) {
        busUp(Object.assign({}, m, { relay: true }));
      }
      if (m.ea === "fill") {
        if (lastItem) fillOrFetch(lastItem, 0);
        else busDown({ ea: "fill" });
      }
    });
  }
  // endregion

  // region ui
  const ui = { items: 0, learned: 0, last: "", root: null, logEl: null, solveEl: null, host: null };

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
    "box-shadow:0 10px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;font-size:12px}",
    ".wrap.min{width:auto;max-height:none}",
    ".bar{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#121815;cursor:pointer;",
    "touch-action:none;user-select:none;border-bottom:1px solid #222d27}",
    ".dot{width:8px;height:8px;border-radius:50%;background:#3ad17f}",
    ".name{flex:1;font-weight:600;letter-spacing:.02em}",
    ".btn{background:#18231d;color:#cfe8d8;border:1px solid #2d4036;border-radius:6px;",
    "padding:8px 10px;font-size:12px;cursor:pointer;min-height:36px}",
    ".btn:active{background:#22332a}",
    ".btn.go{background:#1c4a33;border-color:#2f7a52;color:#d6ffe9}",
    ".btn.off{opacity:.55}",
    ".tabs{display:flex;border-bottom:1px solid #222d27}",
    ".tab{flex:1;text-align:center;padding:9px 4px;cursor:pointer;color:#7fa08e}",
    ".tab.on{color:#cfe8d8;box-shadow:inset 0 -2px 0 #3ad17f}",
    ".body{padding:10px;overflow:auto}",
    ".row{display:flex;gap:8px;margin-bottom:8px;align-items:center}",
    ".row .btn{flex:1}",
    ".kv{display:flex;justify-content:space-between;padding:3px 0;color:#8fb3a0}",
    ".kv b{color:#cfe8d8;font-weight:600}",
    ".q{background:#101714;border:1px solid #223029;border-radius:6px;padding:8px;",
    "margin:8px 0;max-height:90px;overflow:auto;line-height:1.4;color:#a9c4b4}",
    "label.f{display:block;margin:8px 0 3px;color:#8fb3a0}",
    "input.t,textarea.t{width:100%;background:#0a100d;border:1px solid #26382f;border-radius:6px;",
    "color:#d6efe1;padding:9px;font-size:13px}",
    "textarea.t{min-height:80px;resize:vertical}",
    ".log{white-space:pre-wrap;line-height:1.45;color:#9db8a9;max-height:40vh;overflow:auto}",
    "@media (max-width:640px){.wrap{right:0;left:0;bottom:0;width:100%;max-height:58vh;border-radius:12px 12px 0 0}",
    ".btn{min-height:44px;padding:11px 12px;font-size:13px}}",
  ].join("");

  function mkBtn(label, onClick, cls) {
    return h("button", { class: "btn" + (cls ? " " + cls : ""), onclick: onClick, type: "button" }, label);
  }

  function mount() {
    if (!IS_TOP || ui.host) return;
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:auto;z-index:2147483647";
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    const wrap = h("div", { class: "wrap" });

    const dot = h("span", { class: "dot" });
    const name = h("span", { class: "name" }, "answers " + (bankSize() ? "· " + bankSize() : ""));
    const minBtn = h("button", { class: "btn", style: "padding:4px 8px;min-height:28px", type: "button" }, "_");
    const bar = h("div", { class: "bar" }, dot, name, minBtn);
    wrap.appendChild(bar);

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
        const msg = { ea: "fill" };
        try { window.postMessage(msg, "*"); } catch {}
        busDown(msg);
        if (lastItem) fillOrFetch(lastItem, 0);
        log("fill broadcast");
      }, "go")));
    const autoBtn = mkBtn("auto-fill", () => { cfg.auto = !cfg.auto; saveCfg(); ui.renderSolve(); });
    const aiBtn = mkBtn("use ai", () => { cfg.ai = !cfg.ai; saveCfg(); ui.renderSolve(); });
    const brnBtn = mkBtn("brainly", () => { cfg.brainly = !cfg.brainly; saveCfg(); ui.renderSolve(); });
    pane.solve.appendChild(h("div", { class: "row" }, autoBtn, aiBtn, brnBtn));

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

    // drag + minimise
    let drag = null;
    bar.addEventListener("pointerdown", (e) => {
      if (e.target === minBtn) return;
      drag = { x: e.clientX, y: e.clientY, pos: cfg.pos };
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const wrapEl = wrap;
      const r = wrapEl.getBoundingClientRect();
      const left = clamp(r.left + (e.clientX - drag.x), 4, innerWidth - r.width - 4);
      const top = clamp(r.top + (e.clientY - drag.y), 4, innerHeight - 60);
      wrapEl.style.left = left + "px"; wrapEl.style.top = top + "px";
      wrapEl.style.right = "auto"; wrapEl.style.bottom = "auto";
    });
    bar.addEventListener("pointerup", () => {
      if (!drag) return;
      drag = null;
      const r = wrap.getBoundingClientRect();
      cfg.pos = { x: r.left, y: r.top }; saveCfg();
    });
    minBtn.addEventListener("click", () => {
      wrap.classList.toggle("min");
      for (const el of [tabs, body]) el.style.display = wrap.classList.contains("min") ? "none" : "";
    });

    if (cfg.pos) {
      wrap.style.left = cfg.pos.x + "px";
      wrap.style.top = cfg.pos.y + "px";
      wrap.style.right = "auto";
      wrap.style.bottom = "auto";
    }

    root.appendChild(wrap);
    ui.host = host;

    ui.renderSolve();
    ui.renderCfgButtons();
    setTab(cfg.tab || "solve");
    log("panel mounted on " + location.hostname);
  }
  // endregion

  // region boot
  if (cfg.spoof) spoofLockdown(W);
  if (cfg.stealth) stealth(W);

  if (IS_TOP) {
    const boot = () => { try { mount(); } catch (e) { log("mount failed: " + e.message); } };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }

  try {
    W.__answers = { extractItems, bankGet, bankPut, bankImport, bankExport, norm, sim, hash, cfg, saveCfg, probeAi };
  } catch {}

  log("ready on " + location.hostname + (IS_TOP ? "" : " (frame)"));
  try {
    const p = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
    log("hooks " + (p && p.__ea ? "xhr ok" : "xhr MISSING") + " · sniff " + (cfg.sniff ? "on" : "off") + " · realm " + (W === window ? "page" : "isolated"));
  } catch {}
  // endregion
})();
