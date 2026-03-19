/***********************
* 관리자(Admin) - 학생 검색/상세/상세버튼(출결/취침/이동/교육점수/성적)
***********************/

// ✅ 여기에 Apps Script Web App URL(…/exec) 넣기
const API_BASE = "https://script.google.com/macros/s/AKfycbwxYd2tK4nWaBSZRyF0A3_oNES0soDEyWz0N0suAsuZU35QJOSypO2LFC-Z2dpbDyoD/exec";

// ✅ 성적 그래프 및 상태 관리를 위한 전역 변수
let currentTrendItems = []; 
let currentMode = 'pct';
let showTop30 = false;         // 처음엔 꺼짐 상태
let activeClasses = new Set(); // 💡 [수정] 여러 반을 동시에 켜고 끌 수 있도록 Set으로 변경

// 💡 [여기에 추가!] 주차 선택 시 테이블을 전환해주는 전역 함수
window.switchWeekTable = function(idx) {
  document.querySelectorAll('.attendance-week-block').forEach(el => {
    el.style.display = 'none'; 
  });
  const target = document.getElementById('week-table-block-' + idx);
  if (target) {
    target.style.display = 'block'; 
  }
};

/** =========================
* ✅ 출결(관리자) - 학부모 출결 상세와 동일한 "이동 기록 반영" 로직
* ========================= */
const PERIODS_ATT_ = [
  { p: 1, start: "08:00", end: "08:30" },
  { p: 2, start: "08:50", end: "10:10" },
  { p: 3, start: "10:30", end: "12:00" },
  { p: 4, start: "13:10", end: "14:30" },
  { p: 5, start: "14:50", end: "15:50" },
  { p: 6, start: "16:10", end: "17:30" },
  { p: 7, start: "18:40", end: "20:10" },
  { p: 8, start: "20:30", end: "22:00" },
];

function hhmmToMin_(t) {
  const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

function inferStartPeriodByTime_(timeHHMM) {
  const t = hhmmToMin_(timeHHMM);
  if (!Number.isFinite(t)) return 0;
  for (let i = 0; i < PERIODS_ATT_.length; i++) {
    const cur = PERIODS_ATT_[i];
    const s = hhmmToMin_(cur.start);
    const e = hhmmToMin_(cur.end);
    if (t >= s && t <= e) return cur.p;
    const next = PERIODS_ATT_[i + 1];
    if (next) {
      const ns = hhmmToMin_(next.start);
      if (t > e && t < ns) return next.p;
    }
  }
  return 0;
}

/** =========================
* ✅ 이동 기록으로 출결 스케줄 공란 채우기 (화장실/정수기 제외 버전)
* ========================= */
function buildMoveMapFromItems_(items) {
  const map = {}; 
  const arr = Array.isArray(items) ? items : [];
  
  for (const it of arr) {
    const reason = String(it?.reason || "").trim();

    // 💡 [수정] 화장실/정수기 사유는 출결표(Map) 생성에서 제외하여 상세 리스트에만 표시되게 함
    if (reason === "화장실/정수기") continue;

    const iso = String(it?.date || "").trim();
    if (!iso) continue;

    const time = String(it?.time || "").trim();            
    
    // '복귀안함'을 8교시로 인식하는 로직 유지
    const rpRaw = String(it?.returnPeriod || "").trim();
    let rp = parseInt(rpRaw, 10) || 0;
    if (rpRaw === "복귀안함") rp = 8; 

    if (!reason || rp <= 0) continue;

    // 시간 기반 교시 추정 및 맵핑 로직
    const sp = inferStartPeriodByTime_(time); 
    const from = sp > 0 ? sp : Math.max(1, rp - 1);
    const to = rp;
    const start = (from <= to) ? from : Math.max(1, rp - 1);

    map[iso] = map[iso] || {};
    for (let p = start; p <= to; p++) {
      map[iso][p] = reason;
    }
  }
  return map;
}

const ADMIN_SESSION_KEY = "admin_session_v1";
const SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000; 
const SUMMARY_CACHE_KEY = "admin_summary_cache_v1"; 

/**
 * ✅ 상세 데이터 전용 캐시 열쇠 생성 (학생+항목+기간 조합)
 */
function makeDetailCacheKey(seat, studentId, kind, days) {
  return `detail|${seat}|${studentId}|${kind}|${days}`;
}

/**
 * ✅ 보관함에서 데이터 꺼내기
 */
function getDetailCache(key) {
  const now = Date.now();
  const store = loadLocalCache_(); // 기존 보관함 함수 사용
  const it = store[key];
  // 유효기간(5분)이 지나지 않았을 때만 데이터 반환
  if (it && it.expireAt > now) return it.data;
  return null;
}

/**
 * ✅ 보관함에 데이터 저장하기 (5분간 유지)
 */
function setDetailCache(key, data) {
  const now = Date.now();
  const store = loadLocalCache_();
  store[key] = { expireAt: now + SUMMARY_CACHE_TTL_MS, data: data };
  saveLocalCache_(store);
}

const $ = (id) => document.getElementById(id);

function setAdminSession(s) { localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(s)); }
function getAdminSession() {
  const raw = localStorage.getItem(ADMIN_SESSION_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}
function clearAdminSession() { localStorage.removeItem(ADMIN_SESSION_KEY); }

function getAdminLabel_(sess) {
  const role = sess?.role || "";
  const name = sess?.adminName || "";
  if (role === "super") return "전체 관리자";
  if (name) return `${name} 관리자`;
  return "관리자";
}

function applyAdminHeaderLabel_(sess) {
  const el = document.querySelector(".top-title") || document.querySelector("header .top-title") || document.querySelector("header h1") || document.querySelector("header h2");
  if (!el) return;
  if (!el.dataset.baseTitle) el.dataset.baseTitle = el.textContent.trim() || "관리자";
  el.textContent = getAdminLabel_(sess);
}

async function apiPost(path, body) {
  const url = `${API_BASE}?path=${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body || {})
  });
  return await res.json();
}

function buildGradeTableRows_(data) {
  const kor  = data.kor  || {};
  const math = data.math || {};
  const eng  = data.eng  || {};
  const hist = data.hist || {};
  const tam1 = data.tam1 || {};
  const tam2 = data.tam2 || {};
  const dash = "-";
  const fmt = (v) => { const s = String(v ?? "").trim(); return s ? s : dash; };
  const fmtNum = (v) => { const n = Number(v); return Number.isFinite(n) && String(v).trim() !== "" ? String(n) : dash; };
  const shortenChoiceName = (v) => {
    if (v == null) return "";
    const map = { 
      "언어와매체":"언매", "화법과작문":"화작", "미적분":"미적", "확률과통계":"확통", "기하":"기하",
      "생활과윤리":"생윤", "사회문화":"사문", "정치와법":"정법", "윤리와사상":"윤사",
      "물리학1":"물1", "물리학2":"물2", "화학1":"화1", "화학2":"화2", 
      "생명과학1":"생1", "생명과학2":"생2", "지구과학1":"지1", "지구과학2":"지2", "지학1":"지1", "지학2":"지2"  
    };
    let s = String(v).replace(/\s+/g, "").replace(/Ⅰ|I/gi, "1").replace(/Ⅱ|II/gi, "2");
    return map[s] || s;
  };
  const fmtChoice = (v) => { const s = String(v ?? "").trim(); return s ? shortenChoiceName(s) : dash; };

  return [
    { label: "선택과목", kor: fmtChoice(kor.choice), math: fmtChoice(math.choice), eng: dash, hist: dash, tam1: fmtChoice(tam1.name), tam2: fmtChoice(tam2.name) },
    { label: "원점수",   kor: fmtNum(kor.raw_total), math: fmtNum(math.raw_total), eng: fmtNum(eng.raw), hist: fmtNum(hist.raw), tam1: fmtNum(tam1.raw), tam2: fmtNum(tam2.raw) },
    { label: "표준점수", kor: fmtNum(kor.expected_std), math: fmtNum(math.expected_std), eng: dash, hist: dash, tam1: fmtNum(tam1.expected_std), tam2: fmtNum(tam2.expected_std) },
    { label: "백분위",   kor: fmtNum(kor.expected_pct), math: fmtNum(math.expected_pct), eng: dash, hist: dash, tam1: fmtNum(tam1.expected_pct), tam2: fmtNum(tam2.expected_pct) },
    { label: "등급",     kor: fmt(kor.expected_grade), math: fmt(math.expected_grade), eng: fmt(eng.grade), hist: fmt(hist.grade), tam1: fmt(tam1.expected_grade), tam2: fmt(tam2.expected_grade) },
  ];
}

function renderGradeTableHtml_(rows) {
  return `
    <div style="margin-top:10px; overflow:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:13px;">
        <thead>
          <tr>
            <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(255,255,255,.10); white-space:nowrap;">과목</th>
            <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(255,255,255,.10); white-space:nowrap;">국어</th>
            <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(255,255,255,.10); white-space:nowrap;">수학</th>
            <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(255,255,255,.10); white-space:nowrap;">영어</th>
            <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(255,255,255,.10); white-space:nowrap;">한국사</th>
            <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(255,255,255,.10); white-space:nowrap;">탐구1</th>
            <th style="text-align:left; padding:8px; border-bottom:1px solid rgba(255,255,255,.10); white-space:nowrap;">탐구2</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${escapeHtml(r.label)}</td>
              <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${escapeHtml(r.kor)}</td>
              <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${escapeHtml(r.math)}</td>
              <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${escapeHtml(r.eng)}</td>
              <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${escapeHtml(r.hist)}</td>
              <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${escapeHtml(r.tam1)}</td>
              <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${escapeHtml(r.tam2)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
}
function fmtKeyVal(label, value) {
  return `<div style="display:flex; gap:8px; margin:2px 0;"><div style="min-width:90px; opacity:.8;">${escapeHtml(label)}</div><div style="font-weight:600;">${escapeHtml(value)}</div></div>`;
}
function setHint(el, msg, isError=false) {
  el.innerHTML = msg ? `<span style="color:${isError ? "#ff6b6b" : "inherit"}">${escapeHtml(msg)}</span>` : "";
}

function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return fallback;
}

const __memSummaryCache = new Map();
function makeStudentKey(seat, studentId) { return `${String(seat || "").trim()}|${String(studentId || "").trim()}`; }

function loadLocalCache_() {
  try {
    const raw = localStorage.getItem(SUMMARY_CACHE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch (_) { return {}; }
}
function saveLocalCache_(obj) { try { localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify(obj || {})); } catch (_) {} }

function isValidSummaryForCache(summary) {
  if (!summary || typeof summary !== "object") return false;
  const hasMeaningful = (v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === "number") return true;            
    if (typeof v === "string") return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") {
      const ks = Object.keys(v);
      if (ks.length === 0) return false;
      for (const k of ks) { if (hasMeaningful(v[k])) return true; }
      return false;
    }
    if (typeof v === "boolean") return true;
    return false;
  };
  const sections = ["attendance", "sleep", "move", "eduscore", "grade"];
  for (const k of sections) { if (summary[k] && typeof summary[k] === "object" && hasMeaningful(summary[k])) return true; }
  if (summary.student && typeof summary.student === "object" && hasMeaningful(summary.student)) return true;
  return hasMeaningful(summary);
}

function clearSummaryCache(key) {
  __memSummaryCache.delete(key);
  try {
    const store = loadLocalCache_();
    if (store && store[key]) { delete store[key]; saveLocalCache_(store); }
  } catch (_) {}
}
function clearAllSummaryCache() {
  __memSummaryCache.clear();
  try { localStorage.removeItem(SUMMARY_CACHE_KEY); } catch (_) {}
}

function getSummaryCache(key) {
  const now = Date.now();
  const mem = __memSummaryCache.get(key);
  if (mem) {
    if (mem.expireAt <= now) { __memSummaryCache.delete(key); } 
    else if (mem.summary && isValidSummaryForCache(mem.summary)) { return mem.summary; } 
    else { __memSummaryCache.delete(key); }
  }
  const store = loadLocalCache_();
  const it = store ? store[key] : null;
  if (it) {
    if (it.expireAt <= now) { try { delete store[key]; saveLocalCache_(store); } catch (_) {} return null; }
    if (it.summary && isValidSummaryForCache(it.summary)) { __memSummaryCache.set(key, it); return it.summary; }
    try { delete store[key]; saveLocalCache_(store); } catch (_) {}
  }
  return null;
}

function setSummaryCache(key, summary) {
  if (!isValidSummaryForCache(summary)) return;
  const now = Date.now();
  const pack = { expireAt: now + SUMMARY_CACHE_TTL_MS, summary };
  __memSummaryCache.set(key, pack);
  const store = loadLocalCache_();
  store[key] = pack;
  try {
    for (const k of Object.keys(store)) {
      const it = store[k];
      if (!it || (it.expireAt && it.expireAt <= now) || !isValidSummaryForCache(it.summary)) { delete store[k]; }
    }
  } catch (_) {}
  saveLocalCache_(store);
}

/** =========================
* ✅ 정오표(Errata) 렌더
* ========================= */
function renderErrataHtml_(errata) {
  if (!errata || !errata.subjects) return "";
  const s = errata.subjects;
  const pctText = (pct) => (pct === null || pct === undefined) ? "-" : `${pct}%`;
  const asMap = (arr, key) => { const m = new Map(); (arr || []).forEach(it => { if (it && it[key] !== undefined) m.set(it[key], it); }); return m; };

  const section = (title, meta, innerHtml, open = false) => `
    <details class="err-acc" ${open ? "open" : ""} style="margin-top:12px; border:1px solid rgba(255,255,255,.08); border-radius:14px; overflow:hidden;">
      <summary style="list-style:none; cursor:pointer; padding:10px 12px; display:flex; align-items:center; justify-content:space-between; gap:10px; background: rgba(255,255,255,.04); font-weight:800;">
        <span>${escapeHtml(title)}</span>
        <span style="opacity:.7; font-size:12px; font-weight:600;">${escapeHtml(meta || "")}</span>
      </summary>
      <div style="padding:10px 12px;">${innerHtml}</div>
    </details>
  `;

  const renderTable = (oxArr, rateArr, qFrom, qTo) => {
    const oxMap = asMap(oxArr, "q");
    const rtMap = asMap(rateArr, "q");
    const rows = [];
    for (let q = qFrom; q <= qTo; q++) {
      const ox = oxMap.get(q)?.ox || "";
      const rt = rtMap.get(q);
      const isWrong = (ox !== "" && ox !== "O" && ox !== "○");
      const isHighPct = (rt && typeof rt.pct === "number" && rt.pct >= 70);
      const highlightPct = (isWrong && isHighPct);

      rows.push(`
        <tr>
          <td style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.06); text-align:right; width:52px;">${q}</td>
          <td class="${isWrong ? "errata-x-high" : ""}" style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.06); text-align:center; width:52px; font-weight:900;">${escapeHtml(ox || "")}</td>
          <td class="${highlightPct ? "errata-x-high" : ""}" style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.06); text-align:right; width:90px;">${escapeHtml(pctText(rt?.pct))}</td>
          <td style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.06); text-align:right; opacity:.8;">${rt ? `${rt.o}/${rt.n}` : "-"}</td>
        </tr>
      `);
    }

    return `
      <div style="overflow:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="background:rgba(255,255,255,.03);">
              <th style="padding:8px; text-align:right;">문항</th>
              <th style="padding:8px; text-align:center;">O/X</th>
              <th style="padding:8px; text-align:right;">정답률</th>
              <th style="padding:8px; text-align:right;">O/응시</th>
            </tr>
          </thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    `;
  };

  const info = errata.info || {};
  const korChoice = info.korChoice ? `선택: ${info.korChoice}` : "";
  const mathChoice = info.mathChoice ? `선택: ${info.mathChoice}` : "";
  const blocks = [];
  let firstOpenUsed = false;
  const pushAcc = (title, meta, html) => {
    const open = !firstOpenUsed; 
    if (!firstOpenUsed) firstOpenUsed = true;
    blocks.push(section(title, meta, html, open));
  };

  if (s.kor?.common) pushAcc("국어 공통", "문항 1~34" + (korChoice ? ` · ${korChoice}` : ""), renderTable(s.kor.common.ox, s.kor.common.rate, 1, 34));
  if (s.kor?.choice) pushAcc("국어 선택", "문항 35~45" + (korChoice ? ` · ${korChoice}` : ""), renderTable(s.kor.choice.ox, s.kor.choice.rate, 35, 45));
  if (s.math?.common) pushAcc("수학 공통", "문항 1~22" + (mathChoice ? ` · ${mathChoice}` : ""), renderTable(s.math.common.ox, s.math.common.rate, 1, 22));
  if (s.math?.choice) pushAcc("수학 선택", "문항 23~30" + (mathChoice ? ` · ${mathChoice}` : ""), renderTable(s.math.choice.ox, s.math.choice.rate, 23, 30));
  if (s.eng?.all) pushAcc("영어", "문항 1~45", renderTable(s.eng.all.ox, s.eng.all.rate, 1, 45));

  const tamItems = Array.isArray(s.tam?.items) ? s.tam.items : [];
  tamItems.forEach(it => {
    if (!it?.name || !it?.all) return;
    pushAcc(`탐구 (${it.name})`, "문항 1~20", renderTable(it.all.ox, it.all.rate, 1, 20));
  });

  const hasAny = blocks.length > 0;

  return `
    <div class="card" style="margin-top:14px;">
      <div class="card-head" style="display:flex; align-items:center; justify-content:space-between;">
        <div style="font-weight:800;">정오표</div>
        <div style="color:rgba(255,255,255,0.6); font-size:12px;">${escapeHtml(String(errata.errataSheetName || ""))}</div>
      </div>
      <div class="card-body" style="padding-top:6px;">
        ${hasAny ? blocks.join("") : `<div style="color:rgba(255,255,255,0.7); padding:10px 0;">정오표 데이터가 없습니다.</div>`}
        <style>
          details.err-acc > summary::-webkit-details-marker { display:none; }
          details.err-acc > summary:hover { background: rgba(255,255,255,.06) !important; }
          td.errata-x-high { background: rgba(255, 90, 90, 0.18); color: #ff6b6b; font-weight: 900; border-radius: 8px; }
        </style>
      </div>
    </div>
  `;
}

document.addEventListener("DOMContentLoaded", () => {
  (function ensureSelectTheme_() {
    const id = "adminSelectThemePatch";
    if (document.getElementById(id)) return;
    const st = document.createElement("style");
    st.id = id;
    st.textContent = `select, option { color: #111 !important; } select { background: rgba(255,255,255,0.9) !important; }`;
    document.head.appendChild(st);
  })();

  try {
    const sp = new URLSearchParams(location.search);
    if (sp.get("nocache") === "1") clearAllSummaryCache();
  } catch (_) {}

  const loginCard = $("loginCard");
  const adminArea = $("adminArea");
  const pwInput = $("pwInput");
  const loginBtn = $("loginBtn");
  const loginMsg = $("loginMsg");
  const logoutBtn = $("logoutBtn");
  const qInput = $("qInput");
  const searchBtn = $("searchBtn");
  const searchMsg = $("searchMsg");
  const resultList = $("resultList");
  const detailSub = $("detailSub");
  const detailBody = $("detailBody");
  const detailResult = $("detailResult");

  const sess = getAdminSession();
  if (sess?.adminToken) {
    loginCard.style.display = "none";
    adminArea.style.display = "block";
    logoutBtn.style.display = "inline-flex";
    applyAdminHeaderLabel_(sess);
    loadClassDashboard(); // ✅ 페이지 로드 시 대시보드 로드
  } else {
    applyAdminHeaderLabel_(null);
  }

  pwInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loginBtn.click(); });

  loginBtn.addEventListener("click", async () => {
    const pw = String(pwInput.value || "").trim();
    if (!pw) return setHint(loginMsg, "비밀번호를 입력하세요.", true);
    loginBtn.disabled = true;
    setHint(loginMsg, "로그인 중…");
    try {
      const data = await apiPost("admin_login", { password: pw });
      if (!data.ok) { setHint(loginMsg, data.error || "로그인 실패", true); return; }
      setAdminSession({ adminToken: data.adminToken, adminId: data.adminId, role: data.role, adminName: data.adminName });
      applyAdminHeaderLabel_(getAdminSession());
      setHint(loginMsg, "로그인 성공");
      loginCard.style.display = "none";
      adminArea.style.display = "block";
      logoutBtn.style.display = "inline-flex";
      loadClassDashboard(); // ✅ 로그인 성공 직후 대시보드 띄우기
    } catch (e) {
      setHint(loginMsg, "네트워크 오류", true);
    } finally {
      loginBtn.disabled = false;
    }
  });

  logoutBtn.addEventListener("click", () => { clearAdminSession(); location.reload(); });
  qInput.addEventListener("keydown", (e) => { if (e.key === "Enter") searchBtn.click(); });

  searchBtn.addEventListener("click", async () => {
    const sess = getAdminSession();
    if (!sess?.adminToken) return setHint(searchMsg, "관리자 로그인이 필요합니다.", true);
    const q = String(qInput.value || "").trim();
    if (!q) return setHint(searchMsg, "검색어를 입력하세요.", true);

    searchBtn.disabled = true;
    setHint(searchMsg, "검색 중…");
    resultList.innerHTML = "";
    detailSub.textContent = "학생을 선택하세요.";
    detailBody.innerHTML = "";
    detailResult.innerHTML = "";
    window.__lastStudent = null;

    try {
      const data = await apiPost("admin_search", { adminToken: sess.adminToken, q });
      if (!data.ok) { setHint(searchMsg, data.error || "검색 실패", true); return; }
      const items = Array.isArray(data.items) ? data.items : [];
      if (items.length === 0) { setHint(searchMsg, "검색 결과가 없습니다."); return; }
      setHint(searchMsg, `검색 결과 ${items.length}명`);

      resultList.innerHTML = items.map((it, idx) => {
        const seat = pick(it, ["seat","좌석"], "-");
        const name = pick(it, ["name","studentName","이름"], "-");
        const teacher = pick(it, ["teacher","담임"], "-");
        return `
          <button class="list-item" data-idx="${idx}"
            style="width:100%; text-align:left; border:1px solid rgba(255,255,255,.10); background: rgba(10,15,25,.55); color: inherit; padding: 12px 14px; border-radius: 12px; cursor: pointer; display:flex; align-items:center; gap:10px; transition: transform .08s ease, background .15s ease, border-color .15s ease; margin: 8px 0;"
          >
            <span style="opacity:.9; font-weight:700;">${escapeHtml(seat)}</span>
            <span style="opacity:.95;">${escapeHtml(name)}</span>
            <span style="opacity:.7;">·</span>
            <span style="opacity:.85;">담임 ${escapeHtml(teacher)}</span>
          </button>
        `;
      }).join("");

      resultList.querySelectorAll(".list-item").forEach(btn => {
        btn.addEventListener("mouseover", () => { btn.style.background = "rgba(20,30,50,.65)"; btn.style.borderColor = "rgba(255,255,255,.16)"; });
        btn.addEventListener("mouseout", () => { btn.style.background = "rgba(10,15,25,.55)"; btn.style.borderColor = "rgba(255,255,255,.10)"; btn.style.transform = "scale(1)"; });
        btn.addEventListener("mousedown", () => { btn.style.transform = "scale(0.99)"; });
        btn.addEventListener("mouseup", () => { btn.style.transform = "scale(1)"; });
        btn.addEventListener("click", async () => { const idx = Number(btn.dataset.idx); const st = items[idx]; await loadStudentDetail(st); });
      });

      if (items.length === 1) { await loadStudentDetail(items[0]); }
    } catch (e) {
      setHint(searchMsg, "네트워크 오류", true);
    } finally {
      searchBtn.disabled = false;
    }
  });

  async function issueStudentToken_(seat, studentId) {
    const sess = getAdminSession();
    const data = await apiPost("admin_issue_token", { adminToken: sess.adminToken, seat, studentId });
    if (!data.ok) throw new Error(data.error || "token 발급 실패");
    return data.token;
  }

  /**
 * ✅ [수정본] 데이터가 있는 최신 성적을 자동으로 찾아주는 로딩 엔진
 */
async function loadSummariesForStudent_(seat, studentId) {
  const summary = {};
  const token = await issueStudentToken_(seat, studentId);
  
  const [att, slp, mv, edu, examsResult, trend] = await Promise.allSettled([
    apiPost("attendance_summary", { token }),
    apiPost("sleep_summary", { token }),
    apiPost("move_summary", { token }),
    apiPost("eduscore_summary", { token }),
    apiPost("grade_exams", { token }),
    apiPost("grade_trend", { token })
  ]);

  summary.attendance = (att.status === "fulfilled") ? att.value : { ok:false };
  summary.sleep      = (slp.status === "fulfilled") ? slp.value : { ok:false };
  summary.move       = (mv.status === "fulfilled")  ? mv.value  : { ok:false };
  summary.eduscore   = (edu.status === "fulfilled") ? edu.value : { ok:false };
  summary.gradeTrend = (trend.status === "fulfilled") ? trend.value : { ok:false };

  // 💡 성적 데이터 자동 탐색 엔진 (최신순으로 뒤져서 데이터 있는 달을 찾음)
  if (examsResult.status === "fulfilled" && examsResult.value.ok) {
    const examItems = examsResult.value.items;
    let foundGrade = null;

    for (let i = examItems.length - 1; i >= 0; i--) {
      const gs = await apiPost("grade_summary", { token, exam: examItems[i].exam });
      if (gs.ok) {
        foundGrade = { ok: true, exam: examItems[i].exam, data: gs, exams: examItems, sheetName: gs.sheetName };
        break; 
      }
    }
    // 데이터가 하나도 없으면 드롭다운이라도 보이게 설정
    summary.grade = foundGrade || { ok: false, exam: examItems[examItems.length-1].exam, exams: examItems };
  }
  
  return summary;
}

  let __activeStudentKey = "";

  async function loadStudentDetail(st) {
    const sess = getAdminSession();
    if (!sess?.adminToken) return;

    const seat = String(pick(st, ["seat","좌석"], "")).trim();
    const studentId = String(pick(st, ["studentId","학번"], "")).trim();
    const name = String(pick(st, ["name","studentName","이름"], "")).trim();
    const key = makeStudentKey(seat, studentId);
    __activeStudentKey = key;

    detailSub.textContent = `${name} · ${seat} · ${studentId}`.trim();
    detailResult.innerHTML = "";

    // 💡 상세 데이터 프리페치 엔진 가동
    prefetchStudentDetails(seat, studentId);

    // 1️⃣ 보관함(Cache) 확인
    const cached = getSummaryCache(key);
    if (cached) {
      console.log(`⚡ ${name} 학생 데이터를 캐시에서 즉시 로드합니다.`);
      // 💡 중요: render 함수에 보내는 형식을 { student, summary } 로 통일
      renderStudentDetail({ student: st, summary: cached }); 
      return;
    }

    // 2️⃣ 보관함에 없을 때만 로딩 표시 후 호출
    detailBody.innerHTML = "데이터를 불러오는 중…";
    try {
      const data = await apiPost("admin_student_detail", { adminToken: sess.adminToken, seat, studentId });
      if (!data.ok) { detailBody.innerHTML = `<div style="color:#ff6b6b;">조회 실패</div>`; return; }
      
      const summary = await loadSummariesForStudent_(seat, studentId);
      // 💡 [추가] 직접 클릭해서 가져올 때도 이름표를 꼭 달아줍니다.
      summary.student = st;
      setSummaryCache(key, summary);
      data.summary = summary;
      renderStudentDetail(data);
    } catch (e) {
      detailBody.innerHTML = `<div style="color:#ff6b6b;">네트워크 오류</div>`;
    }
  }

  function renderStudentDetail(data) {
    const st = data.student || {};
    const sum = data.summary || {};
    const loading = !!sum.__loading;
    const att = sum.attendance || null;
    const slp = sum.sleep || null;
    const mv  = sum.move || null;
    const edu = sum.eduscore || null;
    const grd = sum.grade || null;

    // 💡 [신규] 경고 뱃지 자동 판별 로직
    let badgesHtml = "";
    if (!loading) {
      // 1. 🚨 출결 위험 뱃지: 전체 누적 출석률 < 70%
      if (att && att.ok && att.attRate !== undefined && att.attRate < 70) {
        badgesHtml += `<span style="display:inline-flex; align-items:center; margin-left:8px; background:rgba(231,76,60,0.15); color:#ff6b6b; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:800; border:1px solid rgba(231,76,60,0.4);">🚨 출결위험 (${att.attRate}%)</span>`;
      }
      // 2. ⚠️ 단기 결석 뱃지: 이번 주 결석 >= 3회
      if (att && att.ok && att.absent >= 3) {
        badgesHtml += `<span style="display:inline-flex; align-items:center; margin-left:6px; background:rgba(243,156,18,0.15); color:#f1c40f; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:800; border:1px solid rgba(243,156,18,0.4);">⚠️ 단기결석 (${att.absent}회)</span>`;
      }
      // 3. 🔴 벌점 과다 뱃지: 이번 달 벌점 누적 >= 10점
      if (edu && edu.ok && edu.monthTotal >= 10) {
        badgesHtml += `<span style="display:inline-flex; align-items:center; margin-left:6px; background:rgba(192,57,43,0.2); color:#ff4757; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:800; border:1px solid rgba(192,57,43,0.5);">🔴 벌점과다 (${edu.monthTotal}점)</span>`;
      }
    }

    // --- renderStudentDetail 함수 내부 ---
    detailBody.innerHTML = `
      <div style="margin-bottom:10px;">
        <div style="display:flex; gap:8px; margin:2px 0; align-items:center;">
          <div style="min-width:90px; opacity:.8;">이름</div>
          <div style="font-weight:600; display:flex; align-items:center; flex-wrap:wrap;">
            <span style="font-size:16px;">${escapeHtml(st.studentName || st.name || "-")}</span>
            ${badgesHtml}
            
            <button onclick="forceRefreshStudent()" title="이 학생 데이터 강제 새로고침"
              style="margin-left:10px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); 
                     color:rgba(255,255,255,0.4); cursor:pointer; font-size:14px; padding:2px 6px; 
                     border-radius:6px; transition:all 0.2s;"
              onmouseover="this.style.color='#3498db'; this.style.background='rgba(52,152,219,0.1)';"
              onmouseout="this.style.color='rgba(255,255,255,0.4)'; this.style.background='rgba(255,255,255,0.05)';"
              id="btnForceRefresh">
              🔄
            </button>
          </div>
        </div>
        ${fmtKeyVal("좌석", st.seat || "-")}
        ${fmtKeyVal("학번", st.studentId || "-")}
        ${fmtKeyVal("담임", st.teacher || "-")}
      </div>
      <div style="margin: 15px 0; padding-bottom: 15px; border-bottom: 1px dashed rgba(255,255,255,.1);">
        <button id="btnResetPw" class="btn" style="background: #e74c3c; color: white; padding: 8px 16px; font-size: 13px;">🔒 비밀번호 초기화</button>
        <p style="font-size: 11px; color: rgba(255,255,255,.5); margin-top: 6px;">* 초기화 시 학생은 다시 기존 4자리 번호로 로그인해야 합니다.</p>
      </div>
      
      <div class="grid-2" style="margin-top:10px; display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
        
        <section class="card" style="padding:14px; margin:0;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px;">
            <div class="card-title" style="font-size:15px; margin:0;">📅 출결 요약</div>
            <button class="btn btn-ghost btn-mini" id="btnAttDetail" style="padding:6px 10px;">상세</button>
          </div>
          <div class="card-sub">
            ${(() => {
              if (!att || !att.ok) return loading ? "불러오는 중…" : "데이터 없음";
              
              // 💡 1. [이번 주] 출석률 계산
              const wAtt = att.present ?? 0;
              const wLate = att.weekLate ?? 0;
              const wAbs = att.absent ?? 0;
              const wTotal = wAtt + wLate + wAbs;
              const wRate = wTotal > 0 ? Math.round((wAtt / wTotal) * 100) : 0;
              
              let wColor = "#3498db"; // 이번 주는 긍정적인 파란색!
              if (wRate < 80) wColor = "#f1c40f";
              if (wRate < 60) wColor = "#e74c3c";

              // 💡 2. [전체 누적] 출석률 계산
              const tRate = att.attRate ?? 0;
              let tColor = "#2ecc71"; // 누적은 든든한 초록색!
              if (tRate < 80) tColor = "#f1c40f";
              if (tRate < 60) tColor = "#e74c3c";
              
              return `
                <div style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px dashed rgba(255,255,255,0.1);">
                  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                    <span style="font-weight: 800; color: ${wColor};">이번 주 출석률</span>
                    <span style="font-weight: 900; color: ${wColor}; font-size: 15px;">${wRate}%</span>
                  </div>
                  <div style="width: 100%; background: rgba(255,255,255,0.1); border-radius: 4px; height: 6px; overflow: hidden; margin-bottom: 8px;">
                    <div style="width: ${wRate}%; background: ${wColor}; height: 100%; border-radius: 4px; transition: width 0.5s ease-out;"></div>
                  </div>
                  <div style="font-size: 12px; color: rgba(255,255,255,0.7); display: flex; justify-content: space-between;">
                    <span>출석 <b>${wAtt}</b></span>
                    <span>지각 <b style="color:#f1c40f;">${wLate}</b></span>
                    <span>결석 <b style="color:#e74c3c;">${wAbs}</b></span>
                  </div>
                </div>
                
                <div style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px dashed rgba(255,255,255,0.1);">
                  <div style="font-size: 13px; color: rgba(255,255,255,0.85); display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-weight: 700;">전체 누적 출석률</span>
                    <span style="color: ${tColor}; font-weight: 800;">${tRate}%</span>
                  </div>
                  <div style="font-size: 11px; color: rgba(255,255,255,0.5); display: flex; justify-content: space-between; margin-top: 4px;">
                    <span>출석 ${att.totalAtt ?? 0}</span>
                    <span>지각 ${att.totalLate ?? 0}</span>
                    <span>결석 ${att.totalAbs ?? 0}</span>
                  </div>
                </div>

                <div style="font-size: 13px; color: rgba(255,255,255,0.8);">
                  최근 결석: ${Array.isArray(att.recentAbsences) && att.recentAbsences.length ? `<ul style="margin:4px 0 0 16px; padding:0; color:#e74c3c;">${att.recentAbsences.map(x => `<li>${escapeHtml(x.md)}(${escapeHtml(x.dow)}) ${escapeHtml(x.period)}교시</li>`).join("")}</ul>` : "<span style='color:#2ecc71;'>없음</span>"}
                </div>
              `;
            })()}
          </div>
        </section>

        <section class="card" style="padding:14px; margin:0;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px;"><div class="card-title" style="font-size:15px; margin:0;">🚶‍♂️ 이동 요약</div><button class="btn btn-ghost btn-mini" id="btnMoveDetail" style="padding:6px 10px;">상세</button></div>
          <div class="card-sub">
            ${mv && mv.ok ? `
              최근 이동: <b>${escapeHtml(mv.latestText || "-")}</b><br>
              ${escapeHtml(mv.latestDateTime || "")}
            ` : (loading ? "불러오는 중…" : "데이터 없음")}
          </div>
        </section>

        <section class="card" style="padding:14px; margin:0;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px;"><div class="card-title" style="font-size:15px; margin:0;">💤 취침 요약</div><button class="btn btn-ghost btn-mini" id="btnSleepDetail" style="padding:6px 10px;">상세</button></div>
          <div class="card-sub">
            ${slp && slp.ok ? `
              최근 7일 취침일수: <b>${slp.sleepCount7d ?? 0}</b><br>
              최근 7일 취침횟수: <b>${slp.sleepTotal7d ?? 0}</b>
            ` : (loading ? "불러오는 중…" : "데이터 없음")}
          </div>
        </section>

        <section class="card" style="padding:14px; margin:0;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px;"><div class="card-title" style="font-size:15px; margin:0;">🚨 교육점수 요약</div><button class="btn btn-ghost btn-mini" id="btnEduDetail" style="padding:6px 10px;">상세</button></div>
          <div class="card-sub">
            ${edu && edu.ok ? `
              이번달 누적점수: <b>${edu.monthTotal ?? 0}</b><br>
              최근 항목: <b>${escapeHtml(edu.latestText || "-")}</b><br>
              ${escapeHtml(edu.latestDateTime || "")}
            ` : (loading ? "불러오는 중…" : "데이터 없음")}
          </div>
        </section>

      </div>

      <div id="lifeDetailContainer" style="margin-top: 14px;"></div>

      <div style="display: flex; flex-direction: column; gap: 14px; margin-top: 14px;">
        
        <section class="card" style="padding:14px; margin:0;">
          <div style="display:flex; flex-direction:column; gap:12px; margin-bottom:12px;">
            
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
              <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                <div class="card-title" style="font-size:15px; margin:0; white-space:nowrap;">📈 성적 추이</div>
                
                <div id="chartModeToggle" style="display:flex; gap:4px; background:rgba(255,255,255,0.05); padding:2px; border-radius:8px; border:1px solid rgba(255,255,255,0.1);">
                  <button class="btn btn-mini mode-btn active" data-mode="pct" style="background:#3498db; border:none; padding:4px 10px; font-size:11px; border-radius:6px; cursor:pointer; color:white; font-weight:bold;">백분위</button>
                  <button class="btn btn-mini mode-btn" data-mode="raw" style="background:transparent; border:none; padding:4px 10px; font-size:11px; border-radius:6px; cursor:pointer; color:rgba(255,255,255,0.5);">원점수</button>
                </div>

                <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                  <button id="btnToggleTop30" class="btn btn-mini" style="background:transparent; border:1px solid rgba(255,255,255,0.3); padding:4px 10px; font-size:11px; border-radius:6px; cursor:pointer; color:rgba(255,255,255,0.5); font-weight:bold;">전체 상위 30% OFF</button>
                  
                  <div id="classButtonsContainer" style="display:flex; gap:6px; flex-wrap:wrap;"></div>
                </div>
              </div>
            </div>

            <div id="chartFilters" style="display:flex; gap:5px; flex-wrap:wrap;">
              <button class="btn btn-mini filter-btn active" data-index="0" style="background:#3498db; border:none;">국어</button>
              <button class="btn btn-mini filter-btn active" data-index="1" style="background:#e74c3c; border:none;">수학</button>
              <button class="btn btn-mini filter-btn active" data-index="2" style="background:#2ecc71; border:none;">탐구1</button>
              <button class="btn btn-mini filter-btn active" data-index="3" style="background:#f1c40f; border:none;">탐구2</button>
              <button class="btn btn-mini filter-btn active" data-index="4" style="background:#9b59b6; border:none;">영어</button>
            </div>
          </div>
          
          <div style="height: 240px; position: relative;"><canvas id="adminGradeTrendChart"></canvas></div>
          <div id="trendChartLoading" class="muted" style="font-size:12px; margin-top:5px;">데이터 분석 중...</div>
        </section>
        
<section class="card" style="padding:14px; margin:0;">
  <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
    <div style="display:flex; align-items:center; gap:10px;">
      <div class="card-title" style="font-size:15px; margin:0;">📊 성적 요약</div>
      ${grd && Array.isArray(grd.exams) && grd.exams.length ? `
        <select id="gradeSummarySelect" class="select" style="min-width:140px; font-size:13px; padding:4px 8px;">
          ${!grd.ok ? `<option value="" selected disabled>시험을 선택하세요</option>` : ''}
          ${grd.exams.map(it => {
            const ex = String(it.exam || "");
            const label = String(it.label || it.name || ex || "");
            const sel = (ex === String(grd.exam || "")) ? "selected" : "";
            return `<option value="${escapeHtml(ex)}" ${sel}>${escapeHtml(label)}</option>`;
          }).join("")}
        </select>
      ` : ``}
    </div>
    <button class="btn btn-ghost btn-mini" id="btnGradeDetail" style="padding:6px 10px;">상세</button>
  </div>
  
  <div class="card-sub" style="margin-top:10px;">
    <div id="gradeSummaryLabel" style="margin-bottom:8px; font-weight:600; color:rgba(255,255,255,0.8);">
      ${grd && grd.ok ? `(${escapeHtml(grd.sheetName || "")})` : ""}
    </div>

    <div id="gradeSummaryTable">
      ${grd && grd.ok 
        ? renderGradeTableHtml_(buildGradeTableRows_(grd.data || grd || {})) 
        : `
          <div style="text-align:center; padding:30px 10px; color:rgba(255,255,255,0.5); border:1px dashed rgba(255,255,255,0.1); border-radius:12px;">
            <div style="font-size:20px; margin-bottom:8px;">💡</div>
            이 시험은 아직 성적 데이터가 없습니다.<br>
            상단 드롭다운에서 성적을 <b style="color:#3498db;">선택하세요</b>.
          </div>
        `}
    </div>
  </div>
</section>

      </div>
    `;

    // 🌟 버튼 이벤트들 (단순하게 변경됨)
    $("btnAttDetail").addEventListener("click", () => loadDetail("attendance"));
    $("btnSleepDetail").addEventListener("click", () => loadDetail("sleep_detail"));
    $("btnMoveDetail").addEventListener("click", () => loadDetail("move_detail"));
    $("btnEduDetail").addEventListener("click", () => loadDetail("eduscore_detail"));
    $("btnGradeDetail").addEventListener("click", () => loadDetail("grade_detail"));

    const btnResetPw = $("btnResetPw");
    if (btnResetPw) {
      btnResetPw.onclick = async () => {
        const adminSess = getAdminSession();
        if (!adminSess?.adminToken) return alert("관리자 권한이 없습니다.");
        if (!confirm(`${st.studentName} 학생의 비밀번호를 초기화하시겠습니까?\n(변경된 10자리 번호가 삭제됩니다.)`)) return;
        try {
          btnResetPw.disabled = true;
          btnResetPw.textContent = "처리 중...";
          const res = await apiPost("admin_reset_password", { adminToken: adminSess.adminToken, studentId: st.studentId });
          if (res.ok) {
            alert("비밀번호가 성공적으로 초기화되었습니다.\n이제 기존 4자리 번호로 로그인이 가능합니다.");
            clearSummaryCache(makeStudentKey(st.seat, st.studentId));
          } else {
            alert("초기화 실패: " + res.error);
          }
        } catch (e) {
          alert("네트워크 오류가 발생했습니다.");
        } finally {
          btnResetPw.disabled = false;
          btnResetPw.textContent = "🔒 비밀번호 초기화";
        }
      };
    }

    const gradeSel = $("gradeSummarySelect");
    if (gradeSel) {
      gradeSel.addEventListener("change", async () => {
        try {
          const seat2 = String(st.seat || "").trim();
          const studentId2 = String(st.studentId || "").trim();
          if (!seat2 && !studentId2) return;
          const exam = String(gradeSel.value || "");
          const labelHost = $("gradeSummaryLabel");
          const tableHost = $("gradeSummaryTable");
          if (tableHost) tableHost.innerHTML = `<div style="opacity:.8;">불러오는 중…</div>`;
          const token2 = await issueStudentToken_(seat2, studentId2);
          const gs2 = await apiPost("grade_summary", { token: token2, exam });
          if (!gs2.ok) throw new Error(gs2.error || "grade_summary 실패");
          if (labelHost) labelHost.innerHTML = `(${escapeHtml(gs2.sheetName || "")})`;
          if (tableHost) tableHost.innerHTML = renderGradeTableHtml_(buildGradeTableRows_(gs2));
        } catch (e) {
          const tableHost = $("gradeSummaryTable");
          if (tableHost) tableHost.innerHTML = `<div style="color:#ff6b6b;">${escapeHtml(e?.message || "성적 조회 오류")}</div>`;
        }
      });
    }
    loadAdminGradeTrend(st.seat, st.studentId);
  }

  async function loadAdminGradeDetailUI_(token, initialExam) {
    const host = $("detailResult");
    if (!host) return;

    // ✅ 정오표 밑에 취약 영역 분석 캔버스 영역 추가
    host.innerHTML = `
      <div class="card" style="padding:14px;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
          <div style="font-weight:700;">성적</div>
          <select id="adminGradeExamSelect" class="btn btn-ghost btn-mini" style="padding:6px 10px; max-width: 280px;"></select>
        </div>
        <p id="adminGradeLoading" class="muted" style="margin-top:10px;">불러오는 중...</p>
        <p id="adminGradeError" class="msg" style="margin-top:6px;"></p>
        
        <div id="adminGradeTableWrap" style="display:none;"></div>

        <div id="vulnChartWrapper" style="display:none; margin-top: 24px; padding-top: 20px; border-top: 1px dashed rgba(255,255,255,0.1);">
          <div class="card-title" style="font-size:15px; margin-bottom:10px;">🕸️ 취약 영역 분석 (단원별 성취도)</div>
          <div style="height: 280px; position: relative;">
            <canvas id="vulnRadarChart"></canvas>
          </div>
          <div id="vulnChartMsg" class="muted" style="font-size:12px; margin-top:10px; text-align:center;">
            데이터 분석 중...
          </div>
        </div>
      </div>
    `;

    const sel = $("adminGradeExamSelect");
    const loading = $("adminGradeLoading");
    const error = $("adminGradeError");
    const wrap = $("adminGradeTableWrap");
    const vulnWrapper = $("vulnChartWrapper"); // ✅ 추가

    try {
      const exams = await apiPost("grade_exams", { token });
      if (!exams.ok || !Array.isArray(exams.items) || !exams.items.length) { throw new Error(exams.error || "시험 목록이 없습니다."); }
      sel.innerHTML = exams.items.map(it => {
        const v = String(it.exam || "");
        const lab = String(it.label || it.name || it.sheetName || v);
        return `<option value="${escapeHtml(v)}">${escapeHtml(lab)}</option>`;
      }).join("");

      const preferred = (initialExam != null) ? String(initialExam).trim() : "";
      const fallback = String(exams.items[exams.items.length - 1].exam || "");
      if (preferred && Array.from(sel.options).some(o => o.value === preferred)) { sel.value = preferred; } 
      else { sel.value = fallback; }

      sel.addEventListener("change", () => fetchAndRender(sel.value));
      await fetchAndRender(sel.value);
    } catch (e) {
      loading.textContent = "";
      error.textContent = e?.message || "성적 불러오기 실패";
      wrap.style.display = "none";
      if (vulnWrapper) vulnWrapper.style.display = "none";
    }

    async function fetchAndRender(exam) {
      try {
        loading.textContent = "불러오는 중...";
        error.textContent = "";
        wrap.style.display = "none";
        wrap.innerHTML = "";
        if (vulnWrapper) vulnWrapper.style.display = "none"; // ✅ 로딩 중 숨김

        const data = await apiPost("grade_summary", { token, exam: String(exam || "") });
        if (!data.ok) throw new Error(data.error || "성적 불러오기 실패");

        let errata = null;
        try {
          const e2 = await apiPost("grade_errata", { token, exam: String(exam || "") });
          if (e2 && e2.ok) {
            errata = e2;
          }
        } catch (_) { /* ignore */ }

        // ✅ 1. 정오표 그리기
        wrap.innerHTML = (errata ? renderErrataHtml_(errata) : `<div class="muted">정오표 데이터가 없습니다.</div>`);
        wrap.style.display = "block";
        loading.textContent = "";

        // ✅ 2. 취약 영역 분석 그리기
        if (errata && errata.analysis && errata.analysis.units) {
          if (vulnWrapper) vulnWrapper.style.display = "block"; // 분석 결과가 있으면 보이기
          renderVulnerabilityChart(errata.analysis.units, token);
        }

      } catch (e) {
        loading.textContent = "";
        error.textContent = e?.message || "성적 불러오기 실패";
        wrap.style.display = "none";
        if (vulnWrapper) vulnWrapper.style.display = "none";
      }
    }
  }

  /**
   * ✅ [최종] 항목/기간 전환 캐시 + 백그라운드 프리페칭 적용
   */
  window.loadDetail = async function(kind, days = 7) {
    const sess = getAdminSession();
    if (!sess?.adminToken) return;
    if (!window.__lastStudent) { 
      detailResult.innerHTML = `<div style="color:#ff6b6b;">학생을 먼저 선택하세요.</div>`; 
      return; 
    }

    const st = window.__lastStudent;
    const seat = st.seat || "";
    const studentId = st.studentId || "";

    // 1️⃣ 상세 페이지 진입 즉시, 이 학생의 다른 기간(15, 30일) 데이터 예약 로딩 (엔진 2 가동)
    prefetchStudentDetails(seat, studentId);

    // 2️⃣ 캐시 열쇠 생성
    const cacheKey = makeDetailCacheKey(seat, studentId, kind, days);

    const lifeContainer = $("lifeDetailContainer");
    const gradeContainer = $("detailResult");
    const isGrade = (kind === "grade_detail");
    const targetEl = isGrade ? gradeContainer : (lifeContainer || gradeContainer);

    // 화면 정리
    if (isGrade && lifeContainer) lifeContainer.innerHTML = "";
    if (!isGrade && gradeContainer) gradeContainer.innerHTML = "";

    // 💡 [수정 포인트] 성적 상세인 경우, 기존의 전용 렌더링 함수를 호출하고 즉시 리턴
    if (kind === "grade_detail") {
       const token = await issueStudentToken_(seat, studentId);
       loadAdminGradeDetailUI_(token); 
       return; 
    }

    // 3️⃣ 캐시 확인 (항목/기간 전환 시 이미 본 적 있다면 즉시 출력)
    const cachedData = getDetailCache(cacheKey);
    if (cachedData) {
      console.log(`[캐시 히트] ${kind} - ${days}일 데이터 표시`);
      renderDetailView(kind, days, cachedData, targetEl);
      return; 
    }

    // 4️⃣ 캐시가 없을 때만 서버 요청
    targetEl.innerHTML = "불러오는 중…";

    try {
      const token = await issueStudentToken_(seat, studentId);
      
      // 출결(attendance)은 별도 로직
      if (kind === "attendance") {
        const [att, mv, edu] = await Promise.all([ 
          apiPost("attendance", { token }), 
          apiPost("move_detail", { token, days: 180 }),
          apiPost("eduscore_detail", { token, days: 180 })
        ]);
        if (!att.ok) return showError(att, targetEl);
        const moveMap = (mv && mv.ok) ? buildMoveMapFromItems_(mv.items) : {};
        targetEl.innerHTML = renderAttendanceDetail_(att, moveMap);
        return;
      }

      // 이동, 취침, 벌점 데이터 가져오기
      const data = await apiPost(kind, { token, days: days });
      if (!data.ok) return showError(data, targetEl);

      // 보관함에 저장
      setDetailCache(cacheKey, data);
      renderDetailView(kind, days, data, targetEl);

    } catch (e) {
      targetEl.innerHTML = `<div style="color:#ff6b6b;">${escapeHtml(e.message || "오류")}</div>`;
    }
  };
    
  // showError 함수도 targetEl을 받도록 업데이트
  function showError(data, targetEl) { 
    const el = targetEl || $("detailResult");
    el.innerHTML = `<div style="color:#ff6b6b;">${escapeHtml(data.error || "오류")}</div>`; 
  }

  function renderSimpleTable_(headers, rows) {
    const th = headers.map(h => `<th style="text-align:left; padding:8px; border-bottom:1px solid rgba(255,255,255,.08);">${escapeHtml(h)}</th>`).join("");
    const tr = rows.map(r => `<tr>${r.map(c => `<td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06);">${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
    return `<div style="overflow:auto;"><table style="width:100%; border-collapse:collapse; font-size:14px;"><thead><tr>${th}</tr></thead><tbody>${tr || `<tr><td style="padding:10px; opacity:.8;" colspan="${headers.length}">데이터 없음</td></tr>`}</tbody></table></div>`;
  }

  /**
   * ✅ 데이터를 받아 화면에 실제로 그려주는 함수
   */
  function renderDetailView(kind, days, data, targetEl) {
    if (kind === "sleep_detail") {
      targetEl.innerHTML = renderPeriodSelector_(kind, days) + renderSleepDetail_(data);
    } else if (kind === "move_detail") {
      targetEl.innerHTML = renderPeriodSelector_(kind, days) + renderSimpleTable_(["날짜", "시간", "사유", "복귀교시"], (data.items || []).map(x => [x.date, x.time, x.reason, x.returnPeriod]));
    } else if (kind === "eduscore_detail") {
      targetEl.innerHTML = renderPeriodSelector_(kind, days) + renderSimpleTable_(["날짜", "시간", "사유", "점수"], (data.items || []).map(x => [x.date, x.time, x.reason, x.score]));
    }
  }

  /**
   * ✅ [최종 안정화 버전] 전 학생 데이터 백그라운드 로딩 엔진
   * - 구글 서버 부하를 방지하기 위해 속도를 조절하고 에러 처리를 강화함
   */
  async function prefetchAllSummaries(items) {
    console.log("🚀 전 학생 데이터 백그라운드 로딩 시작...");
    
    const total = items.length;
    let current = 0;
    let errorCount = 0; // 연속 에러 횟수 체크
    const dashHeader = document.querySelector("#dashHeader span");

    for (const st of items) {
      current++;
      const studentId = String(st.studentId || st.학번 || "").trim();
      if (!studentId) continue;

      const key = makeStudentKey(st.seat, studentId);
      
      // 이미 데이터가 있다면 패스
      if (getSummaryCache(key)) {
        if (dashHeader) dashHeader.innerHTML = `📊 현황 <span style="font-size:12px; color:#3498db;">(${current}/${total} 완료)</span>`;
        continue;
      }

      // 대기 시간: 1초 (구글 할당량 제한 방지용)
      await new Promise(res => setTimeout(res, 1000));

      try {
        const summary = await loadSummariesForStudent_(st.seat, studentId);
        if (summary) {
          summary.student = st;
          setSummaryCache(key, summary);
          console.log(`✅ [${current}/${total}] ${st.name} 로드 완료`);
          updateRiskNoticePanel();
          errorCount = 0; // 성공하면 에러 카운트 초기화
        }
      } catch (e) {
        errorCount++;
        console.warn(`⚠️ [${current}/${total}] ${st.name} 로드 실패:`, e.message);
        
        // 연속으로 3번 이상 에러가 나면 서버가 과부화된 것이므로 잠시 더 쉼
        if (errorCount >= 3) {
          console.log("⏳ 연속 에러 발생으로 10초간 정지합니다...");
          await new Promise(res => setTimeout(res, 10000));
          errorCount = 0;
        }
      }

      if (dashHeader) {
        dashHeader.innerHTML = `📊 현황 <span style="font-size:12px; color:#f1c40f;">(${current}/${total} 로딩 중...)</span>`;
      }
    }

    if (dashHeader) {
      const role = getAdminSession()?.role === "super" ? "학원 전체" : "오늘의 우리 반";
      dashHeader.innerHTML = `📊 ${role} 현황 <span style="font-size:12px; color:#2ecc71;">(모든 데이터 로드 완료)</span>`;
    }
  }

  /**
   * ✅ [엔진 2] 선택된 학생의 15일/30일치 상세 데이터를 미리 로딩 (클릭 직후)
   */
  async function prefetchStudentDetails(seat, studentId) {
    const kinds = ["move_detail", "sleep_detail", "eduscore_detail"];
    const periods = [15, 30]; // 7일은 이미 요청했을 것이므로 15, 30만 미리 가져옴
    
    try {
      const token = await issueStudentToken_(seat, studentId);
      for (const kind of kinds) {
        for (const days of periods) {
          const cacheKey = makeDetailCacheKey(seat, studentId, kind, days);
          if (getDetailCache(cacheKey)) continue; // 이미 있으면 패스

          await new Promise(res => setTimeout(res, 300)); // 0.3초 간격
          apiPost(kind, { token, days: days }).then(data => {
            if (data.ok) setDetailCache(cacheKey, data);
          }).catch(() => {});
        }
      }
    } catch (e) {}
  }
    
  /**
   * ✅ 기간 선택 바 렌더링 (이동, 취침, 교육점수 전용)
   */
  function renderPeriodSelector_(kind, currentDays) {
    const options = [7, 15, 30];
    const buttons = options.map(d => `
      <button onclick="window.loadDetail('${kind}', ${d})" 
              style="padding: 4px 10px; border-radius: 6px; font-size: 11px; cursor: pointer;
                     border: 1px solid ${currentDays === d ? '#3498db' : 'rgba(255,255,255,0.15)'};
                     background: ${currentDays === d ? 'rgba(52, 152, 219, 0.2)' : 'rgba(255,255,255,0.03)'};
                     color: ${currentDays === d ? '#3498db' : 'rgba(255,255,255,0.7)'};
                     font-weight: ${currentDays === d ? '800' : 'normal'};
                     transition: all 0.2s;">
        ${d}일
      </button>
    `).join("");

    return `
      <div style="display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-bottom: 12px;">
        <span style="font-size: 11px; opacity: 0.5;">조회 기간:</span>
        ${buttons}
      </div>
    `;
  }

  // 💡 여기서부터 renderAttendanceDetail_ 함수 전체를 다시 채워 넣으세요!
  function renderAttendanceDetail_(data, moveMap) {
  const blocks = data.allBlocks && data.allBlocks.length > 0 ? data.allBlocks : [{ dates: data.dates, rows: data.rows }];
  if (!blocks || blocks.length === 0 || !blocks[0].dates || !blocks[0].dates.length) return "출결 상세 데이터가 없습니다.";

  function mapAttendance_(val) {
  const t = String(val ?? "").trim();
  if (t === "1") return "출석"; if (t === "3") return "결석"; if (t === "2") return "지각"; if (t === "4") return "조퇴"; return t || "-";
  }

  function statusStyle_(val) {
  const t0 = String(val || "").trim();
  const t = (t0 === "1") ? "출석" : (t0 === "3") ? "결석" : t0;
  if (!t || t === "-" ) return "opacity:.55;";
  if (t.includes("출석")) return "background: rgba(46, 204, 113, .22);";
  if (t.includes("결석")) return "background: rgba(231, 76, 60, .22);";
  if (t.includes("지각")) return "background: rgba(241, 196, 15, .22);";
  if (t.includes("조퇴")) return "background: rgba(155, 89, 182, .22);";
  if (t.includes("외출")) return "background: rgba(52, 152, 219, .22);";
  // 💡 [신규] 공결(인정결석) 색상 추가 (차분한 회색)
  if (t.includes("공결")) return "background: rgba(255, 255, 255, 0.1); color: rgba(255,255,255,0.7); font-weight:normal;";
  return "background: rgba(255,255,255,.06);";
  }

  let selectorHtml = "";
  if (blocks.length > 1) {
  selectorHtml += `
         <div style="margin-bottom: 16px; display: flex; align-items: center; gap: 10px; background: rgba(255,255,255,0.03); padding: 10px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.08);">
           <span style="font-weight: 800; color: #3498db; font-size: 14px;">📅 주차 선택</span>
           <select onchange="if(window.switchWeekTable) window.switchWeekTable(this.value)" style="padding: 6px 12px; border-radius: 6px; background: #1a202c; color: white; border: 1px solid rgba(255,255,255,0.2); outline: none; font-size: 14px; cursor: pointer; min-width: 200px;">
       `;
  blocks.forEach((block, idx) => {
  const dates = block.dates || [];
  if (!dates.length) return;
  const sDate = dates[0].md;
  const eDate = dates[dates.length - 1].md;
  const label = idx === 0 ? `이번 주 (${sDate} ~ ${eDate})` : `이전 기록 (${sDate} ~ ${eDate})`;
  selectorHtml += `<option value="${idx}">${label}</option>`;
  });
  selectorHtml += `</select></div>`;
  }

  const tablesHtml = blocks.map((block, bIdx) => {
  const dates = block.dates || [];
  const rows = block.rows || [];
  if (!dates.length || !rows.length) return "";

  const showN = Math.min(14, dates.length);
  const idxSorted = dates.map((d, i) => ({ i, iso: d.iso || "" })).filter(x => x.iso).sort((a,b) => a.iso.localeCompare(b.iso));
  const lastIdx = idxSorted.slice(-showN).map(x => x.i);

  const thTop = `<th rowspan="2" style="position:sticky; left:0; z-index:3; background:rgba(8,12,20,.92); padding:10px; border-bottom:1px solid rgba(255,255,255,.10); width:60px;">교시</th>${lastIdx.map(i => `<th colspan="2" style="text-align:center; padding:10px; border-bottom:1px solid rgba(255,255,255,.10);">${escapeHtml(`${dates[i].md}(${dates[i].dow})`)}</th>`).join("")}`;
  const thSub = lastIdx.map(() => `<th style="text-align:left; padding:8px 10px; border-bottom:1px solid rgba(255,255,255,.08); opacity:.85;">스케줄</th><th style="text-align:left; padding:8px 10px; border-bottom:1px solid rgba(255,255,255,.08); opacity:.85;">출/결</th>`).join("");

  const bodyTr = rows.map(r => {
  const period = r.period || "";
  // 💡 [핵심] 교시 텍스트에서 숫자만 안전하게 뽑아내어 매칭 확률 100%로 상향
  const pNumFront = parseInt(String(period).replace(/\D/g, ''), 10) || 0; 

  const cells = r.cells || [];
  const tds = lastIdx.map(i => {
  const c = cells[i] || {};
  const sRaw = String(c.s ?? "").trim();  
  const iso = String((dates[i] && dates[i].iso) || "").trim();

  // 💡 완벽하게 매칭된 이동(지각) 사유 가져오기
  const mvReason = (moveMap && moveMap[iso] && moveMap[iso][pNumFront]) ? String(moveMap[iso][pNumFront]) : "";

  // 1. 스케줄 칸 텍스트 조립
  let s = sRaw;
  if (sRaw === "" || sRaw === "-") {
  s = escapeHtml(mvReason);
  } else if (mvReason.includes("지각")) {
  s = escapeHtml(sRaw) + " <span style='color:#f1c40f; font-size:11px; font-weight:bold;'>(" + escapeHtml(mvReason) + ")</span>";
  } else {
  s = escapeHtml(sRaw);
  }

  // 2. 출결 상태 라벨 조립
  const aRaw = String(c.a ?? "").trim();   
  let aText = mapAttendance_(aRaw);     

  // 💡 [원상복구] 시트에 '3(결석)'으로 입력되어 있으면 그대로 빨간색 결석으로 둡니다.
  // (단, '지각'으로 연동된 기록이 있을 때만 노란색 지각으로 바꿔줍니다.)
  if (aRaw === "3" && mvReason.includes("지각")) {
  aText = "지각"; 
  }

  return `<td style="padding:10px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${s || "-"}</td><td style="padding:10px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap; ${statusStyle_(aText)}">${escapeHtml(aText)}</td>`;
  }).join("");
  return `<tr><td style="position:sticky; left:0; z-index:2; background:rgba(8,12,20,.92); padding:10px; border-bottom:1px solid rgba(255,255,255,.06); font-weight:700;">${escapeHtml(period)}</td>${tds}</tr>`;
  }).join("");

  const displayStyle = bIdx === 0 ? "block" : "none";

  return `
         <div id="week-table-block-${bIdx}" class="attendance-week-block" style="display: ${displayStyle}; animation: fadeIn 0.3s ease;">
           <div style="overflow:auto; border-radius:14px; border:1px solid rgba(255,255,255,.08);">
             <table style="width:max-content; min-width:100%; border-collapse:separate; border-spacing:0; font-size:14px;">
               <thead style="background: rgba(255,255,255,.03);">
                 <tr>${thTop}</tr>
                 <tr>${thSub}</tr>
               </thead>
               <tbody>
                 ${bodyTr || `<tr><td style="padding:12px; opacity:.8;" colspan="${1 + lastIdx.length*2}">데이터 없음</td></tr>`}
               </tbody>
             </table>
           </div>
         </div>
       `;
  });

  return selectorHtml + tablesHtml.join("");
  }

  function renderSleepDetail_(data) {
  const groups = data.groups || [];
  if (!groups.length) return "취침 상세 데이터가 없습니다.";
  const rows = [];
  groups.forEach(g => {
  const dateIso = g.dateIso || "";
  const total = g.total ?? 0;
  const details = Array.isArray(g.details) ? g.details : [];
  if (!details.length) { rows.push([dateIso, "", "취침", total]); } 
  else { details.forEach(d => { rows.push([dateIso, d.period || "-", d.reason || "취침", d.count ?? 0]); }); }
  });
  return renderSimpleTable_(["날짜", "교시", "사유", "횟수"], rows);
  }

  const _origRender = renderStudentDetail;
  renderStudentDetail = function(data){
  window.__lastStudent = { seat: data?.student?.seat || "", studentId: data?.student?.studentId || "", studentName: data?.student?.studentName || "", teacher: data?.student?.teacher || "" };
  _origRender(data);
  };

  /**
   * ✅ [최종 통합] 성적 그래프 그리기 (보관함 우선 조회 + 필터 연결)
   */
  async function loadAdminGradeTrend(seat, studentId) {
    const canvas = $("adminGradeTrendChart");
    const loadingMsg = $("trendChartLoading");
    if (!canvas) return;

    const key = makeStudentKey(seat, studentId);
    const cachedSummary = getSummaryCache(key);

    // 1. 이미 보관함(Summary)에 성적 데이터가 있다면 즉시 그립니다.
    if (cachedSummary && cachedSummary.gradeTrend && cachedSummary.gradeTrend.items) {
      console.log("📈 성적 그래프를 보관함에서 즉시 로드합니다.");
      if (loadingMsg) loadingMsg.style.display = "none";
      renderTrendChart_(cachedSummary.gradeTrend.items);
      return;
    }

    // 2. 보관함에 없다면 서버에서 새로 가져옵니다.
    try {
      const token = await issueStudentToken_(seat, studentId);
      const res = await apiPost("grade_trend", { token });
      if (!res.ok || !res.items || res.items.length === 0) {
        if (loadingMsg) loadingMsg.textContent = "데이터가 부족합니다.";
        return;
      }
      if (loadingMsg) loadingMsg.style.display = "none";
      renderTrendChart_(res.items);
    } catch (e) {
      if (loadingMsg) loadingMsg.textContent = "그래프 로드 오류";
    }
  }

/**
 * 📈 [최종 통합 버전] 그래프 렌더링 + 전체 및 복수 반별 상위30% 토글
 */
function renderTrendChart_(items) {
  currentTrendItems = items; 
  const canvas = $("adminGradeTrendChart");
  const ctx = canvas.getContext('2d');
  if (window.adminChart) window.adminChart.destroy(); 

  // 1️⃣ 모드 업데이트
  document.querySelectorAll(".mode-btn").forEach(btn => {
    if (btn.dataset.mode === currentMode) {
      btn.style.background = "#3498db"; btn.style.color = "white"; btn.style.fontWeight = "bold"; btn.classList.add("active");
    } else {
      btn.style.background = "transparent"; btn.style.color = "rgba(255,255,255,0.5)"; btn.style.fontWeight = "normal"; btn.classList.remove("active");
    }
  });

  const suffix = currentMode === 'pct' ? '_pct' : '_raw';
  
  // 2️⃣ 존재하는 모든 '반' 목록 추출
  const classSet = new Set();
  items.forEach(it => {
    if (it.all_classes_cutoffs) Object.keys(it.all_classes_cutoffs).forEach(c => classSet.add(c));
  });
  const classList = Array.from(classSet).sort();

  // 3️⃣ 헬퍼 함수 및 반별 시각적 스타일 지정 (여러 개 켜도 헷갈리지 않게 점선/도형 다르게)
  const getClassVal = (it, className, subj) => {
    if (!it.all_classes_cutoffs || !it.all_classes_cutoffs[className]) return null;
    return it.all_classes_cutoffs[className][subj + suffix];
  };

  const classStyles = [
    { pointStyle: 'triangle', borderDash: [2, 3] },
    { pointStyle: 'star', borderDash: [4, 4] },
    { pointStyle: 'rectRounded', borderDash: [6, 2] },
    { pointStyle: 'crossRot', borderDash: [8, 4] },
    { pointStyle: 'circle', borderDash: [1, 5] },
    { pointStyle: 'rect', borderDash: [3, 6] }
  ];

  // 4️⃣ 데이터셋 구성 (기본 학생 + 전체 30%)
  const datasets = [
    // --- [0~4] 학생 본인 성적 ---
    { label: '국어', data: items.map(it => it['kor' + suffix]), borderColor: '#3498db', tension: 0.3, fill: false },
    { label: '수학', data: items.map(it => it['math' + suffix]), borderColor: '#e74c3c', tension: 0.3, fill: false },
    { label: '탐구1', data: items.map(it => it['tam1' + suffix]), borderColor: '#2ecc71', tension: 0.3, fill: false },
    { label: '탐구2', data: items.map(it => it['tam2' + suffix]), borderColor: '#f1c40f', tension: 0.3, fill: false },
    { label: '영어', data: items.map(it => it.eng_grade), borderColor: '#9b59b6', tension: 0.3, yAxisID: 'y_eng', fill: false, pointStyle: 'rectRot', pointRadius: 6 },
    
    // --- [5~8] 전체 상위 30% 컷오프 ---
    { label: '국어 전체 30%', data: items.map(it => it['cutoff_kor' + suffix]), borderColor: 'rgba(52, 152, 219, 0.4)', backgroundColor: 'rgba(52, 152, 219, 0.4)', borderWidth: 2, borderDash: [6, 6], pointRadius: 4, pointStyle: 'rect', tension: 0.3, fill: false, hidden: !showTop30 },
    { label: '수학 전체 30%', data: items.map(it => it['cutoff_math' + suffix]), borderColor: 'rgba(231, 76, 60, 0.4)', backgroundColor: 'rgba(231, 76, 60, 0.4)', borderWidth: 2, borderDash: [6, 6], pointRadius: 4, pointStyle: 'rect', tension: 0.3, fill: false, hidden: !showTop30 },
    { label: '탐구1 전체 30%', data: items.map(it => it['cutoff_tam1' + suffix]), borderColor: 'rgba(46, 204, 113, 0.4)', backgroundColor: 'rgba(46, 204, 113, 0.4)', borderWidth: 2, borderDash: [6, 6], pointRadius: 4, pointStyle: 'rect', tension: 0.3, fill: false, hidden: !showTop30 },
    { label: '탐구2 전체 30%', data: items.map(it => it['cutoff_tam2' + suffix]), borderColor: 'rgba(241, 196, 15, 0.4)', backgroundColor: 'rgba(241, 196, 15, 0.4)', borderWidth: 2, borderDash: [6, 6], pointRadius: 4, pointStyle: 'rect', tension: 0.3, fill: false, hidden: !showTop30 }
  ];

  // --- [9+] 반별 상위 30% 컷오프 (존재하는 모든 반에 대해 동적 생성) ---
  classList.forEach((className, cIdx) => {
    const style = classStyles[cIdx % classStyles.length];
    const isHidden = !activeClasses.has(className); // Set에 켜진 상태가 아니면 숨김

    // 커스텀 속성(classGroup, subjIndex)을 넣어 나중에 토글할 때 찾기 쉽게 만듦
    datasets.push({ label: `국어 ${className} 30%`, data: items.map(it => getClassVal(it, className, '국어')), borderColor: 'rgba(52, 152, 219, 0.8)', backgroundColor: 'rgba(52, 152, 219, 0.8)', borderWidth: 2, borderDash: style.borderDash, pointRadius: 5, pointStyle: style.pointStyle, tension: 0.3, fill: false, hidden: isHidden, classGroup: className, subjIndex: 0 });
    datasets.push({ label: `수학 ${className} 30%`, data: items.map(it => getClassVal(it, className, '수학')), borderColor: 'rgba(231, 76, 60, 0.8)', backgroundColor: 'rgba(231, 76, 60, 0.8)', borderWidth: 2, borderDash: style.borderDash, pointRadius: 5, pointStyle: style.pointStyle, tension: 0.3, fill: false, hidden: isHidden, classGroup: className, subjIndex: 1 });
    datasets.push({ label: `탐구1 ${className} 30%`, data: items.map(it => getClassVal(it, className, '탐구1')), borderColor: 'rgba(46, 204, 113, 0.8)', backgroundColor: 'rgba(46, 204, 113, 0.8)', borderWidth: 2, borderDash: style.borderDash, pointRadius: 5, pointStyle: style.pointStyle, tension: 0.3, fill: false, hidden: isHidden, classGroup: className, subjIndex: 2 });
    datasets.push({ label: `탐구2 ${className} 30%`, data: items.map(it => getClassVal(it, className, '탐구2')), borderColor: 'rgba(241, 196, 15, 0.8)', backgroundColor: 'rgba(241, 196, 15, 0.8)', borderWidth: 2, borderDash: style.borderDash, pointRadius: 5, pointStyle: style.pointStyle, tension: 0.3, fill: false, hidden: isHidden, classGroup: className, subjIndex: 3 });
  });
  
  // 차트 생성
  window.adminChart = new Chart(ctx, {
    type: 'line',
    data: { labels: items.map(it => it.label), datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { min: 0, max: 100, ticks: { color: 'rgba(255,255,255,0.6)' }, grid: { color: 'rgba(255,255,255,0.1)' }, title: { display: true, text: currentMode === 'pct' ? '백분위' : '원점수', color: '#fff' } },
        y_eng: { position: 'right', min: 1, max: 9, reverse: true, grid: { drawOnChartArea: false }, ticks: { color: 'rgba(255,255,255,0.6)' } }
      },
      plugins: { 
        legend: { display: false },
        tooltip: { // 여러 선이 겹칠 때 구별하기 쉽게 툴팁 라벨에 소속을 표시
          callbacks: {
            label: function(context) { return context.dataset.label + ': ' + context.parsed.y; }
          }
        }
      } 
    }
  });

  // 5️⃣ 동적 버튼(반별) 생성 및 이벤트 연동
  const container = document.getElementById("classButtonsContainer");
  if (container) {
    container.innerHTML = "";
    classList.forEach((className) => {
      const btn = document.createElement("button");
      btn.className = "btn btn-mini";
      const isOn = activeClasses.has(className);
      
      btn.style.background = isOn ? "#27ae60" : "transparent";
      btn.style.color = isOn ? "white" : "rgba(255,255,255,0.5)";
      btn.style.border = isOn ? "none" : "1px solid rgba(255,255,255,0.3)";
      btn.style.padding = "4px 10px";
      btn.style.fontSize = "11px";
      btn.style.borderRadius = "6px";
      btn.style.cursor = "pointer";
      btn.style.fontWeight = "bold";
      btn.textContent = `${className} 30% ${isOn ? 'ON' : 'OFF'}`;

      btn.onclick = function() {
        if (activeClasses.has(className)) {
          activeClasses.delete(className); // 끄기
          this.style.background = "transparent";
          this.style.color = "rgba(255,255,255,0.5)";
          this.style.border = "1px solid rgba(255,255,255,0.3)";
          this.textContent = `${className} 30% OFF`;
        } else {
          activeClasses.add(className); // 켜기
          this.style.background = "#27ae60";
          this.style.color = "white";
          this.style.border = "none";
          this.textContent = `${className} 30% ON`;
        }

        if (!window.adminChart) return;
        
        // 클릭한 반의 데이터셋만 찾아서 차트에 반영
        window.adminChart.data.datasets.forEach((ds, dsIdx) => {
          if (ds.classGroup === className) {
            const isSubjVisible = window.adminChart.isDatasetVisible(ds.subjIndex);
            // 해당 반이 켜져있고, 과목 자체(국/수/영)도 켜져 있을 때만 점선 표시
            if (activeClasses.has(className) && isSubjVisible) window.adminChart.show(dsIdx);
            else window.adminChart.hide(dsIdx);
          }
        });
        window.adminChart.update();
      };
      container.appendChild(btn);
    });
  }

  // 모드 전환 버튼
  document.querySelectorAll(".mode-btn").forEach(btn => {
    btn.onclick = function() {
      currentMode = this.dataset.mode;
      renderTrendChart_(currentTrendItems);
    };
  });

  // 과목 뱃지 필터
  document.querySelectorAll(".filter-btn").forEach(btn => {
    const index = parseInt(btn.dataset.index);
    const isVisible = window.adminChart.isDatasetVisible(index);
    btn.style.opacity = isVisible ? "1" : "0.3";

    btn.onclick = function() {
      if (!window.adminChart) return;
      const idx = parseInt(this.dataset.index);
      const visible = window.adminChart.isDatasetVisible(idx);
      
      if (visible) {
        window.adminChart.hide(idx); // 학생 성적 숨김
        if (idx < 4) { 
            window.adminChart.hide(idx + 5); // 전체 30% 숨김
            // 켜져 있는 반별 30%들도 같이 숨김
            window.adminChart.data.datasets.forEach((ds, dsIdx) => {
                if (ds.subjIndex === idx) window.adminChart.hide(dsIdx);
            });
        }
        this.style.opacity = "0.3";
      } else {
        window.adminChart.show(idx);
        if (idx < 4) {
            if (showTop30) window.adminChart.show(idx + 5); 
            window.adminChart.data.datasets.forEach((ds, dsIdx) => {
                // 켜져 있는(active) 반들만 다시 표시
                if (ds.subjIndex === idx && activeClasses.has(ds.classGroup)) window.adminChart.show(dsIdx);
            });
        }
        this.style.opacity = "1";
      }
    };
  });

  // 전체 상위 30% 토글
  const top30Btn = document.getElementById("btnToggleTop30");
  if (top30Btn) {
    top30Btn.style.background = showTop30 ? "#e67e22" : "transparent";
    top30Btn.style.color = showTop30 ? "white" : "rgba(255,255,255,0.5)";
    top30Btn.style.border = showTop30 ? "none" : "1px solid rgba(255,255,255,0.3)";
    top30Btn.textContent = showTop30 ? "전체 상위 30% ON" : "전체 상위 30% OFF";

    top30Btn.onclick = function() {
      showTop30 = !showTop30;
      this.style.background = showTop30 ? "#e67e22" : "transparent";
      this.style.color = showTop30 ? "white" : "rgba(255,255,255,0.5)";
      this.style.border = showTop30 ? "none" : "1px solid rgba(255,255,255,0.3)";
      this.textContent = showTop30 ? "전체 상위 30% ON" : "전체 상위 30% OFF";

      if (!window.adminChart) return;
      for (let i = 0; i < 4; i++) {
        const isSubjVisible = window.adminChart.isDatasetVisible(i);
        if (showTop30 && isSubjVisible) window.adminChart.show(i + 5);
        else window.adminChart.hide(i + 5);
      }
      window.adminChart.update();
    };
  }
}

  /** ✅ 취약 영역 방사형 차트 (+ 행동영역 상세 분석 카드 추가) */
  function renderVulnerabilityChart(unitsBySubject, token) {
  const canvas = document.getElementById("vulnRadarChart");
  const msgEl = document.getElementById("vulnChartMsg");
  const canvasWrap = canvas.parentNode;

  if (!canvas || !unitsBySubject || Object.keys(unitsBySubject).length === 0) {
  if (msgEl) msgEl.textContent = "분석할 데이터가 부족합니다.";
  return;
  }
  if (msgEl) msgEl.style.display = "none";

  // 버튼 컨테이너 (우측 상단)
  let btnContainer = document.getElementById("vulnSubjectBtns");
  if (!btnContainer) {
  btnContainer = document.createElement("div");
  btnContainer.id = "vulnSubjectBtns";
  btnContainer.style.display = "flex";
  btnContainer.style.justifyContent = "flex-end"; 
  btnContainer.style.alignItems = "center";
  btnContainer.style.gap = "8px";
  btnContainer.style.marginBottom = "15px";
  btnContainer.style.flexWrap = "wrap";
  canvasWrap.insertBefore(btnContainer, canvas);
  }
  btnContainer.innerHTML = ""; 

  // 🎯 [신규] 차트 아래에 띄울 '세부 행동영역 분석 카드' DOM 생성
  let detailCard = document.getElementById("vulnDetailCard");
  if (!detailCard) {
  detailCard = document.createElement("div");
  detailCard.id = "vulnDetailCard";
  detailCard.style.marginTop = "20px";
  detailCard.style.display = "none"; // 평소엔 숨김
  // 캔버스를 감싸는 래퍼 바로 아래에 추가
  canvasWrap.parentNode.insertBefore(detailCard, canvasWrap.nextSibling);
  }
  detailCard.style.display = "none";

  const subjects = Object.keys(unitsBySubject);
  let currentSubject = subjects[0];

  let isAccumulatedMode = false;
  let accumulatedData = null;

  const drawChart = () => {
  // 탭 이동 시 상세 카드는 무조건 닫기
  detailCard.style.display = "none"; 

  const dataSource = isAccumulatedMode ? accumulatedData : unitsBySubject;
  const rawData = dataSource ? dataSource[currentSubject] : null;

  if (!rawData || rawData.length === 0) {
  if (window.vulnChart) window.vulnChart.destroy();
  return;
  }

  // 단원별 코드(code) 순서대로 정렬
  const data = [...rawData].sort((a, b) => Number(a.code || 99) - Number(b.code || 99));

  if (window.vulnChart) window.vulnChart.destroy();
  const ctx = canvas.getContext('2d');

  const pointColors = data.map((d) => {
  const code = Number(d.code); 
  if (currentSubject === "국어") {
  if (code >= 1 && code <= 7) return '#3b82f6';
  if (code >= 8 && code <= 14) return '#10b981';
  if (code >= 15 && code <= 16) return '#f59e0b';
  } else if (currentSubject === "수학") {
  if (code >= 1 && code <= 3) return '#ec4899';
  if (code >= 4 && code <= 6) return '#8b5cf6';
  if (code >= 7 && code <= 9) return '#eab308';
  }
  return '#3498db'; 
  });

  window.vulnChart = new Chart(ctx, {
  type: 'radar',
  data: {
    labels: data.map(d => d.area),
    datasets: [{
      label: `${currentSubject} 성취도(%)`,
      data: data.map(d => d.score),
      backgroundColor: isAccumulatedMode ? 'rgba(231, 76, 60, 0.15)' : 'rgba(52, 152, 219, 0.15)', 
      borderColor: 'rgba(255, 255, 255, 0.3)',
      pointBackgroundColor: pointColors,
      pointBorderColor: pointColors,
      pointRadius: 5,
      pointHoverRadius: 8,
      borderWidth: 2
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      r: {
        min: 0, max: 100, beginAtZero: true,
        grid: { color: 'rgba(255,255,255,0.15)' },
        angleLines: { color: 'rgba(255,255,255,0.15)' },
        pointLabels: { 
          color: (context) => pointColors[context.index] || 'rgba(255,255,255,0.85)', 
          font: { size: 12, weight: 'bold' } 
        },
        ticks: { display: false, stepSize: 20 }
      }
    },
    onHover: (e, elements) => {
      e.native.target.style.cursor = elements.length ? 'pointer' : 'default';
    },
    onClick: (e, elements) => {
      if (elements.length === 0) return; 

      const idx = elements[0].index;
      const item = data[idx]; 

      // 🎯 [분리] 기존의 상세 카드 렌더링 로직을 함수로 묶습니다.
      const renderDetailCard = (targetItem, targetIdx) => {
        if (!targetItem || !targetItem.details || Object.keys(targetItem.details).length === 0) {
          detailCard.innerHTML = `<div style="padding:12px; text-align:center; opacity:0.7; font-size:13px; background: rgba(255,255,255,0.04); border-radius:10px;">세부 행동영역 데이터가 없습니다.</div>`;
          detailCard.style.display = "block";
          return;
        }

        let html = `<div style="background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">`;
        html += `<div style="font-size: 15px; font-weight: 800; margin-bottom: 12px; color: ${pointColors[targetIdx]}; border-bottom: 1px dashed rgba(255,255,255,0.1); padding-bottom: 8px;">`;
        html += `🔍 [${escapeHtml(targetItem.area)}] 세부 영역 분석</div>`;

        for (const [beh, stats] of Object.entries(targetItem.details)) {
          if (!beh || beh === "기타") continue;
          const pct = stats.n > 0 ? Math.round((stats.o / stats.n) * 100) : 0;

          let color = "#2ecc71"; 
          if (pct < 50) color = "#e74c3c"; 
          else if (pct < 80) color = "#f1c40f"; 

          html += `
             <div style="margin-bottom: 12px;">
               <div style="display:flex; justify-content:space-between; font-size:13px; margin-bottom:4px; font-weight: 600;">
                 <span style="opacity:0.9;">${escapeHtml(beh)}</span>
                 <span style="color:${color};">${pct}% <span style="opacity:0.6; font-size:11px; margin-left:4px;">(${stats.o}/${stats.n})</span></span>
               </div>
               <div style="width: 100%; background: rgba(255,255,255,0.1); border-radius: 6px; height: 8px; overflow: hidden;">
                 <div style="width: ${pct}%; background: ${color}; height: 100%; border-radius: 6px; transition: width 0.5s ease-out;"></div>
               </div>
             </div>
          `;
        }
        html += `</div>`;

        detailCard.innerHTML = html;
        detailCard.style.display = "block";

        setTimeout(() => {
          detailCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
      };

      // 🎯 [신규] 0점인 데이터들이 여러 개 겹쳐있는지 확인
      const zeroItems = [];
      data.forEach((d, i) => {
        if (d.score === 0 || d.score === 0.0) {
          zeroItems.push({ item: d, index: i });
        }
      });

      // 클릭한 항목이 0점이고, 0점인 항목이 2개 이상일 때 -> 사용자 선택 UI 제공
      if (item.score === 0 && zeroItems.length > 1) {
        let html = `<div style="background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">`;
        html += `<div style="font-size: 14px; font-weight: 800; margin-bottom: 12px; color: #fff; border-bottom: 1px dashed rgba(255,255,255,0.1); padding-bottom: 8px;">`;
        html += `🎯 여러 단원의 성취도가 0%로 겹쳐있습니다.<br>상세 분석을 확인할 단원을 선택하세요.</div>`;
        html += `<div style="display: flex; flex-wrap: wrap; gap: 8px;">`;

        // 겹친 0% 항목들을 버튼으로 생성
        zeroItems.forEach(z => {
          const btnColor = pointColors[z.index] || '#3498db';
          html += `<button class="zero-select-btn" data-idx="${z.index}" style="padding: 6px 12px; background: transparent; border: 1px solid ${btnColor}; border-radius: 6px; color: ${btnColor}; font-weight:bold; cursor: pointer; transition: background 0.2s;">
            ${escapeHtml(z.item.area)}
          </button>`;
        });

        html += `</div></div>`;
        detailCard.innerHTML = html;
        detailCard.style.display = "block";

        // 생성된 버튼들에 이벤트 연결
        const btns = detailCard.querySelectorAll('.zero-select-btn');
        btns.forEach(btn => {
          btn.addEventListener('click', function() {
            const selectedIdx = parseInt(this.getAttribute('data-idx'));
            // 버튼 클릭 시 최종 선택한 단원의 상세 카드 렌더링
            renderDetailCard(data[selectedIdx], selectedIdx); 
          });
          // 간단한 Hover 효과
          btn.addEventListener('mouseover', function() { this.style.background = 'rgba(255,255,255,0.1)'; });
          btn.addEventListener('mouseout', function() { this.style.background = 'transparent'; });
        });

        setTimeout(() => {
          detailCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);

        return; // 선택 화면을 띄웠으므로 이벤트 종료
      }

      // 0점이 아니거나, 0점인 항목이 1개뿐이라면 기존처럼 바로 상세 화면 표시
      renderDetailCard(item, idx);
    },
    plugins: { 
      legend: { display: false },
      tooltip: { 
        callbacks: {
          label: function(context) {
            const item = data[context.dataIndex];
            if (item && item.n !== undefined) {
              return ` 성취도: ${item.score}% (${item.o}맞음 / ${item.n}문항) - 클릭하여 상세분석`;
            }
            return ` 성취도: ${item.score}%`;
          }
        }
      }
    }
  }
});
  };
    
  // [전체 (누적)] 토글 버튼
  const allBtn = document.createElement("button");
  allBtn.className = "btn btn-mini";
  allBtn.textContent = "전체 (누적)";
  allBtn.style.background = "rgba(255,255,255,0.1)";
  allBtn.style.color = "#fff";
  allBtn.style.border = "1px solid rgba(255,255,255,0.3)";
  allBtn.style.padding = "6px 14px";
  allBtn.style.borderRadius = "8px";
  allBtn.style.cursor = "pointer";
  allBtn.style.fontWeight = "bold";
  allBtn.style.marginRight = "auto"; 

  allBtn.onclick = async () => {
  isAccumulatedMode = !isAccumulatedMode;

  if (isAccumulatedMode && !accumulatedData) {
  msgEl.textContent = "누적 데이터를 분석 중입니다... 잠시만 기다려주세요.";
  msgEl.style.display = "block";
  canvas.style.opacity = "0.3"; 

  try {
  const res = await apiPost("grade_analysis_accumulated", { token });
  if (res.ok && Object.keys(res.units).length > 0) {
  accumulatedData = res.units;
  } else {
  alert("아직 누적된 성적 데이터가 없습니다.");
  isAccumulatedMode = false; 
  }
  } catch (e) { 
  alert("데이터를 불러오는데 오류가 발생했습니다.");
  isAccumulatedMode = false;
  }

  msgEl.style.display = "none";
  canvas.style.opacity = "1";
  }

  allBtn.style.background = isAccumulatedMode ? "#e74c3c" : "rgba(255,255,255,0.1)";
  allBtn.style.borderColor = isAccumulatedMode ? "#e74c3c" : "rgba(255,255,255,0.3)";
  drawChart();
  };
  btnContainer.appendChild(allBtn);

  // 과목 버튼들 생성
  const subjBtnGroup = [];
  subjects.forEach((subj, idx) => {
  const btn = document.createElement("button");
  btn.className = "btn btn-mini";
  btn.style.background = idx === 0 ? "#3498db" : "rgba(255,255,255,0.1)";
  btn.style.color = "#fff";
  btn.style.border = "none";
  btn.style.padding = "6px 14px";
  btn.style.borderRadius = "8px";
  btn.style.cursor = "pointer";
  btn.style.fontWeight = "bold";
  btn.textContent = subj;

  btn.onclick = () => {
  currentSubject = subj; 
  subjBtnGroup.forEach(b => b.style.background = "rgba(255,255,255,0.1)");
  btn.style.background = "#3498db";
  drawChart();
  };

  subjBtnGroup.push(btn);
  btnContainer.appendChild(btn);
  });

  drawChart();
  }

  // =========================================================================
  // 💡 [최종] 우리 반 전체 현황(대시보드 홈) - 중간 생략 없는 완전판
  // =========================================================================
  async function loadClassDashboard() {
      const sess = getAdminSession();
      if (!sess?.adminToken) return;

      let dashDiv = document.getElementById("classDashboard");
      if (!dashDiv) {
          dashDiv = document.createElement("div");
          dashDiv.id = "classDashboard";
          dashDiv.style.marginTop = "24px";
          dashDiv.style.marginBottom = "24px";
          qInput.parentNode.after(dashDiv); 
      }

      dashDiv.innerHTML = `<div style="text-align:center; padding:20px; color:rgba(255,255,255,0.6);">데이터를 불러오는 중입니다...</div>`;

      try {
          const res = await apiPost("admin_class_summary", { 
              adminToken: sess.adminToken,
              role: sess.role,
              adminName: sess.adminName 
          });

          if (!res.ok) {
              dashDiv.innerHTML = `<div style="color:#ff6b6b; padding:10px;">현황을 불러오지 못했습니다: ${res.error}</div>`;
              return;
          }

          const items = res.items || [];
          if (items.length === 0) {
              dashDiv.innerHTML = `<div style="color:rgba(255,255,255,0.5); padding:10px;">배정된 학생이 없습니다.</div>`; 
              return;
          }

          const grouped = {};
          items.forEach(st => {
              const tName = String(st.teacher || "").trim() || "미배정";
              if (!grouped[tName]) grouped[tName] = [];
              grouped[tName].push(st);
          });

          const teacherNames = Object.keys(grouped).sort((a, b) => {
              if (a === "미배정") return 1;
              if (b === "미배정") return -1;
              return a.localeCompare(b);
          });

          const titleText = sess.role === "super" ? "📊 학원 전체 출결 현황" : "📊 오늘의 우리 반 현황";

          let gridHtml = `
                 <div id="riskNoticePanel" style="margin-bottom: 24px; display: none; animation: fadeIn 0.6s ease-out;"></div>
                 <div id="dashHeader" style="font-size:16px; font-weight:800; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; cursor:pointer; padding: 10px 14px; background: rgba(255,255,255,0.05); border-radius: 10px; border: 1px solid rgba(255,255,255,0.08); transition: all 0.2s ease;">
                   <span>${titleText} <span style="font-size:13px; color:rgba(255,255,255,0.6); font-weight:normal; margin-left:6px;">(총 ${items.length}명)</span></span>
                   <span id="dashToggleIcon" style="font-size:13px; opacity:0.8; background: rgba(255,255,255,0.1); padding: 4px 8px; border-radius: 6px;">🔼 접기</span>
                 </div>
                 <div id="dashContent" style="display:block; animation: fadeIn 0.3s ease;">
          `;

          teacherNames.forEach(tName => {
              const groupItems = grouped[tName];
              gridHtml += `
                <div style="margin-top: 16px; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; align-items: baseline;">
                  <span style="font-size:15px; font-weight:800; color:#3498db;">🧑‍🏫 ${escapeHtml(tName)} 선생님</span>
                  <span style="font-size:12px; opacity:0.6; margin-left:8px;">${groupItems.length}명</span>
                </div>
                <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px;">
              `;

              groupItems.forEach(st => {
                  // 1. 공통 뱃지 스타일 (개별 위치 속성 제거, 디자인 통일)
                  const bStyle = "font-size:9px; font-weight:900; padding:2px 6px; border-radius:6px; box-shadow: 0 2px 4px rgba(0,0,0,0.2); white-space:nowrap; display:inline-flex; align-items:center;";

                  // 2. 출결 뱃지 (badgeAtt)
                  const abs = Number(st.todayAbs || 0);
                  let badgeAtt = "";
                  if (abs >= 6) badgeAtt = `<span style="${bStyle} background:#ff4757; color:white;">📅 위험 ${abs}</span>`;
                  else if (abs >= 3) badgeAtt = `<span style="${bStyle} background:#ffa502; color:white;">📅 경고 ${abs}</span>`;

                  // 3. 취침 뱃지 (badgeSleep)
                  const sleep = Number(st.sleepToday || 0);
                  let badgeSleep = "";
                  if (sleep >= 6) badgeSleep = `<span style="${bStyle} background:#eb4d4b; color:white;">💤 위험 ${sleep}</span>`;
                  else if (sleep >= 3) badgeSleep = `<span style="${bStyle} background:#f9ca24; color:#111;">💤 경고 ${sleep}</span>`;

                  // 4. 교육점수 뱃지 (badgeEdu)
                  const edu = Number(st.monthTotal || 0);
                  let badgeEdu = "";
                  if (edu >= 15) badgeEdu = `<span style="${bStyle} background:#6c5ce7; color:white;">💯 위험 ${edu}</span>`;
                  else if (edu >= 10) badgeEdu = `<span style="${bStyle} background:#a29bfe; color:white;">💯 경고 ${edu}</span>`;

                  // 5. 실시간 상태 신호등 (수정 버전)
const cs = String(st.currentStatus);
const reason = String(st.currentReason || "").trim(); // 현재 이동 사유 가져오기
let lampColor = "rgba(255,255,255,0.15)";

if (cs === "1") {
  lampColor = "#2ecc71"; // 정상 출석 -> 초록색
} 
else if (cs === "3S") {
  // 💡 상태가 3S(이동)일 때, 사유가 '화장실/정수기'인 경우만 초록색으로!
  if (reason === "화장실/정수기") {
    lampColor = "#2ecc71"; 
  } else {
    // 그 외 수업 이동 등은 원래대로 주황색 표시
    lampColor = "#f39c12"; 
  }
} 
else if (cs === "3") {
  lampColor = "#ff4757"; // 무단 결석 -> 빨간색
} 
else if (cs === "2") {
  lampColor = "#f1c40f"; // 지각 -> 노란색
}

const lampHtml = `<div style="width:10px; height:10px; border-radius:50%; background:${lampColor}; display:inline-block; margin-right:8px; box-shadow: 0 0 6px ${lampColor};"></div>`;

                  // 6. 카드 조립 (뱃지들을 하나의 컨테이너로 묶음)
                  gridHtml += `
                    <div class="class-dash-card" style="position:relative; background: rgba(255,255,255,0.04); border-radius: 12px; padding: 14px 12px; cursor: pointer; display:flex; flex-direction:column; gap:8px; transition: all 0.2s ease;"
                         onclick="document.getElementById('qInput').value='${st.studentId}'; document.getElementById('searchBtn').click();">
                      
                      <div style="position:absolute; top:-10px; left:8px; display:flex; gap:4px; z-index:12;">
                          ${badgeAtt} ${badgeSleep} ${badgeEdu}
                      </div>

                      <div style="display:flex; align-items:center; justify-content:space-between; margin-top:4px;">
                        <div style="font-weight:800; font-size:14px; display:flex; align-items:center;">${lampHtml} ${escapeHtml(st.name)}</div>
                        <div style="font-size:11px; opacity:0.5;">${escapeHtml(st.seat)}</div>
                      </div>
                      <div style="text-align:center; padding: 6px 0; border-top: 1px dashed rgba(255,255,255,0.08); margin-top:2px;">
                        <div style="font-size:11px; color:#3498db; font-weight:800;">🚰 화장실/정수기: ${st.restroomToday}회</div>
                      </div>
                    </div>
                  `;
              });
              gridHtml += `</div>`;
          });

          gridHtml += `</div>`;
          dashDiv.innerHTML = gridHtml;

        // 💡 추가: 목록이 뜨자마자 백그라운드에서 전체 요약본 로딩 시작
          prefetchAllSummaries(items);

          const dashHeader = document.getElementById("dashHeader");
          const dashContent = document.getElementById("dashContent");
          const dashToggleIcon = document.getElementById("dashToggleIcon");
          if (dashHeader && dashContent) {
              dashHeader.onclick = () => {
                  if (dashContent.style.display === "none") {
                      dashContent.style.display = "block";
                      dashToggleIcon.textContent = "🔼 접기";
                      dashHeader.style.opacity = "1";
                  } else {
                      dashContent.style.display = "none";
                      dashToggleIcon.textContent = "🔽 펼치기";
                      dashHeader.style.opacity = "0.7";
                  }
              };
          }

          document.querySelectorAll(".class-dash-card").forEach(card => {
              card.onmouseover = () => { card.style.background = "rgba(255,255,255,0.1)"; card.style.transform = "translateY(-2px)"; };
              card.onmouseout = () => { card.style.background = "rgba(255,255,255,0.04)"; card.style.transform = "translateY(0)"; };
          });

      } catch (e) {
          dashDiv.innerHTML = `<div style="color:#ff6b6b;">로딩 중 오류 발생: ${e.message}</div>`;
      }
  }
      
  if (sess?.adminToken) {
    loadClassDashboard(); 
  }

    /**
   * ✅ [신규] 특정 학생의 캐시를 강제로 비우고 서버에서 데이터를 새로 가져옵니다.
   */
  window.forceRefreshStudent = async function() {
    // 1. 현재 보고 있는 학생 정보가 있는지 확인
    if (!window.__lastStudent) return;
    
    const st = window.__lastStudent;
    const seat = String(st.seat || "").trim();
    const studentId = String(st.studentId || "").trim();
    const key = makeStudentKey(seat, studentId);
    const btn = document.getElementById("btnForceRefresh");

    // 2. 관리자에게 한 번 더 물어보기 (실수 방지)
    if (!confirm(`${st.studentName} 학생의 모든 데이터를 서버에서 새로 가져올까요?`)) return;

    // 3. 버튼 상태 변경 (진행 중임을 알림)
    btn.style.pointerEvents = "none"; // 연속 클릭 방지
    btn.innerText = "⏳";
    btn.style.opacity = "0.5";

    // 4. [핵심] 보관함(Cache)에서 이 학생의 모든 기록 삭제
    clearSummaryCache(key); // 요약본 캐시 삭제
    
    // 상세 데이터 캐시(이동, 취침, 벌점 7/15/30일치)도 싹 비우기
    const store = loadLocalCache_();
    Object.keys(store).forEach(k => {
      // 해당 학생의 정보가 포함된 모든 캐시 열쇠를 찾아 삭제
      if (k.includes(`detail|${seat}|${studentId}`) || k === key) {
        delete store[k];
      }
    });
    saveLocalCache_(store);

    console.log(`♻️ [강제새로고침] ${st.studentName} 학생 캐시 삭제 완료. 서버 요청을 시작합니다.`);

    // 5. 데이터를 처음부터 다시 로드 (함수 재호출)
    // 이제 캐시가 없으므로 시스템이 자동으로 서버(Apps Script)에 최신 데이터를 요청합니다.
    await loadStudentDetail(st);
    
    // 6. 완료 알림
    alert(`${st.studentName} 학생의 데이터가 최신 상태로 업데이트되었습니다.`);
  };

    /**
   * ✅ [신규] 보관함 데이터를 분석하여 위험 학생 알림판을 업데이트합니다.
   */
  window.updateRiskNoticePanel = function() {
    const panel = document.getElementById("riskNoticePanel");
    if (!panel) return;

    const store = loadLocalCache_();
    const risks = { penalty: [], attendance: [], sleep: [] };

    // 1. 모든 캐시 데이터를 돌며 위험 학생 필터링
    Object.keys(store).forEach(key => {
      const item = store[key].summary;
      // 💡 [수정] 이름표(student)가 아예 없거나, 이름이 "알 수 없음"이면 분석 대상에서 제외!
      if (!item || !item.student || !item.student.name || item.student.name === "알 수 없음") return;
      const name = item.student.name;
      const id = item.student.studentId;

      // 🚩 기준 1: 이번 달 벌점 10점 이상
      if (item.eduscore?.ok && item.eduscore.monthTotal >= 10) {
        risks.penalty.push({ name, val: item.eduscore.monthTotal, id });
      }
      // 🚩 기준 2: 이번 주 결석 3회 이상
      if (item.attendance?.ok && item.attendance.absent >= 3) {
        risks.attendance.push({ name, val: item.attendance.absent, id });
      }
      // 🚩 기준 3: 최근 7일 취침 5회 이상
     if (item.sleep?.ok && item.sleep.sleepTotal7d >= 5) {
        risks.sleep.push({ name, val: item.sleep.sleepTotal7d, id });
      }
    });

    // 2. 위험 학생이 없으면 표시 안 함
    if (risks.penalty.length === 0 && risks.attendance.length === 0 && risks.sleep.length === 0) {
      panel.style.display = "none";
      return;
    }

    // 3. 알림판 HTML 생성 (디자인)
    let html = `<div style="background: rgba(231, 76, 60, 0.08); border: 1px solid rgba(231, 76, 60, 0.2); border-radius: 14px; padding: 18px; box-shadow: 0 4px 15px rgba(0,0,0,0.15);">
                  <div style="font-weight: 900; color: #ff6b6b; margin-bottom: 12px; font-size: 15px; display:flex; align-items:center; gap:8px;">
                    <span style="font-size:18px;">🚨</span> 오늘의 집중 관리 대상
                  </div>
                  <div style="display: flex; gap: 12px; flex-wrap: wrap;">`;

    const createTag = (color, label, list) => {
      if (list.length === 0) return "";
      return `<div style="background: rgba(0,0,0,0.25); padding: 8px 12px; border-radius: 10px; border-left: 4px solid ${color}; flex-grow:1; min-width:200px;">
                <b style="color:${color}; font-size:12px;">${label}</b><br>
                <div style="margin-top:5px; font-size:13px; line-height:1.6;">
                  ${list.map(s => `<span style="cursor:pointer; color:#eee; text-decoration:underline;" onclick="document.getElementById('qInput').value='${s.id}'; document.getElementById('searchBtn').click();">${escapeHtml(s.name)}(${s.val})</span>`).join(", ")}
                </div>
              </div>`;
    };

    html += createTag("#ff4757", "🔴 벌점 과다 (10점↑)", risks.penalty);
    html += createTag("#ffa502", "📅 결석 주의 (3회↑)", risks.attendance);
    html += createTag("#f1c40f", "💤 취침 주의 (5회↑)", risks.sleep);

    html += `</div></div>`;
    panel.innerHTML = html;
    panel.style.display = "block";
  };

}); // 💡 핵심: 반드시 }); 로 끝나야 합니다!
