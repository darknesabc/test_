/***********************
 * 관리자(Admin) - 학생 검색/상세/상세버튼(출결/취침/이동/교육점수/성적)
 *
 * ✅ 추가(요약 자동 로드)
 * - 학생 선택 시 admin_issue_token으로 token 발급 후
 *   attendance_summary / sleep_summary / move_summary / eduscore_summary / grade_exams+grade_detail
 *   를 자동 호출하여 summary를 채움
 *
 * ✅ 추가(캐시/속도 최적화)
 * - 학생별 요약(summary) 캐시: seat|studentId
 * - 캐시가 있으면 즉시 표시 후, 백그라운드로 최신값 갱신
 * - TTL 기본 5분
 ***********************/

// ✅ 여기에 Apps Script Web App URL(…/exec) 넣기
const API_BASE = "https://script.google.com/macros/s/AKfycbwxYd2tK4nWaBSZRyF0A3_oNES0soDEyWz0N0suAsuZU35QJOSypO2LFC-Z2dpbDyoD/exec";

/** =========================
 * ✅ 출결(관리자) - 학부모 출결 상세와 동일한 "이동 기록 반영" 로직
 * - 스케줄 공란인 교시는 move_detail(이동) 사유로 채워서 표시/집계 기준을 동일하게 맞춤
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

// moveMap[iso][period] = reason
function buildMoveMapFromItems_(items) {
  const map = {};
  const arr = Array.isArray(items) ? items : [];
  for (const it of arr) {
    const iso = String(it?.date || "").trim();
    if (!iso) continue;

    const time = String(it?.time || "").trim();           // "HH:MM"
    const reason = String(it?.reason || "").trim();
    const rp = parseInt(String(it?.returnPeriod || "").trim(), 10) || 0;

    if (!reason || rp <= 0) continue;

    const sp = inferStartPeriodByTime_(time); // 0이면 추정불가
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

// ====== 캐시 설정 ======
const SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000; // ✅ 5분 (원하면 조절)
const SUMMARY_CACHE_KEY = "admin_summary_cache_v1"; // localStorage 저장 키

// ====== DOM ======
const $ = (id) => document.getElementById(id);

// ====== session ======
function setAdminSession(s) {
  localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(s));
}
function getAdminSession() {
  const raw = localStorage.getItem(ADMIN_SESSION_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}
function clearAdminSession() {
  localStorage.removeItem(ADMIN_SESSION_KEY);
}

// ====== admin header label ======
function getAdminLabel_(sess) {
  const role = sess?.role || "";
  const name = sess?.adminName || "";
  if (role === "super") return "전체 관리자";
  if (name) return `${name} 관리자`;
  return "관리자";
}

function applyAdminHeaderLabel_(sess) {
  // 페이지 상단 좌측 타이틀(.top-title)을 찾아서 표시
  const el =
    document.querySelector(".top-title") ||
    document.querySelector("header .top-title") ||
    document.querySelector("header h1") ||
    document.querySelector("header h2");

  if (!el) return;

  // 원본 제목 보관(중복 덧붙임 방지)
  if (!el.dataset.baseTitle) el.dataset.baseTitle = el.textContent.trim() || "관리자";

  const label = getAdminLabel_(sess);
  // 요청: 예) "임용해 관리자", "전체 관리자"
  el.textContent = label;
}


// ====== fetch helper ======
async function apiPost(path, body) {
  const url = `${API_BASE}?path=${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body || {})
  });
  return await res.json();
}

/** ✅ 성적 요약 표의 데이터를 생성 (국/수/탐 모두 예상값 반영) */
function buildGradeTableRows_(data) {
  const kor  = data.kor  || {};
  const math = data.math || {};
  const eng  = data.eng  || {};
  const hist = data.hist || {};
  const tam1 = data.tam1 || {};
  const tam2 = data.tam2 || {};

  const dash = "-";
  const fmt = (v) => { const s = String(v ?? "").trim(); return s ? s : dash; };
  const fmtNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && String(v).trim() !== "" ? String(n) : dash;
  };

  const shortenChoiceName = (v) => {
    if (v == null) return "";
    const map = { 
      "언어와매체":"언매", "화법과작문":"화작", "미적분":"미적", "확률과통계":"확통", "기하":"기하",
      "생활과윤리":"생윤", "사회문화":"사문", "정치와법":"정법", "윤리와사상":"윤사",
      "물리학1":"물1", "물리학2":"물2", "화학1":"화1", "화학2":"화2", 
      "생명과학1":"생1", "생명과학2":"생2", "지구과학1":"지1", "지구과학2":"지2"
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

// ====== UI helpers ======

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
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}
function fmtKeyVal(label, value) {
  return `<div style="display:flex; gap:8px; margin:2px 0;">
    <div style="min-width:90px; opacity:.8;">${escapeHtml(label)}</div>
    <div style="font-weight:600;">${escapeHtml(value)}</div>
  </div>`;
}
function setHint(el, msg, isError=false) {
  el.innerHTML = msg ? `<span style="color:${isError ? "#ff6b6b" : "inherit"}">${escapeHtml(msg)}</span>` : "";
}

/** ✅ 어떤 키로 오든 안전하게 값 뽑기 */
function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return fallback;
}

// ====== 요약 캐시(메모리 + localStorage) ======
const __memSummaryCache = new Map();

function makeStudentKey(seat, studentId) {
  return `${String(seat || "").trim()}|${String(studentId || "").trim()}`;
}

function loadLocalCache_() {
  try {
    const raw = localStorage.getItem(SUMMARY_CACHE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch (_) {
    return {};
  }
}

function saveLocalCache_(obj) {
  try {
    localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify(obj || {}));
  } catch (_) {}
}


// ✅ 요약 캐시 유효성 검사 (빈/깨진 캐시로 '데이터 없음' 고착 방지)
function isValidSummaryForCache(summary) {
  if (!summary || typeof summary !== "object") return false;

  // summary가 실제 데이터(숫자/문자/배열/객체)를 담고 있는지 느슨하게 판단
  const hasMeaningful = (v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === "number") return true;              // 0도 의미가 있을 수 있으니 true
    if (typeof v === "string") return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") {
      // 너무 깊게 가지 않고 1단계만 검사
      const ks = Object.keys(v);
      if (ks.length === 0) return false;
      for (const k of ks) {
        if (hasMeaningful(v[k])) return true;
      }
      return false;
    }
    if (typeof v === "boolean") return true;
    return false;
  };

  // 자주 쓰는 섹션들 우선 확인
  const sections = ["attendance", "sleep", "move", "eduscore", "grade"];
  for (const k of sections) {
    if (summary[k] && typeof summary[k] === "object" && hasMeaningful(summary[k])) return true;
  }

  // 학생 기본정보라도 있으면(좌석/이름/학번) 캐시로 인정
  if (summary.student && typeof summary.student === "object" && hasMeaningful(summary.student)) return true;

  // 그 외: 전체 스캔(1단계)로 의미 있는 값이 있는지
  return hasMeaningful(summary);
}

function clearSummaryCache(key) {
  __memSummaryCache.delete(key);
  try {
    const store = loadLocalCache_();
    if (store && store[key]) {
      delete store[key];
      saveLocalCache_(store);
    }
  } catch (_) {}
}

function clearAllSummaryCache() {
  __memSummaryCache.clear();
  try { localStorage.removeItem(SUMMARY_CACHE_KEY); } catch (_) {}
}
function getSummaryCache(key) {
  const now = Date.now();

  // 1) 메모리 캐시
  const mem = __memSummaryCache.get(key);
  if (mem) {
    if (mem.expireAt <= now) {
      __memSummaryCache.delete(key);
    } else if (mem.summary && isValidSummaryForCache(mem.summary)) {
      return mem.summary;
    } else {
      // 깨진/빈 캐시 제거
      __memSummaryCache.delete(key);
    }
  }

  // 2) localStorage 캐시
  const store = loadLocalCache_();
  const it = store ? store[key] : null;
  if (it) {
    if (it.expireAt <= now) {
      // 만료 제거
      try { delete store[key]; saveLocalCache_(store); } catch (_) {}
      return null;
    }
    if (it.summary && isValidSummaryForCache(it.summary)) {
      __memSummaryCache.set(key, it);
      return it.summary;
    }
    // 깨진/빈 캐시 제거
    try { delete store[key]; saveLocalCache_(store); } catch (_) {}
  }
  return null;
}

function setSummaryCache(key, summary) {
  // ✅ 빈/깨진 summary는 캐시에 저장하지 않음 (데이터 없음 고착 방지)
  if (!isValidSummaryForCache(summary)) return;

  const now = Date.now();
  const pack = {
    expireAt: now + SUMMARY_CACHE_TTL_MS,
    summary
  };
  __memSummaryCache.set(key, pack);

  const store = loadLocalCache_();
  store[key] = pack;

  // store 정리(만료/깨진 항목 제거)
  try {
    for (const k of Object.keys(store)) {
      const it = store[k];
      if (!it || (it.expireAt && it.expireAt <= now) || !isValidSummaryForCache(it.summary)) {
        delete store[k];
      }
    }
  } catch (_) {}

  saveLocalCache_(store);
}

// ====== init ======


/** =========================
 * ✅ 정오표(Errata) 렌더
 * ========================= */
function renderErrataHtml_(errata) {
  if (!errata || !errata.subjects) return "";
  const s = errata.subjects;

  // rate: [{q,pct,o,x,n}] / ox: [{q,ox}]
  const pctText = (pct) => (pct === null || pct === undefined) ? "-" : `${pct}%`;
  const asMap = (arr, key) => {
    const m = new Map();
    (arr || []).forEach(it => { if (it && it[key] !== undefined) m.set(it[key], it); });
    return m;
  };

  // ✅ 아코디언(접기/펼치기) 섹션
  const section = (title, meta, innerHtml, open = false) => `
    <details class="err-acc" ${open ? "open" : ""} style="margin-top:12px; border:1px solid rgba(255,255,255,.08); border-radius:14px; overflow:hidden;">
      <summary style="
        list-style:none;
        cursor:pointer;
        padding:10px 12px;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        background: rgba(255,255,255,.04);
        font-weight:800;
      ">
        <span>${escapeHtml(title)}</span>
        <span style="opacity:.7; font-size:12px; font-weight:600;">${escapeHtml(meta || "")}</span>
      </summary>
      <div style="padding:10px 12px;">
        ${innerHtml}
      </div>
    </details>
  `;

const renderTable = (oxArr, rateArr, qFrom, qTo) => {
    const oxMap = asMap(oxArr, "q");
    const rtMap = asMap(rateArr, "q");

    const rows = [];
    for (let q = qFrom; q <= qTo; q++) {
      const ox = oxMap.get(q)?.ox || "";
      const rt = rtMap.get(q);

      // ✅ 1. 오답 판별: 빈칸이 아니고 'O'나 '○'가 아니면 모두 오답(X) 처리
      const isWrong = (ox !== "" && ox !== "O" && ox !== "○");
      
      // ✅ 2. 정답률 70% 이상 판별
      const isHighPct = (rt && typeof rt.pct === "number" && rt.pct >= 70);

      // (참고) 만약 "틀렸으면서(isWrong) 정답률이 70% 이상일 때만" 정답률 칸을 칠하고 싶으시다면
      // 아래의 isHighPct 대신 (isWrong && isHighPct) 를 사용하시면 됩니다.

      rows.push(`
        <tr>
          <td style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.06); text-align:right; width:52px;">${q}</td>
          <td class="${isWrong ? "errata-x-high" : ""}" style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.06); text-align:center; width:52px; font-weight:900;">${escapeHtml(ox || "")}</td>
          <td class="${isHighPct ? "errata-x-high" : ""}" style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.06); text-align:right; width:90px;">${escapeHtml(pctText(rt?.pct))}</td>
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

  // ✅ 기본은 국어 공통만 열어두고 나머지는 접혀있게
  let firstOpenUsed = false;
  const pushAcc = (title, meta, html) => {
    const open = !firstOpenUsed; // 첫 섹션만 open
    if (!firstOpenUsed) firstOpenUsed = true;
    blocks.push(section(title, meta, html, open));
  };

  // 국어
  if (s.kor?.common) {
    pushAcc(
      "국어 공통",
      "문항 1~34" + (korChoice ? ` · ${korChoice}` : ""),
      renderTable(s.kor.common.ox, s.kor.common.rate, 1, 34)
    );
  }
  if (s.kor?.choice) {
    pushAcc(
      "국어 선택",
      "문항 35~45" + (korChoice ? ` · ${korChoice}` : ""),
      renderTable(s.kor.choice.ox, s.kor.choice.rate, 35, 45)
    );
  }

  // 수학
  if (s.math?.common) {
    pushAcc(
      "수학 공통",
      "문항 1~22" + (mathChoice ? ` · ${mathChoice}` : ""),
      renderTable(s.math.common.ox, s.math.common.rate, 1, 22)
    );
  }
  if (s.math?.choice) {
    pushAcc(
      "수학 선택",
      "문항 23~30" + (mathChoice ? ` · ${mathChoice}` : ""),
      renderTable(s.math.choice.ox, s.math.choice.rate, 23, 30)
    );
  }

  // 영어
  if (s.eng?.all) {
    pushAcc(
      "영어",
      "문항 1~45",
      renderTable(s.eng.all.ox, s.eng.all.rate, 1, 45)
    );
  }

  // 탐구(같은 과목이면 탐구1/2 합산된 정답률이 내려옴)
  const tamItems = Array.isArray(s.tam?.items) ? s.tam.items : [];
  tamItems.forEach(it => {
    if (!it?.name || !it?.all) return;
    pushAcc(
      `탐구 (${it.name})`,
      "문항 1~20",
      renderTable(it.all.ox, it.all.rate, 1, 20)
    );
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
          /* ✅ details 기본 삼각형/마커 제거 + hover */
          details.err-acc > summary::-webkit-details-marker { display:none; }
          details.err-acc > summary:hover { background: rgba(255,255,255,.06) !important; }

/* ✅ 정답률 70% 이상인데 X인 문항 강조 */
td.errata-x-high {
  background: rgba(255, 90, 90, 0.18);
  color: #ff6b6b;
  font-weight: 900;
  border-radius: 8px;
}
        </style>
      </div>
    </div>
  `;
}

document.addEventListener("DOMContentLoaded", () => {
  // ✅ 셀렉트(옵션) 글씨가 안 보이는 문제 방지
  (function ensureSelectTheme_() {
    const id = "adminSelectThemePatch";
    if (document.getElementById(id)) return;
    const st = document.createElement("style");
    st.id = id;
    st.textContent = `
      select, option {
        color: #111 !important;
      }
      select {
        background: rgba(255,255,255,0.9) !important;
      }
    `;
    document.head.appendChild(st);
  })();

  // ✅ 캐시 꼬였을 때: URL에 ?nocache=1 붙이면 요약 캐시 초기화
  try {
    const sp = new URLSearchParams(location.search);
    if (sp.get("nocache") === "1") clearAllSummaryCache();
  } catch (_) {}
  // elements
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

  // restore session
  const sess = getAdminSession();
  if (sess?.adminToken) {
    loginCard.style.display = "none";
    adminArea.style.display = "block";
    logoutBtn.style.display = "inline-flex";
    applyAdminHeaderLabel_(sess);
  } else {
    // 로그인 전 기본 표기
    applyAdminHeaderLabel_(null);
  }

  // ✅ 로그인 Enter 지원
  pwInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loginBtn.click();
  });

  // login
  loginBtn.addEventListener("click", async () => {
    const pw = String(pwInput.value || "").trim();
    if (!pw) return setHint(loginMsg, "비밀번호를 입력하세요.", true);

    loginBtn.disabled = true;
    setHint(loginMsg, "로그인 중…");

    try {
      const data = await apiPost("admin_login", { password: pw });
      if (!data.ok) {
        setHint(loginMsg, data.error || "로그인 실패", true);
        return;
      }
      setAdminSession({ adminToken: data.adminToken, adminId: data.adminId, role: data.role, adminName: data.adminName });
      applyAdminHeaderLabel_(getAdminSession());
      setHint(loginMsg, "로그인 성공");

      loginCard.style.display = "none";
      adminArea.style.display = "block";
      logoutBtn.style.display = "inline-flex";
    } catch (e) {
      setHint(loginMsg, "네트워크 오류", true);
    } finally {
      loginBtn.disabled = false;
    }
  });

  // logout
  logoutBtn.addEventListener("click", () => {
    clearAdminSession();
    location.reload();
  });

  // search (enter)
  qInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchBtn.click();
  });

  // search
  searchBtn.addEventListener("click", async () => {
    const sess = getAdminSession();
    if (!sess?.adminToken) return setHint(searchMsg, "관리자 로그인이 필요합니다.", true);

    const q = String(qInput.value || "").trim();
    if (!q) return setHint(searchMsg, "검색어를 입력하세요.", true);

    searchBtn.disabled = true;
    setHint(searchMsg, "검색 중…");
    resultList.innerHTML = "";

    // reset detail
    detailSub.textContent = "학생을 선택하세요.";
    detailBody.innerHTML = "";
    detailResult.innerHTML = "";
    window.__lastStudent = null;

    try {
      const data = await apiPost("admin_search", { adminToken: sess.adminToken, q });
      if (!data.ok) {
        setHint(searchMsg, data.error || "검색 실패", true);
        return;
      }

      const items = Array.isArray(data.items) ? data.items : [];
      if (items.length === 0) {
        setHint(searchMsg, "검색 결과가 없습니다.");
        return;
      }

      setHint(searchMsg, `검색 결과 ${items.length}명`);

      // ✅ 검색 결과: (좌석 · 이름 · 담임)
      resultList.innerHTML = items.map((it, idx) => {
        const seat = pick(it, ["seat","좌석"], "-");
        const name = pick(it, ["name","studentName","이름"], "-");
        const teacher = pick(it, ["teacher","담임"], "-");

        return `
          <button class="list-item" data-idx="${idx}"
            style="
              width:100%;
              text-align:left;
              border:1px solid rgba(255,255,255,.10);
              background: rgba(10,15,25,.55);
              color: inherit;
              padding: 12px 14px;
              border-radius: 12px;
              cursor: pointer;
              display:flex;
              align-items:center;
              gap:10px;
              transition: transform .08s ease, background .15s ease, border-color .15s ease;
              margin: 8px 0;
            "
          >
            <span style="opacity:.9; font-weight:700;">${escapeHtml(seat)}</span>
            <span style="opacity:.95;">${escapeHtml(name)}</span>
            <span style="opacity:.7;">·</span>
            <span style="opacity:.85;">담임 ${escapeHtml(teacher)}</span>
          </button>
        `;
      }).join("");

      // hover + click
      resultList.querySelectorAll(".list-item").forEach(btn => {
        btn.addEventListener("mouseover", () => {
          btn.style.background = "rgba(20,30,50,.65)";
          btn.style.borderColor = "rgba(255,255,255,.16)";
        });
        btn.addEventListener("mouseout", () => {
          btn.style.background = "rgba(10,15,25,.55)";
          btn.style.borderColor = "rgba(255,255,255,.10)";
          btn.style.transform = "scale(1)";
        });
        btn.addEventListener("mousedown", () => { btn.style.transform = "scale(0.99)"; });
        btn.addEventListener("mouseup", () => { btn.style.transform = "scale(1)"; });

        btn.addEventListener("click", async () => {
          const idx = Number(btn.dataset.idx);
          const st = items[idx];
          await loadStudentDetail(st);
        });
      });

      // ✅ 결과가 1명이면 자동 선택
      if (items.length === 1) {
        await loadStudentDetail(items[0]);
      }

    } catch (e) {
      setHint(searchMsg, "네트워크 오류", true);
    } finally {
      searchBtn.disabled = false;
    }
  });

  // ====== issue token for student (admin_issue_token) ======
  async function issueStudentToken_(seat, studentId) {
    const sess = getAdminSession();
    const data = await apiPost("admin_issue_token", {
      adminToken: sess.adminToken,
      seat,
      studentId
    });
    if (!data.ok) throw new Error(data.error || "token 발급 실패");
    return data.token;
  }

  // ====== ✅ 요약 로드 (네 API 경로들 기준) ======
  async function loadSummariesForStudent_(seat, studentId) {
    const summary = {};
    const token = await issueStudentToken_(seat, studentId);

    const [att, slp, mv, edu] = await Promise.allSettled([
      apiPost("attendance_summary", { token }),
      apiPost("sleep_summary", { token }),
      apiPost("move_summary", { token }),
      apiPost("eduscore_summary", { token }),
    ]);

    summary.attendance = (att.status === "fulfilled") ? att.value : { ok:false, error:String(att.reason || "") };
    summary.sleep      = (slp.status === "fulfilled") ? slp.value : { ok:false, error:String(slp.reason || "") };
    summary.move       = (mv.status === "fulfilled")  ? mv.value  : { ok:false, error:String(mv.reason || "") };
    summary.eduscore   = (edu.status === "fulfilled") ? edu.value : { ok:false, error:String(edu.reason || "") };

    // 성적 요약
    try {
      const exams = await apiPost("grade_exams", { token });
      const items = (exams && exams.ok && Array.isArray(exams.items)) ? exams.items : [];
      if (items.length) {
        const last = items[items.length - 1] || {};
        const lastExam = String(last.exam || "");
        const gs = await apiPost("grade_summary", { token, exam: lastExam });

        summary.grade = gs.ok ? {
          ok: true,
          exam: lastExam,
          sheetName: gs.sheetName || last.label || last.name || "",
          exams: items, // ✅ 요약 드롭다운용
          data: gs,     // ✅ 표 렌더용(학부모/관리자 상세와 동일)
        } : { ok:false, error: gs.error || "grade_summary 실패", exams: items };
      } else {
        summary.grade = { ok:false, error:"시험 목록 없음", exams: [] };
      }
    } catch (e) {
      summary.grade = { ok:false, error: e?.message || "성적 오류", exams: [] };
    }

return summary;
  }

  // ====== load student detail (summary) ======
  // ✅ 갱신 중인 학생 추적(클릭 연타 시 이전 요청 결과가 덮어씌우는 것 방지)
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
    detailBody.innerHTML = "불러오는 중…";
    detailResult.innerHTML = "";

    try {
      const data = await apiPost("admin_student_detail", {
        adminToken: sess.adminToken,
        seat,
        studentId
      });

      if (!data.ok) {
        detailBody.innerHTML = `<div style="color:#ff6b6b;">${escapeHtml(data.error || "상세 조회 실패")}</div>`;
        return;
      }

      // 기본정보 렌더
      data.summary = { __loading: true }; 
      renderStudentDetail(data);

      // ✅ 1) 캐시가 있으면 즉시 표시(초고속)
      const cached = getSummaryCache(key);
      if (cached) {
        data.summary = cached;
        renderStudentDetail(data);

        // ✅ 2) 동시에 백그라운드로 최신값 갱신(조용히)
        (async () => {
          try {
            const fresh = await loadSummariesForStudent_(seat, studentId);
            // 클릭이 다른 학생으로 넘어갔으면 반영 X
            if (__activeStudentKey !== key) return;
            setSummaryCache(key, fresh || {});
            data.summary = fresh || {};
            renderStudentDetail(data);
          } catch (_) {}
        })();

        return; // 캐시 있으면 여기서 끝(백그라운드 갱신만)
      }

      // ✅ 캐시가 없으면 로딩 표시 후 실제 호출
      data.summary = { __loading: true };
      renderStudentDetail(data);

      try {
        const summary = await loadSummariesForStudent_(seat, studentId);
        // 클릭이 다른 학생으로 넘어갔으면 반영 X
        if (__activeStudentKey !== key) return;

        setSummaryCache(key, summary || {});
        data.summary = summary || {};
        renderStudentDetail(data);
      } catch (_) {
        if (__activeStudentKey !== key) return;
        data.summary = {};
        renderStudentDetail(data);
      }

    } catch (e) {
      detailBody.innerHTML = `<div style="color:#ff6b6b;">네트워크 오류</div>`;
    }
  }

  // ====== render summary + buttons ======
  function renderStudentDetail(data) {
    const st = data.student || {};
    const sum = data.summary || {};
    const loading = !!sum.__loading;

    const att = sum.attendance || null;
    const slp = sum.sleep || null;
    const mv  = sum.move || null;
    const edu = sum.eduscore || null;
    const grd = sum.grade || null;

    detailBody.innerHTML = `
      <div style="margin-bottom:10px;">
        ${fmtKeyVal("이름", st.studentName || st.name || "-")}
        ${fmtKeyVal("좌석", st.seat || "-")}
        ${fmtKeyVal("학번", st.studentId || "-")}
        ${fmtKeyVal("담임", st.teacher || "-")}
      </div>

      <div style="margin: 15px 0; padding-bottom: 15px; border-bottom: 1px dashed rgba(255,255,255,.1);">
        <button id="btnResetPw" class="btn" style="background: #e74c3c; color: white; padding: 8px 16px; font-size: 13px;">
          🔒 비밀번호 초기화
        </button>
        <p style="font-size: 11px; color: rgba(255,255,255,.5); margin-top: 6px;">
          * 초기화 시 학생은 다시 기존 4자리 번호로 로그인해야 합니다.
        </p>
      </div>

      <div class="grid-2" style="margin-top:10px;">
        <section class="card" style="padding:14px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px;"><div class="card-title" style="font-size:15px;">출결 요약</div><button class="btn btn-ghost btn-mini" id="btnAttDetail" style="padding:6px 10px;">상세</button></div>
          <div class="card-sub">
            ${att && att.ok ? `
              이번주 출석: <b>${att.present ?? 0}</b><br>
              이번주 결석: <b>${att.absent ?? 0}</b><br>
              최근 결석(최대 3): ${
                Array.isArray(att.recentAbsences) && att.recentAbsences.length
                  ? `<ul style="margin:6px 0 0 18px;">${
                      att.recentAbsences.map(x => `<li>${escapeHtml(x.md)}(${escapeHtml(x.dow)}) ${escapeHtml(x.period)}교시</li>`).join("")
                    }</ul>`
                  : "없음"
              }
            ` : (loading ? "불러오는 중…" : "데이터 없음")}
          </div>
        </section>

        <section class="card" style="padding:14px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px;"><div class="card-title" style="font-size:15px;">취침 요약</div><button class="btn btn-ghost btn-mini" id="btnSleepDetail" style="padding:6px 10px;">상세</button></div>
          <div class="card-sub">
            ${slp && slp.ok ? `
              최근 7일 취침일수: <b>${slp.sleepCount7d ?? 0}</b><br>
              최근 7일 취침횟수: <b>${slp.sleepTotal7d ?? 0}</b>
            ` : (loading ? "불러오는 중…" : "데이터 없음")}
          </div>
        </section>

        <section class="card" style="padding:14px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px;"><div class="card-title" style="font-size:15px;">이동 요약</div><button class="btn btn-ghost btn-mini" id="btnMoveDetail" style="padding:6px 10px;">상세</button></div>
          <div class="card-sub">
            ${mv && mv.ok ? `
              최근 이동: <b>${escapeHtml(mv.latestText || "-")}</b><br>
              ${escapeHtml(mv.latestDateTime || "")}
            ` : (loading ? "불러오는 중…" : "데이터 없음")}
          </div>
        </section>

        <section class="card" style="padding:14px; margin-bottom:14px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <div class="card-title" style="font-size:15px; margin:0;">📈 성적 추이 (백분위/등급)</div>
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

      <section class="card" style="padding:14px; margin-top:14px;">
        <div class="card-title" style="font-size:15px; margin-bottom:10px;">🕸️ 취약 영역 분석 (단원별 성취도)</div>
        <div style="height: 280px; position: relative;">
          <canvas id="vulnRadarChart"></canvas>
        </div>
        <div id="vulnChartMsg" class="muted" style="font-size:12px; margin-top:10px; text-align:center;">
          성적 상세 조회 시 분석 결과가 표시됩니다.
        </div>
      </section>

        <section class="card" style="padding:14px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px;"><div class="card-title" style="font-size:15px;">교육점수 요약</div><button class="btn btn-ghost btn-mini" id="btnEduDetail" style="padding:6px 10px;">상세</button></div>
          <div class="card-sub">
            ${edu && edu.ok ? `
              이번달 누적점수: <b>${edu.monthTotal ?? 0}</b><br>
              최근 항목: <b>${escapeHtml(edu.latestText || "-")}</b><br>
              ${escapeHtml(edu.latestDateTime || "")}
            ` : (loading ? "불러오는 중…" : "데이터 없음")}
          </div>
        </section>

        <section class="card" style="padding:14px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
            <div style="display:flex; align-items:center; gap:10px;">
              <div class="card-title" style="font-size:15px;">성적 요약</div>
              ${grd && grd.ok && Array.isArray(grd.exams) && grd.exams.length ? `
                <select id="gradeSummarySelect" class="select" style="min-width:140px;">
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

          <div class="card-sub">
            ${grd && grd.ok ? `
              <div id="gradeSummaryLabel" style="margin-bottom:8px;">(${escapeHtml(grd.sheetName || "")})</div>
              <div id="gradeSummaryTable">
                ${renderGradeTableHtml_(buildGradeTableRows_(grd.data || grd || {}))}
              </div>
            ` : (loading ? "불러오는 중…" : "데이터 없음")}
          </div>
        </section>
      </div>
    `;

    // bind detail buttons
    $("btnAttDetail").addEventListener("click", () => loadDetail("attendance"));
    $("btnSleepDetail").addEventListener("click", () => loadDetail("sleep_detail"));
    $("btnMoveDetail").addEventListener("click", () => loadDetail("move_detail"));
    $("btnEduDetail").addEventListener("click", () => loadDetail("eduscore_detail"));
    $("btnGradeDetail").addEventListener("click", () => loadDetail("grade_detail"));

    // bind detail buttons 라고 적힌 곳 근처에 추가하세요 (약 620라인 부근)
    const btnResetPw = $("btnResetPw");
    if (btnResetPw) {
      btnResetPw.onclick = async () => {
        const adminSess = getAdminSession();
        if (!adminSess?.adminToken) return alert("관리자 권한이 없습니다.");

        if (!confirm(`${st.studentName} 학생의 비밀번호를 초기화하시겠습니까?\n(변경된 10자리 번호가 삭제됩니다.)`)) return;

        try {
          btnResetPw.disabled = true;
          btnResetPw.textContent = "처리 중...";

          const res = await apiPost("admin_reset_password", {
            adminToken: adminSess.adminToken,
            studentId: st.studentId
          });

          if (res.ok) {
            alert("비밀번호가 성공적으로 초기화되었습니다.\n이제 기존 4자리 번호로 로그인이 가능합니다.");
            // 캐시가 남아있을 수 있으므로 해당 학생 캐시 삭제
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

    // ✅ 성적 요약 드롭다운 변경 시: 같은 토큰(좌석/학번) 기준으로 grade_summary 다시 조회 후 요약 카드만 갱신
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
// ✅ 여기에 아래 코드를 추가하세요! (학생 정보를 다 그린 후 그래프 로드 실행)
    loadAdminGradeTrend(st.seat, st.studentId);
  }

  
  // ====== grade detail (관리자) - 학부모와 동일 양식 ======
  async function loadAdminGradeDetailUI_(token, initialExam) {
    const host = $("detailResult");
    if (!host) return;

    host.innerHTML = `
      <div class="card" style="padding:14px;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
          <div style="font-weight:700;">성적</div>
          <select id="adminGradeExamSelect" class="btn btn-ghost btn-mini" style="padding:6px 10px; max-width: 280px;"></select>
        </div>
        <p id="adminGradeLoading" class="muted" style="margin-top:10px;">불러오는 중...</p>
        <p id="adminGradeError" class="msg" style="margin-top:6px;"></p>
        <div id="adminGradeTableWrap" style="display:none;"></div>
      </div>
    `;

    const sel = $("adminGradeExamSelect");
    const loading = $("adminGradeLoading");
    const error = $("adminGradeError");
    const wrap = $("adminGradeTableWrap");

    try {
      // 1) 시험 목록
      const exams = await apiPost("grade_exams", { token });
      if (!exams.ok || !Array.isArray(exams.items) || !exams.items.length) {
        throw new Error(exams.error || "시험 목록이 없습니다.");
      }

      // items: [{exam, label}] 형태 가정. label 없으면 exam 그대로 표시
      sel.innerHTML = exams.items.map(it => {
        const v = String(it.exam || "");
        const lab = String(it.label || it.name || it.sheetName || v);
        return `<option value="${escapeHtml(v)}">${escapeHtml(lab)}</option>`;
      }).join("");

      // 기본 선택: (1) 호출자가 지정한 시험, 없으면 (2) 마지막(최신)
      const preferred = (initialExam != null) ? String(initialExam).trim() : "";
      const fallback = String(exams.items[exams.items.length - 1].exam || "");
      if (preferred && Array.from(sel.options).some(o => o.value === preferred)) {
        sel.value = preferred;
      } else {
        sel.value = fallback;
      }

      sel.addEventListener("change", () => fetchAndRender(sel.value));
      await fetchAndRender(sel.value);
    } catch (e) {
      loading.textContent = "";
      error.textContent = e?.message || "성적 불러오기 실패";
      wrap.style.display = "none";
    }

    async function fetchAndRender(exam) {
      try {
        loading.textContent = "불러오는 중...";
        error.textContent = "";
        wrap.style.display = "none";
        wrap.innerHTML = "";

        const data = await apiPost("grade_summary", { token, exam: String(exam || "") });
        if (!data.ok) throw new Error(data.error || "성적 불러오기 실패");

        // ✅ 정오표(선택)도 같이 조회
        let errata = null;
        try {
          // admin (3).js 745라인 부근
          const e2 = await apiPost("grade_errata", { token, exam: String(exam || "") });
          if (e2 && e2.ok) {
            errata = e2;
            
            // ✅ 여기에 아래 코드를 추가하여 그래프를 호출합니다.
            if (errata.analysis && errata.analysis.units) {
              renderVulnerabilityChart(errata.analysis.units);
            }
          }
        } catch (_) { /* ignore */ }

        // ✅ 정오표만 표시(성적표는 요약에 이미 있음)
        wrap.innerHTML = (errata ? renderErrataHtml_(errata) : `<div class="muted">정오표 데이터가 없습니다.</div>`);
        wrap.style.display = "block";
        loading.textContent = "";
      } catch (e) {
        loading.textContent = "";
        error.textContent = e?.message || "성적 불러오기 실패";
        wrap.style.display = "none";
      }
    }
  }

// ====== load detail into detailResult ======
  async function loadDetail(kind) {
    const sess = getAdminSession();
    if (!sess?.adminToken) return;

    if (!window.__lastStudent) {
      detailResult.innerHTML = `<div style="color:#ff6b6b;">학생을 먼저 선택하세요.</div>`;
      return;
    }

    const st = window.__lastStudent;
    const seat = st.seat || "";
    const studentId = st.studentId || "";

    detailResult.innerHTML = "불러오는 중…";

    try {
      const token = await issueStudentToken_(seat, studentId);

      if (kind === "attendance") {
        // ✅ 학부모 출결 상세와 동일 기준을 위해 이동(move_detail)도 함께 조회해서 스케줄 공란을 채웁니다.
        const [att, mv] = await Promise.all([
          apiPost("attendance", { token }),
          apiPost("move_detail", { token, days: 14 }),
        ]);

        if (!att.ok) return showError(att);
        const moveMap = (mv && mv.ok) ? buildMoveMapFromItems_(mv.items) : {};

        detailResult.innerHTML = renderAttendanceDetail_(att, moveMap);
        return;
      }

      if (kind === "sleep_detail") {
        const data = await apiPost("sleep_detail", { token, days: 30 });
        if (!data.ok) return showError(data);
        detailResult.innerHTML = renderSleepDetail_(data);
        return;
      }

      if (kind === "move_detail") {
        const data = await apiPost("move_detail", { token, days: 30 });
        if (!data.ok) return showError(data);
        detailResult.innerHTML = renderSimpleTable_(
          ["날짜", "시간", "사유", "복귀교시"],
          (data.items || []).map(x => [x.date, x.time, x.reason, x.returnPeriod])
        );
        return;
      }

      if (kind === "eduscore_detail") {
        const data = await apiPost("eduscore_detail", { token, days: 30 });
        if (!data.ok) return showError(data);
        detailResult.innerHTML = renderSimpleTable_(
          ["날짜", "시간", "사유", "점수"],
          (data.items || []).map(x => [x.date, x.time, x.reason, x.score])
        );
        return;
      }

      if (kind === "grade_detail") {
        // ✅ 요약에서 선택된 시험으로 상세(정오표) 열기
        const summarySel = document.getElementById("gradeSummarySelect");
        const initialExam = summarySel ? String(summarySel.value || "").trim() : "";
        await loadAdminGradeDetailUI_(token, initialExam);
        return;
      }

      detailResult.innerHTML = `<div style="color:#ff6b6b;">지원하지 않는 상세 종류</div>`;
    } catch (e) {
      detailResult.innerHTML = `<div style="color:#ff6b6b;">${escapeHtml(e.message || "오류")}</div>`;
    }
  }

  function showError(data) {
    detailResult.innerHTML = `<div style="color:#ff6b6b;">${escapeHtml(data.error || "오류")}</div>`;
  }

  // ====== renderers ======
  function renderSimpleTable_(headers, rows) {
    const th = headers.map(h => `<th style="text-align:left; padding:8px; border-bottom:1px solid rgba(255,255,255,.08);">${escapeHtml(h)}</th>`).join("");
    const tr = rows.map(r => `
      <tr>
        ${r.map(c => `<td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06);">${escapeHtml(c)}</td>`).join("")}
      </tr>
    `).join("");

    return `
      <div style="overflow:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:14px;">
          <thead><tr>${th}</tr></thead>
          <tbody>${tr || `<tr><td style="padding:10px; opacity:.8;" colspan="${headers.length}">데이터 없음</td></tr>`}</tbody>
        </table>
      </div>
    `;
  }

 function renderAttendanceDetail_(data, moveMap) {
  const dates = data.dates || [];
  const rows = data.rows || [];
  if (!dates.length || !rows.length) return "출결 상세 데이터가 없습니다.";

  const showN = Math.min(14, dates.length);

  // 날짜 정렬 후 최근 N일만
  const idxSorted = dates
    .map((d, i) => ({ i, iso: d.iso || "" }))
    .filter(x => x.iso)
    .sort((a,b) => a.iso.localeCompare(b.iso));

  const lastIdx = idxSorted.slice(-showN).map(x => x.i);

function mapAttendance_(val) {
  const t = String(val ?? "").trim();
  if (t === "1") return "출석";
  if (t === "3") return "결석";
  if (t === "2") return "지각";   // 혹시 쓰면 대비용
  if (t === "4") return "조퇴";   // 혹시 쓰면 대비용
  return t || "-";               // 이미 문자면 그대로
}
   
  // ✅ 출결 값에 따른 셀 스타일
  function statusStyle_(val) {
    const t0 = String(val || "").trim();
    const t = (t0 === "1") ? "출석" : (t0 === "3") ? "결석" : t0;
    if (!t || t === "-" ) return "opacity:.55;";
    if (t.includes("출석")) return "background: rgba(46, 204, 113, .22);";
    if (t.includes("결석")) return "background: rgba(231, 76, 60, .22);";
    if (t.includes("지각")) return "background: rgba(241, 196, 15, .22);";
    if (t.includes("조퇴")) return "background: rgba(155, 89, 182, .22);";
    if (t.includes("외출")) return "background: rgba(52, 152, 219, .22);";
    return "background: rgba(255,255,255,.06);";
  }

  // ====== 헤더(2줄) 만들기 ======
  // 1줄: 날짜(각 날짜 colspan=2)
  const thTop = `
    <th rowspan="2" style="position:sticky; left:0; z-index:3; background:rgba(8,12,20,.92); padding:10px; border-bottom:1px solid rgba(255,255,255,.10); width:60px;">
      교시
    </th>
    ${lastIdx.map(i => `
      <th colspan="2" style="text-align:center; padding:10px; border-bottom:1px solid rgba(255,255,255,.10);">
        ${escapeHtml(`${dates[i].md}(${dates[i].dow})`)}
      </th>
    `).join("")}
  `;

  // 2줄: 스케줄/출결 반복
  const thSub = lastIdx.map(() => `
    <th style="text-align:left; padding:8px 10px; border-bottom:1px solid rgba(255,255,255,.08); opacity:.85;">스케줄</th>
    <th style="text-align:left; padding:8px 10px; border-bottom:1px solid rgba(255,255,255,.08); opacity:.85;">출/결</th>
  `).join("");

  // ====== 바디 ======
  const bodyTr = rows.map(r => {
    const period = r.period || "";
    const cells = r.cells || [];

    const tds = lastIdx.map(i => {
      const c = cells[i] || {};
      const sRaw = String(c.s ?? "").trim();  // 스케줄(원본)
      const iso = String((dates[i] && dates[i].iso) || "").trim();
      const mvReason = (moveMap && moveMap[iso] && moveMap[iso][r.period]) ? String(moveMap[iso][r.period]) : "";
      const s = sRaw || mvReason; // ✅ 스케줄 공란이면 이동 사유로 채움
      const aRaw = String(c.a ?? "").trim();   // 원본(1/3 등)
      const aText = mapAttendance_(aRaw);      // 표시용(출석/결석)

      return `
        <td style="padding:10px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">
          ${escapeHtml(s || "-")}
        </td>
        <td style="padding:10px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap; ${statusStyle_(aText)}">
          ${escapeHtml(aText)}
        </td>
      `;
    }).join("");

    return `
      <tr>
        <td style="position:sticky; left:0; z-index:2; background:rgba(8,12,20,.92); padding:10px; border-bottom:1px solid rgba(255,255,255,.06); font-weight:700;">
          ${escapeHtml(period)}
        </td>
        ${tds}
      </tr>
    `;
  }).join("");

  // ====== 최종 테이블 ======
  return `
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
  `;
}

  function renderSleepDetail_(data) {
    const groups = data.groups || [];
    if (!groups.length) return "취침 상세 데이터가 없습니다.";

    const rows = [];
    groups.forEach(g => {
      const dateIso = g.dateIso || "";
      const total = g.total ?? 0;
      const details = Array.isArray(g.details) ? g.details : [];
      if (!details.length) {
        rows.push([dateIso, "", "취침", total]);
      } else {
        details.forEach(d => {
          rows.push([dateIso, d.period || "-", d.reason || "취침", d.count ?? 0]);
        });
      }
    });

    return renderSimpleTable_(["날짜", "교시", "사유", "횟수"], rows);
  }

  function renderGradeDetail_(gd) {
    const st = gd.student || {};
    const s = gd.subjects || {};
    const lines = [];

    lines.push(`<div style="margin-bottom:10px;"><b>${escapeHtml(gd.sheetName || "")}</b> (${escapeHtml(gd.exam || "")})</div>`);
    lines.push(fmtKeyVal("좌석", st.seat || ""));
    lines.push(fmtKeyVal("학번", st.studentId || ""));
    lines.push(fmtKeyVal("이름", st.name || st.studentName || ""));

    const rows = [
      // ✅ 국어와 수학의 표준점수, 백분위, 등급을 'expected_' 필드로 변경
      ["국어", s.kor?.raw_total ?? s.kor?.raw ?? "", s.kor?.expected_std ?? "", s.kor?.expected_pct ?? "", s.kor?.expected_grade ?? ""],
      ["수학", s.math?.raw_total ?? s.math?.raw ?? "", s.math?.expected_std ?? "", s.math?.expected_pct ?? "", s.math?.expected_grade ?? ""],
      ["영어", s.eng?.raw ?? "", "", "", s.eng?.grade ?? ""],
      ["한국사", s.hist?.raw ?? "", "", "", s.hist?.grade ?? ""],
      [s.tam1?.name || "탐구1", s.tam1?.raw ?? "", s.tam1?.expected_std ?? "", s.tam1?.expected_pct ?? "", s.tam1?.expected_grade ?? ""],
      [s.tam2?.name || "탐구2", s.tam2?.raw ?? "", s.tam2?.expected_std ?? "", s.tam2?.expected_pct ?? "", s.tam2?.expected_grade ?? ""],
    ];

    return `
      <div>${lines.join("")}</div>
      <div style="margin-top:12px;">
        ${renderSimpleTable_(["과목", "원점수", "표준", "백분위", "등급"], rows)}
      </div>
    `;
  }

  // ====== 마지막 선택 학생 저장(버튼 상세용) ======
  const _origRender = renderStudentDetail;
  renderStudentDetail = function(data){
    window.__lastStudent = {
      seat: data?.student?.seat || "",
      studentId: data?.student?.studentId || "",
      studentName: data?.student?.studentName || "",
      teacher: data?.student?.teacher || ""
    };
    _origRender(data);
  };

/** ✅ 관리자용 성적 추이 그래프 로드 및 필터 바인딩 */
async function loadAdminGradeTrend(seat, studentId) {
  const canvas = $("adminGradeTrendChart");
  const loadingMsg = $("trendChartLoading");
  if (!canvas) return;

  try {
    const token = await issueStudentToken_(seat, studentId);
    const res = await apiPost("grade_trend", { token });
    
    if (!res.ok || !res.items || res.items.length === 0) {
      if (loadingMsg) loadingMsg.textContent = "표시할 성적 데이터가 부족합니다.";
      return;
    }

    if (loadingMsg) loadingMsg.style.display = "none";
    const ctx = canvas.getContext('2d');
    
    if (window.adminChart) window.adminChart.destroy(); // 이전 차트 파괴
    
    window.adminChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: res.items.map(it => it.label),
        datasets: [
          { label: '국어(예상)', data: res.items.map(it => it.kor_pct), borderColor: '#3498db', tension: 0.3, fill: false },
          { label: '수학(예상)', data: res.items.map(it => it.math_pct), borderColor: '#e74c3c', tension: 0.3, fill: false },
          { label: '탐구1(예상)', data: res.items.map(it => it.tam1_pct), borderColor: '#2ecc71', tension: 0.3, borderDash: [5, 5], fill: false },
          { label: '탐구2(예상)', data: res.items.map(it => it.tam2_pct), borderColor: '#f1c40f', tension: 0.3, borderDash: [5, 5], fill: false },
          // 영어는 보조축 y_eng 사용
          { label: '영어(등급)', data: res.items.map(it => it.eng_grade), borderColor: '#9b59b6', backgroundColor: '#9b59b6', tension: 0.3, yAxisID: 'y_eng', fill: false, pointStyle: 'rectRot', pointRadius: 6 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          y: { min: 0, max: 100, title: { display: true, text: '예상 백분위', color: 'rgba(255,255,255,0.5)' }, ticks: { color: 'rgba(255,255,255,0.5)' } },
          y_eng: { position: 'right', min: 1, max: 9, reverse: true, grid: { drawOnChartArea: false }, title: { display: true, text: '영어 등급', color: '#9b59b6' }, ticks: { color: '#9b59b6', stepSize: 1 } },
          x: { ticks: { color: 'rgba(255,255,255,0.5)' } }
        },
        plugins: { legend: { display: false } } // 기본 범례 숨김 (커스텀 버튼 사용)
      }
    });

    /** ✅ 과목 필터 버튼 클릭 이벤트 연결 */
    const filterBtns = document.querySelectorAll(".filter-btn");
    filterBtns.forEach(btn => {
      btn.onclick = function() {
        if (!window.adminChart) return;
        const index = parseInt(this.dataset.index);
        const isVisible = window.adminChart.isDatasetVisible(index);

        if (isVisible) {
          window.adminChart.hide(index); // 선 숨기기
          this.style.opacity = "0.3";    // 버튼 흐리게
        } else {
          window.adminChart.show(index); // 선 보이기
          this.style.opacity = "1";      // 버튼 밝게
        }
      };
    });

  } catch (e) {
    if (loadingMsg) loadingMsg.textContent = "그래프 로드 중 오류가 발생했습니다.";
  }
}
  /** ✅ 취약 영역 방사형 차트(Radar Chart) 렌더링 */
function renderVulnerabilityChart(analysisData) {
  const canvas = document.getElementById("vulnRadarChart");
  const msgEl = document.getElementById("vulnChartMsg");
  if (!canvas || !analysisData || analysisData.length === 0) return;

  if (msgEl) msgEl.style.display = "none";
  const ctx = canvas.getContext('2d');
  
  // 기존 차트가 있으면 삭제하고 새로 그립니다.
  if (window.vulnChart) window.vulnChart.destroy();

  window.vulnChart = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: analysisData.map(d => d.area), // 단원명
      datasets: [{
        label: '성취도(%)',
        data: analysisData.map(d => d.score), // 성취도 점수
        backgroundColor: 'rgba(52, 152, 219, 0.2)',
        borderColor: '#3498db',
        pointBackgroundColor: '#3498db',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        r: {
          min: 0,
          max: 100,
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.1)' },
          angleLines: { color: 'rgba(255,255,255,0.1)' },
          pointLabels: {
            color: 'rgba(255,255,255,0.7)',
            font: { size: 12, weight: 'bold' }
          },
          ticks: { display: false, stepSize: 20 }
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}
}); // ✅ 이 닫는 괄호가 파일의 '진짜' 마지막 줄에 딱 하나만 있어야 합니다!








