/***********************
* 관리자(Admin) - 학생 검색/상세/상세버튼(출결/취침/이동/교육점수/성적)
***********************/

// ✅ 여기에 Apps Script Web App URL(…/exec) 넣기
const API_BASE = "https://script.google.com/macros/s/AKfycbwxYd2tK4nWaBSZRyF0A3_oNES0soDEyWz0N0suAsuZU35QJOSypO2LFC-Z2dpbDyoD/exec";

// ✅ 성적 그래프 및 상태 관리를 위한 전역 변수
let currentTrendItems = []; 
let currentMode = 'pct';
let showTop30 = false;         // 처음엔 꺼짐 상태
let showChoiceTop30 = false;   // ✅ [추가] 선택과목 상위 30% 스위치 상태
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

  // 💡 [추가] 1교시 시작 시간(08:00)보다 이르면 1교시부터 시작한 것으로 간주
  const firstPeriodStart = hhmmToMin_(PERIODS_ATT_[0].start);
  if (t < firstPeriodStart) return 1;

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
    
    // 💡 [핵심 수정] sp가 1 이상이면 무조건 꽉 채우도록 보정
    const start = (from <= to) ? from : to;

    map[iso] = map[iso] || {};
    for (let p = start; p <= to; p++) {
      map[iso][p] = reason;
    }
  }
  return map;
}

/** =========================
* ✅ 설문 기록을 출결 스케줄에 맞게 맵핑
* ========================= */
function buildSurveyMapFromItems_(items) {
  const map = {}; 
  const arr = Array.isArray(items) ? items : [];
  
  for (const it of arr) {
    const iso = String(it?.date || "").trim();
    let reason = String(it?.reason || "").trim(); // 원본 사유
    const timeType = String(it?.timeType || "").trim();

    if (!iso || !reason || !timeType) continue;

    // 💡 [추가] 사유를 "학원", "병원", "개인일정" 핵심 단어로만 축약합니다.
    if (reason.includes("학원")) reason = "학원";
    else if (reason.includes("병원")) reason = "병원";
    else if (reason.includes("개인일정")) reason = "개인일정";
    else {
      // 혹시 다른 사유가 있을 경우, 괄호 '(' 앞부분까지만 잘라서 깔끔하게 보여줍니다.
      reason = reason.split("(")[0].trim();
    }

    // F열(timeType) 내용으로 정확히 시간대 파악
    let startP = 0, endP = 0;
    if (timeType.includes("결석")) { startP = 1; endP = 8; }
    else if (timeType.includes("오전")) { startP = 1; endP = 3; }
    else if (timeType.includes("오후")) { startP = 4; endP = 6; }
    else if (timeType.includes("야간") || timeType.includes("저녁")) { startP = 7; endP = 8; }

    if (startP > 0) {
      map[iso] = map[iso] || {};
      for (let p = startP; p <= endP; p++) {
        // 불필요한 기호 제거 후 짧아진 사유로 저장
        let cleanReason = reason.replace(/◼/g, '').trim();
        map[iso][p] = `[설문] ${cleanReason}`; 
      }
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

// 💡 [수정] 원본 데이터(rawData)를 두 번째 인자로 받아 배치표를 꺼냅니다.
function renderGradeTableHtml_(rows, rawData) {
  const tableHtml = `
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

  // 💡 표 밑에 대학 라인 예측 상자 부착
  const universityLineHtml = (rawData && rawData.placement) ? getUniversityLineHtml_(rawData.placement) : "";
  
  return tableHtml + universityLineHtml;
}

/** =========================
 * ✅ [프론트엔드 NEW] 대학 라인 예측 화면 (시뮬레이션 스위치 100% 작동 픽스!)
 * ========================= */
function getUniversityLineHtml_(placement) {
  if (!placement || !placement.allMatches) return "";

  const ALL_GROUPS = ['가', '나', '다', '군외'];
  const streamText = placement.stream || "";
  const safeMathType = streamText.includes("미기") ? "미기" : "확통";
  let safeTamType = "과탐";
  if (streamText.includes("사과탐")) safeTamType = "사과탐";
  else if (streamText.includes("사탐")) safeTamType = "사탐";

  window.__currentSimStatus = {
      score: placement.defaultUpScore,
      math: safeMathType,
      tamType: safeTamType,
      search: "" 
  };
  window.__currentPlacement = placement;

  window.renderDepartmentListHelper = function(deptDataList, keyword = "") {
    const limit = keyword ? 10 : 4; 
    return deptDataList.slice(0, limit).map(d => {
        const name = typeof d === 'string' ? d : (d.name || "");
        const badges = d.badges || []; 
        const deptScore = d.score ? d.score : ""; 
        
        let displayName = escapeHtml(name);
        if (keyword && name.includes(keyword)) {
            displayName = `<span style="background:#f1c40f; color:#000; padding:0 2px; border-radius:2px; font-weight:900;">${escapeHtml(name)}</span>`;
        }

        let scoreHtml = deptScore ? `<span style="color:#f39c12; font-size:11px; font-weight:900; margin-left:4px;">(${deptScore})</span>` : "";

        let badgeHtmlStr = "";
        badges.forEach(b => {
            let bg = "#7f8c8d"; 
            if (b === "과1") bg = "#3498db";         
            else if (b === "사1") bg = "#9b59b6";    
            else if (b === "탐1") bg = "#e67e22";    
            else if (b === "지역인재") bg = "#27ae60"; 
            else if (b === "지역균형") bg = "#16a085"; 
            badgeHtmlStr += `<span style="background:${bg}; color:#fff; border-radius:4px; padding:2px 5px; font-size:10px; font-weight:800; white-space:nowrap; box-shadow: 0 1px 2px rgba(0,0,0,0.3); display:inline-block;">${b}</span>`;
        });
        
        return `
          <div style="margin-bottom:6px; padding-bottom:4px; border-bottom:1px solid rgba(255,255,255,0.03); display:flex; flex-direction:column; align-items:center; gap:4px; word-break:keep-all;">
            <span style="font-weight:600; line-height:1.3; color:#f8f9fa; text-align:center;">${displayName}${scoreHtml}</span>
            ${badgeHtmlStr ? `<div style="display:flex; flex-wrap:wrap; gap:3px; justify-content:center;">${badgeHtmlStr}</div>` : ""}
          </div>
        `;
    }).join("");
  };

  window.renderSingleGroupDataHelper = function(univDataObj, keyword = "") {
    if (!univDataObj || Object.keys(univDataObj).length === 0) {
        return `<div style="padding:20px; text-align:center; color:rgba(255,255,255,0.3); font-size:12px; font-style:italic;">매칭 대학 없음</div>`;
    }

    let univHeaders = '';
    let deptCells = '';
    const limit = keyword ? 10 : 6;
    const univKeys = Object.keys(univDataObj).slice(0, limit);

    univKeys.forEach(u => {
      const isUnivMatch = keyword && u.includes(keyword);
      const headerBg = isUnivMatch ? "rgba(52, 152, 219, 0.5)" : "rgba(255,255,255,0.1)";
      const headerColor = isUnivMatch ? "#fff" : "rgba(255,255,255,0.8)";

      univHeaders += `<th style="border:1px solid rgba(255,255,255,0.2); padding:6px; background:${headerBg}; color:${headerColor}; font-size:12px; font-weight:bold; min-width:90px;">${escapeHtml(u)}</th>`;
      deptCells += `<td style="border:1px solid rgba(255,255,255,0.1); padding:6px; font-size:11px; vertical-align:top; color:rgba(255,255,255,0.8);">${window.renderDepartmentListHelper(univDataObj[u], keyword)}</td>`;
    });

    return `
      <table style="width:100%; border-collapse:collapse; text-align:center; height:100%;">
        <thead><tr>${univHeaders}</tr></thead>
        <tbody><tr>${deptCells}</tr></tbody>
      </table>
    `;
  };

  window.runUniversitySimulation = function() {
    const status = window.__currentSimStatus;
    const placeData = window.__currentPlacement;
    if (!status || !placeData) return;

    const upLines = { '가': {}, '나': {}, '다': {}, '군외': {} };
    const score = Number(status.score);
    const keyword = (status.search || "").trim();
    
    placeData.allMatches.forEach(m => {
      // 💡 [수정] 프론트엔드에서 수신한 조건(mathReq, tamTypeReq)으로 완벽하게 필터링!
      if (m.mathReq === "미기" && status.math !== "미기") return;
      if (m.mathReq === "확통" && status.math !== "확통") return;

      if (m.tamReqCount === 1) {
          if (m.tamTypeReq === "과" && status.tamType === "사탐") return;
          if (m.tamTypeReq === "사" && status.tamType === "과탐") return;
      } else {
          if (m.tamTypeReq === "과" && status.tamType !== "과탐") return;
          if (m.tamTypeReq === "사" && status.tamType !== "사탐") return; 
          if ((m.tamTypeReq === "과" || m.tamTypeReq === "사") && status.tamType === "사과탐") return;
      }

      let isMatch = false;
      if (keyword) {
          if (m.univ.includes(keyword) || m.dept.includes(keyword)) isMatch = true;
      } else {
          if (m.score >= score - 1 && m.score <= score + 2) isMatch = true;
      }

      if (!isMatch) return;

      if (!upLines[m.gun][m.univ]) upLines[m.gun][m.univ] = [];
      upLines[m.gun][m.univ].push({ name: m.dept, badges: m.badges, score: m.score });
    });

    ALL_GROUPS.forEach(gun => {
       const td = document.getElementById('up-data-' + gun);
       if (td) td.innerHTML = window.renderSingleGroupDataHelper(upLines[gun], keyword);
    });
  };

  window.changeSimOption = function(type, value, element) {
      window.__currentSimStatus[type] = value;
      const parent = element.parentElement;
      parent.querySelectorAll('button').forEach(b => {
          b.style.background = 'rgba(255,255,255,0.05)';
          b.style.color = 'rgba(255,255,255,0.6)';
          b.style.borderColor = 'rgba(255,255,255,0.1)';
      });
      element.style.background = '#f1c40f';
      element.style.color = '#000';
      element.style.borderColor = '#f1c40f';
      window.runUniversitySimulation();
  };

  // 💡 [수정] 왼쪽 '내 점수' 파트도 학생의 '초기 응시 과목' 기준으로 정확히 필터링해서 보여줍니다!
  const myLines = { '가': {}, '나': {}, '다': {}, '군외': {} };
  placement.allMatches.forEach(m => {
    if (m.score >= placement.myScore - 1 && m.score <= placement.myScore + 1) {
      
      if (m.mathReq === "미기" && safeMathType !== "미기") return;
      if (m.mathReq === "확통" && safeMathType !== "확통") return;

      if (m.tamReqCount === 1) {
          if (m.tamTypeReq === "과" && safeTamType === "사탐") return;
          if (m.tamTypeReq === "사" && safeTamType === "과탐") return;
      } else {
          if (m.tamTypeReq === "과" && safeTamType !== "과탐") return;
          if (m.tamTypeReq === "사" && safeTamType !== "사탐") return; 
          if ((m.tamTypeReq === "과" || m.tamTypeReq === "사") && safeTamType === "사과탐") return;
      }

      if (!myLines[m.gun][m.univ]) myLines[m.gun][m.univ] = [];
      myLines[m.gun][m.univ].push({ name: m.dept, badges: m.badges, score: m.score });
    }
  });

  let rowsHtml = '';
  ALL_GROUPS.forEach((gun, idx) => {
    const isFirst = (idx === 0);
    rowsHtml += `<tr style="border-top:1px solid rgba(255,255,255,0.2);">`;
    
    if (isFirst) {
        rowsHtml += `<td rowspan="4" style="width:45px; background:#2980b9; color:#fff; text-align:center; font-weight:900; font-size:13px; border-right:1px solid rgba(255,255,255,0.2);">내<br>점<br>수<br><br><span style="font-size:16px; color:#f1c40f;">${placement.myScore}</span></td>`;
    }
    
    rowsHtml += `<td style="width:30px; text-align:center; font-weight:bold; font-size:13px; background:rgba(255,255,255,0.05); color:#fff; border-right:1px solid rgba(255,255,255,0.2);">${escapeHtml(gun)}</td>`;
    rowsHtml += `<td style="padding:0; vertical-align:top; border-right:1px solid rgba(255,255,255,0.2); min-width:300px;">${window.renderSingleGroupDataHelper(myLines[gun], window.__currentSimStatus.search)}</td>`;

    if (isFirst) {
        rowsHtml += `<td rowspan="4" style="width:40px; text-align:center; color:#e74c3c; font-size:20px; font-weight:bold; border-right:1px solid rgba(255,255,255,0.2); background:rgba(0,0,0,0.1);">▶</td>`;
    }
    
    rowsHtml += `<td style="width:30px; text-align:center; font-weight:bold; font-size:13px; background:rgba(255,255,255,0.05); color:#fff; border-right:1px solid rgba(255,255,255,0.2);">${escapeHtml(gun)}</td>`;
    rowsHtml += `<td id="up-data-${gun}" style="padding:0; vertical-align:top; min-width:300px;"></td>`;
    rowsHtml += `</tr>`;
  });

  const btnStyle = "background:rgba(255,255,255,0.05); color:rgba(255,255,255,0.6); border:1px solid rgba(255,255,255,0.1); border-radius:4px; padding:3px 8px; font-size:11px; cursor:pointer; font-weight:bold; outline:none; margin-right:3px; transition:all 0.2s;";
  const activeBtnStyle = "background:#f1c40f; color:#000; border:1px solid #f1c40f;";

  const panelHtml = `
    <div style="display:flex; align-items:center; gap:10px; padding:6px 10px; background:rgba(142, 68, 173, 0.2); border:1px dashed rgba(142, 68, 173, 0.4); border-radius:6px; margin-top:8px; flex-wrap:wrap;">
      <div style="color:#fff; font-weight:bold; font-size:13px; white-space:nowrap;">🛠️ 시뮬레이션 조정 패널</div>
      
      <div style="display:flex; align-items:center; gap:5px; margin-left:10px;">
        <span style="color:rgba(255,255,255,0.7); font-size:12px;">목표 백분위:</span>
        <input type="number" value="${placement.defaultUpScore}" 
               oninput="window.__currentSimStatus.score=this.value; window.runUniversitySimulation()" 
               style="width:65px; background:rgba(0,0,0,0.5); border:1px solid rgba(241,196,15,0.6); color:#f1c40f; font-size:15px; font-weight:900; text-align:center; outline:none; padding:4px 6px; border-radius:4px; box-shadow:inset 0 1px 3px rgba(0,0,0,0.5); cursor:pointer;" />
      </div>

      <div style="display:flex; align-items:center; gap:5px; margin-left:10px;">
        <span style="color:rgba(255,255,255,0.7); font-size:12px;">🎯 타겟 검색:</span>
        <input type="text" placeholder="대학/학과 검색" 
               oninput="window.__currentSimStatus.search=this.value; window.runUniversitySimulation()" 
               style="width:150px; background:rgba(0,0,0,0.5); border:1px solid rgba(52, 152, 219, 0.6); color:#3498db; font-size:13px; outline:none; padding:4px 8px; border-radius:4px; font-weight:bold;" />
      </div>

      <div style="width:1px; height:15px; background:rgba(255,255,255,0.1);"></div>

      <div id="sim-math-options" style="display:flex; align-items:center; gap:5px;">
        <button onclick="window.changeSimOption('math', '미기', this)" style="${btnStyle}${safeMathType==='미기'?activeBtnStyle:''}">미적/기하</button>
        <button onclick="window.changeSimOption('math', '확통', this)" style="${btnStyle}${safeMathType==='확통'?activeBtnStyle:''}">확률과통계</button>
      </div>

      <div id="sim-tam-options" style="display:flex; align-items:center; gap:5px;">
        <button onclick="window.changeSimOption('tamType', '과탐', this)" style="${btnStyle}${safeTamType==='과탐'?activeBtnStyle:''}">과탐 2</button>
        <button onclick="window.changeSimOption('tamType', '사탐', this)" style="${btnStyle}${safeTamType==='사탐'?activeBtnStyle:''}">사탐 2</button>
        <button onclick="window.changeSimOption('tamType', '사과탐', this)" style="${btnStyle}${safeTamType==='사과탐'?activeBtnStyle:''}">사+과 융합</button>
      </div>
    </div>
  `;

  setTimeout(() => { if (window.runUniversitySimulation) window.runUniversitySimulation(); }, 10);

  return `
    <div style="margin-top:20px; font-family:sans-serif; animation: fadeIn 0.4s ease;">
      <div style="background:#0a0f19; border-bottom:2px solid #f1c40f; display:flex; justify-content:space-between; padding:8px 12px; align-items:center;">
        <div style="color:#fff; font-weight:800; font-size:14px;">▣ 정시 지원가능 대학 & 학과 시뮬레이션 <span style="font-size:11px; opacity:0.6; font-weight:normal;">(백분위 합산 기준)</span></div>
        <div style="background:#f1c40f; color:#000; padding:2px 10px; font-weight:900; font-size:12px; border-radius:2px;">학생 실제 응시: <span style="color:#c0392b; margin-left:4px;">${escapeHtml(placement.stream)}</span></div>
      </div>
      ${panelHtml}
      <div style="margin-top:8px; border:1px solid rgba(255,255,255,0.2); background:rgba(0,0,0,0.2); border-radius:6px; overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse;"><tbody>${rowsHtml}</tbody></table>
      </div>
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
* ✅ 정오표(Errata) 렌더 (+ 출제영역 세련된 뱃지 디자인 & 막대그래프)
* ========================= */
function renderErrataHtml_(errata) {
  if (!errata || !errata.subjects) return "";
  const s = errata.subjects;
  const qInfo = errata.qInfo || {}; 
  
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

  // 💡 [디자인 핵심] 텍스트를 분석하여 예쁜 뱃지 HTML로 변환해주는 함수
  const formatAreaText = (text) => {
    if (!text || text === "-") return "-";
    const parts = text.split(" - ");
    if (parts.length === 1) return `<span style="color:#e2e8f0;">${escapeHtml(text)}</span>`;

    const beh = parts.pop(); // 항상 마지막은 행동영역
    let firstPart = parts[0];
    let prefixHtml = "";
    
    // "수1", "수2", "1.", "12." 등의 접두사 감지 후 뱃지로 변환
    const prefixMatch = firstPart.match(/^(수1|수2|\d+\.)\s+(.*)/);
    if (prefixMatch) {
        let pText = prefixMatch[1].replace('.', '');
        // 과목별 뱃지 색상 (수학은 파랑, 탐구는 보라 톤)
        let bg = pText.includes('수') ? 'rgba(52, 152, 219, 0.2)' : 'rgba(155, 89, 182, 0.2)';
        let color = pText.includes('수') ? '#60a5fa' : '#c084fc';
        prefixHtml = `<span style="display:inline-block; background:${bg}; color:${color}; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:800; margin-right:6px; transform:translateY(-1px);">${pText}</span>`;
        firstPart = prefixMatch[2];
    }

    let html = `<div style="line-height:1.6;">`; // 감싸는 div (줄바꿈 대비)
    html += `${prefixHtml}<span style="color:#f8fafc; font-weight:600; font-size:12px;">${escapeHtml(firstPart)}</span>`;

    // 탐구영역처럼 소단원이 중간에 껴있는 경우 화살표(›)로 표시
    if (parts.length > 1) {
        html += ` <span style="color:#64748b; font-size:11px; margin:0 4px;">›</span> <span style="color:#cbd5e1; font-size:11px;">${escapeHtml(parts[1])}</span>`;
    }

    // 행동영역 회색 태그
    html += `<span style="display:inline-block; margin-left:6px; font-size:10px; background:rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); padding:1px 6px; border-radius:4px; color:#9fb3c8; white-space:nowrap; transform:translateY(-1px);">${escapeHtml(beh)}</span>`;
    html += `</div>`;
    return html;
  };

  const renderTable = (oxArr, rateArr, qFrom, qTo, subjKey) => {
    const oxMap = asMap(oxArr, "q");
    const rtMap = asMap(rateArr, "q");
    const rows = [];
    for (let q = qFrom; q <= qTo; q++) {
      const ox = oxMap.get(q)?.ox || "";
      const rt = rtMap.get(q);
      const isWrong = (ox !== "" && ox !== "O" && ox !== "○");
      
      const pct = rt?.pct;
      const isHighPct = (pct !== null && pct !== undefined && pct >= 70);
      const highlightPct = (isWrong && isHighPct);

      const infoTextRaw = (qInfo[subjKey] && qInfo[subjKey][q]) ? qInfo[subjKey][q] : "-";
      
      // 💡 여기서 텍스트를 예쁜 HTML 뱃지로 변경합니다!
      const formattedArea = formatAreaText(infoTextRaw); 

      let barHtml = `<div style="text-align:right; width:45px; color:rgba(255,255,255,0.5);">-</div>`;
      if (pct !== null && pct !== undefined) {
         let barColor = "#2ecc71"; 
         if (pct <= 30) barColor = "#e74c3c"; 
         else if (pct <= 70) barColor = "#f1c40f"; 
         
         barHtml = `
            <div style="display:flex; align-items:center; gap:8px; justify-content: flex-end;">
                <div style="width:40px; text-align:right; font-size:12px;">${pct}%</div>
                <div style="width:60px; height:6px; background:rgba(255,255,255,0.1); border-radius:3px; overflow:hidden;">
                    <div style="width:${pct}%; height:100%; background:${barColor}; border-radius:3px;"></div>
                </div>
            </div>`;
      }

      // 출제 영역 td 설정 (max-width 약간 넓히고 줄바꿈 허용으로 변경)
      rows.push(`
        <tr style="transition: background 0.1s;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
          <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); text-align:center; width:45px; font-weight:bold;">${q}</td>
          <td class="${isWrong ? "errata-x-high" : ""}" style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); text-align:center; width:50px; font-weight:900; font-size:14px;">${escapeHtml(ox || "")}</td>
          <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); text-align:left; max-width:280px; word-break:keep-all;">${formattedArea}</td>
          <td class="${highlightPct ? "errata-x-high" : ""}" style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06);">${barHtml}</td>
          <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); text-align:right; opacity:.7; font-size:12px; width:60px;">${rt ? `${rt.o}/${rt.n}` : "-"}</td>
        </tr>
      `);
    }

    return `
      <div style="overflow:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:13px; table-layout: fixed;">
          <thead>
            <tr style="background:rgba(255,255,255,.03);">
              <th style="padding:8px; text-align:center; width:45px;">문항</th>
              <th style="padding:8px; text-align:center; width:50px;">O/X</th>
              <th style="padding:8px; text-align:left;">출제 영역 <span style="font-size:10px; font-weight:normal; opacity:0.6;">(단원-행동영역)</span></th>
              <th style="padding:8px; text-align:right; width:130px;">정답률</th>
              <th style="padding:8px; text-align:right; width:60px;">O/응시</th>
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

  if (s.kor?.common) pushAcc("국어 공통", "문항 1~34" + (korChoice ? ` · ${korChoice}` : ""), renderTable(s.kor.common.ox, s.kor.common.rate, 1, 34, "국어"));
  if (s.kor?.choice) pushAcc("국어 선택", "문항 35~45" + (korChoice ? ` · ${korChoice}` : ""), renderTable(s.kor.choice.ox, s.kor.choice.rate, 35, 45, "국어"));
  if (s.math?.common) pushAcc("수학 공통", "문항 1~22" + (mathChoice ? ` · ${mathChoice}` : ""), renderTable(s.math.common.ox, s.math.common.rate, 1, 22, "수학"));
  if (s.math?.choice) pushAcc("수학 선택", "문항 23~30" + (mathChoice ? ` · ${mathChoice}` : ""), renderTable(s.math.choice.ox, s.math.choice.rate, 23, 30, "수학"));
  if (s.eng?.all) pushAcc("영어", "문항 1~45", renderTable(s.eng.all.ox, s.eng.all.rate, 1, 45, "영어"));

  const tamItems = Array.isArray(s.tam?.items) ? s.tam.items : [];
  tamItems.forEach(it => {
    if (!it?.name || !it?.all) return;
    pushAcc(`탐구 (${it.name})`, "문항 1~20", renderTable(it.all.ox, it.all.rate, 1, 20, it.name));
  });

  const hasAny = blocks.length > 0;

  return `
    <div class="card" style="margin-top:14px;">
      <div class="card-head" style="display:flex; align-items:center; justify-content:space-between;">
        <div style="font-weight:800;">정오표 상세 분석</div>
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
    if (!sess?.adminToken) throw new Error("관리자 세션이 없습니다.");
    
    // 💡 백엔드 파라미터 불일치 문제 해결: adminToken과 token 둘 다 전송
    const data = await apiPost("admin_issue_token", { 
      adminToken: sess.adminToken, 
      token: sess.adminToken, 
      seat, 
      studentId 
    });
    
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
      renderStudentDetail({ student: st, summary: cached }); 
      return;
    }

    // 2️⃣ 보관함에 없을 때만 로딩 표시 후 호출
    detailBody.innerHTML = "데이터를 불러오는 중…";
    try {
      // 💡 백엔드 호환성을 위해 token 파라미터도 함께 전송
      const data = await apiPost("admin_student_detail", { 
        adminToken: sess.adminToken, 
        token: sess.adminToken, 
        seat, 
        studentId 
      });
      
      if (!data.ok) { 
        // 💡 에러 메시지를 화면에 정확히 표시
        detailBody.innerHTML = `<div style="color:#ff6b6b;">${escapeHtml(data.error || "조회 실패")}</div>`; 
        
        // 진짜 세션 만료인 경우 깔끔하게 자동 로그아웃 처리
        if (data.error && data.error.includes("만료")) {
          setTimeout(() => { clearAdminSession(); location.reload(); }, 1500);
        }
        return; 
      }
      
      const summary = await loadSummariesForStudent_(seat, studentId);
      summary.student = st;
      setSummaryCache(key, summary);
      data.summary = summary;
      renderStudentDetail(data);
    } catch (e) {
      detailBody.innerHTML = `<div style="color:#ff6b6b;">${escapeHtml(e.message || "네트워크 오류")}</div>`;
      if (e.message && e.message.includes("만료")) {
        setTimeout(() => { clearAdminSession(); location.reload(); }, 1500);
      }
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
                    <span style="font-weight: 800; color: ${wColor};">최근 7일 출석률</span>
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
  <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px;">
    <div class="card-title" style="font-size:15px; margin:0;">🚶‍♂️ 이동 요약 (최근 7일)</div>
    <button class="btn btn-ghost btn-mini" id="btnMoveDetail" style="padding:6px 10px;">상세</button>
  </div>
  <div class="card-sub">
    ${mv && mv.ok ? `
      화장실 : <b>${mv.restroom7d ?? 0}회</b><br>
      복귀 안함 : <b style="color:${(mv.noReturn7d > 0) ? '#ff4757' : 'inherit'};">${mv.noReturn7d ?? 0}회</b><br>
      <div style="font-size:11px; opacity:0.6; margin-top:6px; padding-top:4px; border-top:1px dashed rgba(255,255,255,0.1);">
        최근: ${escapeHtml(mv.latestText || "-")} (${escapeHtml(mv.latestDateTime.split(' ')[0])})
      </div>
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
              전체 누적점수: <b>${edu.monthTotal ?? 0}</b><br>
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
                
                <div style="display:flex; gap:4px; background:rgba(255,255,255,0.05); padding:2px; border-radius:8px; border:1px solid rgba(255,255,255,0.1); margin-right: 10px;">
                  <button class="btn btn-mini" id="btnViewChart" onclick="window.toggleGradeView('chart')" style="background:#f1c40f; border:none; padding:4px 10px; font-size:11px; border-radius:6px; cursor:pointer; color:#000; font-weight:bold; transition:all 0.2s;">📈 그래프</button>
                  <button class="btn btn-mini" id="btnViewTable" onclick="window.toggleGradeView('table')" style="background:transparent; border:none; padding:4px 10px; font-size:11px; border-radius:6px; cursor:pointer; color:rgba(255,255,255,0.5); font-weight:bold; transition:all 0.2s;">📋 표</button>
                </div>

                <div id="chartModeToggle" style="display:flex; gap:4px; background:rgba(255,255,255,0.05); padding:2px; border-radius:8px; border:1px solid rgba(255,255,255,0.1);">
                  <button class="btn btn-mini mode-btn active" data-mode="pct" style="background:#3498db; border:none; padding:4px 10px; font-size:11px; border-radius:6px; cursor:pointer; color:white; font-weight:bold;">백분위</button>
                  <button class="btn btn-mini mode-btn" data-mode="raw" style="background:transparent; border:none; padding:4px 10px; font-size:11px; border-radius:6px; cursor:pointer; color:rgba(255,255,255,0.5);">원점수</button>
                </div>

                <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                  <button id="btnToggleTop30" class="btn btn-mini" style="background:transparent; border:1px solid rgba(255,255,255,0.3); padding:4px 10px; font-size:11px; border-radius:6px; cursor:pointer; color:rgba(255,255,255,0.5); font-weight:bold;">전체 상위 30% OFF</button>
                  <button id="btnToggleChoiceTop30" class="btn btn-mini" style="background:transparent; border:1px solid rgba(255,255,255,0.3); padding:4px 10px; font-size:11px; border-radius:6px; cursor:pointer; color:rgba(255,255,255,0.5); font-weight:bold;">선택 상위 30% OFF</button>
                  
                  <div id="classButtonsContainer" style="display:flex; gap:6px; flex-wrap:wrap;"></div>
                </div>
              </div>
            </div>

            <div id="chartFilters" style="display:flex; gap:5px; flex-wrap:wrap;">
              <button id="btnFilterKor" class="btn btn-mini filter-btn active" data-index="0" style="background:#3498db; border:none;">국어</button>
              <button id="btnFilterMath" class="btn btn-mini filter-btn active" data-index="1" style="background:#e74c3c; border:none;">수학</button>
              <button id="btnFilterTam1" class="btn btn-mini filter-btn active" data-index="2" style="background:#2ecc71; border:none;">탐구1</button>
              <button id="btnFilterTam2" class="btn btn-mini filter-btn active" data-index="3" style="background:#f1c40f; border:none;">탐구2</button>
              <button id="btnFilterEng" class="btn btn-mini filter-btn active" data-index="4" style="background:#9b59b6; border:none;">영어</button>
            </div>
          
          <div id="grade-chart-container" style="display:block;">
            <div style="height: 240px; position: relative;"><canvas id="adminGradeTrendChart"></canvas></div>
            <div id="trendChartLoading" class="muted" style="font-size:12px; margin-top:5px;">데이터 분석 중...</div>
          </div>

          <div id="grade-table-container" style="display:none; margin-top:10px;">
            <div style="max-height: 280px; overflow: auto; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: rgba(0,0,0,0.2);">
              <table style="width:100%; border-collapse:collapse; text-align:center; font-size:12px; min-width: 1000px;">
                <thead style="position:sticky; top:0; z-index:10; background:#2a2d35;">
                  <tr>
                    <th rowspan="2" style="position:sticky; left:0; background:#2a2d35; z-index:11; padding:8px; border:1px solid rgba(255,255,255,0.1);">시험구분</th>
                    <th colspan="4" style="padding:8px; border:1px solid rgba(255,255,255,0.1);">국어</th>
                    <th colspan="4" style="padding:8px; border:1px solid rgba(255,255,255,0.1);">수학</th>
                    <th colspan="3" style="padding:8px; border:1px solid rgba(255,255,255,0.1);">영어</th>
                    <th colspan="4" style="padding:8px; border:1px solid rgba(255,255,255,0.1);">탐구1</th>
                    <th colspan="4" style="padding:8px; border:1px solid rgba(255,255,255,0.1);">탐구2</th>
                  </tr>
                  <tr style="position:sticky; top:33px; z-index:10; background:#2a2d35;">
                    <th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">원점</th><th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">표점</th><th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">백분위</th><th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">등급</th>
                    <th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">원점</th><th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">표점</th><th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">백분위</th><th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">등급</th>
                    <th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">원점</th><th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">백분위</th><th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">등급</th>
                    <th style="padding:6px; border:1px solid rgba(255,255,255,0.1); color:#2ecc71;">과목</th><th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">원점</th><th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">백분위</th><th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">등급</th>
                    <th style="padding:6px; border:1px solid rgba(255,255,255,0.1); color:#f1c40f;">과목</th><th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">원점</th><th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">백분위</th><th style="padding:6px; border:1px solid rgba(255,255,255,0.1);">등급</th>
                  </tr>
                </thead>
                <tbody id="accumulated-grade-table-body">
                  </tbody>
              </table>
            </div>
          </div>
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
        ? renderGradeTableHtml_(buildGradeTableRows_(grd.data || grd || {}), grd.data || grd || {}) 
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
        // 기존 try 블록 안의 코드를 아래처럼 수정해 주세요. (gs2 데이터를 추가로 넘겨줍니다)
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
          
          // 💡 [수정] 콤마 뒤에 gs2를 추가했습니다.
          if (tableHost) tableHost.innerHTML = renderGradeTableHtml_(buildGradeTableRows_(gs2), gs2);
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

        // ✅ 1. 정오표만 그리기 (상세 화면에 표 중복 제거)
        const errataHtml = errata ? renderErrataHtml_(errata) : `<div class="muted" style="margin-top:15px;">정오표 데이터가 없습니다.</div>`;
        
        wrap.innerHTML = errataHtml;
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
        
        // 백엔드의 att 안에 같이 딸려온 surveyItems로 맵을 만듭니다. (API 중복 호출 방지)
        const surveyMap = buildSurveyMapFromItems_(att.surveyItems || []); 

        targetEl.innerHTML = renderAttendanceDetail_(att, moveMap, surveyMap);
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
  function renderAttendanceDetail_(data, moveMap, surveyMap) {
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

 
  // 💡 완벽하게 매칭된 이동/설문 사유 가져오기
  const mvReason = (moveMap && moveMap[iso] && moveMap[iso][pNumFront]) ? String(moveMap[iso][pNumFront]) : "";
  const survReason = (surveyMap && surveyMap[iso] && surveyMap[iso][pNumFront]) ? String(surveyMap[iso][pNumFront]) : "";

  // 1. 스케줄 칸 텍스트 조립 (우선순위: 설문 > 시트 기록 > 이동)
  let s = sRaw;
  
  if (survReason) {
    // 설문 내용이 있으면 하늘색으로 강조해서 가장 우선으로 보여줌
    s = `<span style="color:#3498db; font-size:11px; font-weight:bold; background:rgba(52,152,219,0.1); padding:2px 4px; border-radius:4px;">${escapeHtml(survReason)}</span>`;
  } else if (sRaw === "" || sRaw === "-") {
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
 * 💡 [추가 기능] 그래프 / 표 뷰 전환 로직
 */
window.toggleGradeView = function(view) {
  const chartCont = document.getElementById('grade-chart-container');
  const tableCont = document.getElementById('grade-table-container');
  const btnChart = document.getElementById('btnViewChart');
  const btnTable = document.getElementById('btnViewTable');
  
  // 표 모드일 때 그래프 전용 컨트롤러(과목 필터, 상위30% 등)를 숨깁니다.
  const chartModeToggle = document.getElementById('chartModeToggle');
  const classButtonsContainer = document.getElementById('classButtonsContainer');
  const chartFilters = document.getElementById('chartFilters');
  const btnToggleTop30 = document.getElementById('btnToggleTop30');
  const btnToggleChoiceTop30 = document.getElementById('btnToggleChoiceTop30');

  if (view === 'table') {
    chartCont.style.display = 'none';
    tableCont.style.display = 'block';
    
    // 버튼 색상 반전
    btnChart.style.background = 'transparent'; btnChart.style.color = 'rgba(255,255,255,0.5)';
    btnTable.style.background = '#f1c40f'; btnTable.style.color = '#000';
    
    // 그래프 전용 UI 숨기기
    if(chartModeToggle) chartModeToggle.style.display = 'none';
    if(classButtonsContainer) classButtonsContainer.style.display = 'none';
    if(chartFilters) chartFilters.style.display = 'none';
    if(btnToggleTop30) btnToggleTop30.style.display = 'none';
    if(btnToggleChoiceTop30) btnToggleChoiceTop30.style.display = 'none';
  } else {
    chartCont.style.display = 'block';
    tableCont.style.display = 'none';
    
    btnChart.style.background = '#f1c40f'; btnChart.style.color = '#000';
    btnTable.style.background = 'transparent'; btnTable.style.color = 'rgba(255,255,255,0.5)';

    // 그래프 전용 UI 보이기
    if(chartModeToggle) chartModeToggle.style.display = 'flex';
    if(classButtonsContainer) classButtonsContainer.style.display = 'flex';
    if(chartFilters) chartFilters.style.display = 'flex';
    if(btnToggleTop30) btnToggleTop30.style.display = 'inline-block';
    if(btnToggleChoiceTop30) btnToggleChoiceTop30.style.display = 'inline-block';
  }
};

/**
 * 💡 [추가 기능] 백엔드 데이터(items)를 받아 누적 성적표를 그립니다.
 */
function renderAccumulatedGradeTable(items) {
  const tbody = document.getElementById('accumulated-grade-table-body');
  if (!tbody) return;

  if (!items || items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="19" style="padding:20px;">성적 데이터가 없습니다.</td></tr>';
    return;
  }

  // 값이 비었거나 0일 때 하이픈(-) 처리하는 헬퍼 함수
  const safeVal = (val) => {
    if (val === null || val === undefined || val === "" || val === "#REF!" || val === "FALSE") return "-";
    // 원점수가 0점일 경우 진짜 0점인지 빈 값인지 판단이 애매하면 아래 주석을 풀어 사용하세요
    // if (val === 0 || val === "0") return "-"; 
    return val;
  };
  
  // 탐구 과목명 축약 헬퍼
  const shorten = (v) => {
    if (!v) return "-";
    const map = { 
      "언어와매체":"언매", "화법과작문":"화작", "미적분":"미적", "확률과통계":"확통", "기하":"기하",
      "생활과윤리":"생윤", "사회문화":"사문", "정치와법":"정법", "윤리와사상":"윤사",
      "물리학1":"물1", "물리학2":"물2", "화학1":"화1", "화학2":"화2", 
      "생명과학1":"생1", "생명과학2":"생2", "지구과학1":"지1", "지구과학2":"지2"  
    };
    let s = String(v).replace(/\s+/g, "").replace(/Ⅰ|I/gi, "1").replace(/Ⅱ|II/gi, "2");
    return map[s] || s;
  };

  let htmlString = "";
  items.forEach(item => {
    htmlString += `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.05); transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
        <td style="position:sticky; left:0; background:#2a2d35; z-index:1; padding:8px; border:1px solid rgba(255,255,255,0.05); font-weight:bold; color:#fff;">${escapeHtml(item.label || "-")}</td>
        
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05);">${safeVal(item.kor_raw)}</td>
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05);">${safeVal(item.kor_std)}</td>
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05); color:#3498db; font-weight:bold;">${safeVal(item.kor_pct)}</td>
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05);">${safeVal(item.kor_grade)}</td>

        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05);">${safeVal(item.math_raw)}</td>
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05);">${safeVal(item.math_std)}</td>
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05); color:#e74c3c; font-weight:bold;">${safeVal(item.math_pct)}</td>
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05);">${safeVal(item.math_grade)}</td>

        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05);">${safeVal(item.eng_raw)}</td>
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05); text-align:center;">-</td>
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05); color:#9b59b6; font-weight:bold;">${safeVal(item.eng_grade)}</td>

        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05); color:#2ecc71;">${shorten(item.tam1_name)}</td>
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05);">${safeVal(item.tam1_raw)}</td>
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05); color:#2ecc71; font-weight:bold;">${safeVal(item.tam1_pct)}</td>
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05);">${safeVal(item.tam1_grade)}</td>

        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05); color:#f1c40f;">${shorten(item.tam2_name)}</td>
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05);">${safeVal(item.tam2_raw)}</td>
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05); color:#f1c40f; font-weight:bold;">${safeVal(item.tam2_pct)}</td>
        <td style="padding:8px; border:1px solid rgba(255,255,255,0.05);">${safeVal(item.tam2_grade)}</td>
      </tr>
    `;
  });
  tbody.innerHTML = htmlString;
} 

/**
 * 📈 [최종 통합 버전] 그래프 렌더링 + 모드 전환 + 과목 필터링 + 영어 원점수 30% 지원
 */
function renderTrendChart_(items) {
  currentTrendItems = items; 
  
  // 💡 [추가] 차트를 그릴 때 누적 성적표도 함께 렌더링해둡니다!
  renderAccumulatedGradeTable(items);

  const canvas = $("adminGradeTrendChart");
  const ctx = canvas.getContext('2d');
  if (window.adminChart) window.adminChart.destroy(); 

  document.querySelectorAll(".mode-btn").forEach(btn => {
    if (btn.dataset.mode === currentMode) {
      btn.style.background = "#3498db"; btn.style.color = "white"; btn.style.fontWeight = "bold"; btn.classList.add("active");
    } else {
      btn.style.background = "transparent"; btn.style.color = "rgba(255,255,255,0.5)"; btn.style.fontWeight = "normal"; btn.classList.remove("active");
    }
  });

  const suffix = currentMode === 'pct' ? '_pct' : '_raw';
  
  // ✅ [추가 1] 가장 최근 시험 기준으로 선택과목 이름 줄이기
  const lastItem = items[items.length - 1] || {};
  const shorten = (v) => {
    if (!v) return "";
    const map = { 
      "언어와매체":"언매", "화법과작문":"화작", "미적분":"미적", "확률과통계":"확통", "기하":"기하",
      "생활과윤리":"생윤", "사회문화":"사문", "정치와법":"정법", "윤리와사상":"윤사",
      "물리학1":"물1", "물리학2":"물2", "화학1":"화1", "화학2":"화2", 
      "생명과학1":"생1", "생명과학2":"생2", "지구과학1":"지1", "지구과학2":"지2"  
    };
    let s = String(v).replace(/\s+/g, "").replace(/Ⅰ|I/gi, "1").replace(/Ⅱ|II/gi, "2");
    return map[s] || s;
  };

  const korLabel = lastItem.kor_choice ? `국어(${shorten(lastItem.kor_choice)})` : '국어';
  const mathLabel = lastItem.math_choice ? `수학(${shorten(lastItem.math_choice)})` : '수학';
  const tam1Label = lastItem.tam1_name ? `탐1(${shorten(lastItem.tam1_name)})` : '탐구1';
  const tam2Label = lastItem.tam2_name ? `탐2(${shorten(lastItem.tam2_name)})` : '탐구2';

  // ✅ [추가 2] 화면의 필터 버튼 텍스트 업데이트
  if($("btnFilterKor")) $("btnFilterKor").textContent = korLabel;
  if($("btnFilterMath")) $("btnFilterMath").textContent = mathLabel;
  if($("btnFilterTam1")) $("btnFilterTam1").textContent = tam1Label;
  if($("btnFilterTam2")) $("btnFilterTam2").textContent = tam2Label;

  const classSet = new Set();
  items.forEach(it => {
    if (it.all_classes_cutoffs) Object.keys(it.all_classes_cutoffs).forEach(c => classSet.add(c));
  });
  const classList = Array.from(classSet).sort();

  const getClassVal = (it, className, subj) => {
    if (!it.all_classes_cutoffs || !it.all_classes_cutoffs[className]) return null;
    const key = currentMode === 'pct' ? (subj + '_pct') : subj;
    return it.all_classes_cutoffs[className][key];
  };

  const classStyles = [
    { pointStyle: 'triangle', borderDash: [2, 3] }, { pointStyle: 'star', borderDash: [4, 4] },
    { pointStyle: 'rectRounded', borderDash: [6, 2] }, { pointStyle: 'crossRot', borderDash: [8, 4] },
    { pointStyle: 'circle', borderDash: [1, 5] }, { pointStyle: 'rect', borderDash: [3, 6] }
  ];

  const datasets = [
    // --- [0~4] 학생 본인 성적 (✅ 하드코딩된 '국어'를 korLabel로 변경) ---
    { label: korLabel, data: items.map(it => it['kor' + suffix]), borderColor: '#3498db', tension: 0.3, fill: false },
    { label: mathLabel, data: items.map(it => it['math' + suffix]), borderColor: '#e74c3c', tension: 0.3, fill: false },
    { label: tam1Label, data: items.map(it => it['tam1' + suffix]), borderColor: '#2ecc71', tension: 0.3, fill: false },
    { label: tam2Label, data: items.map(it => it['tam2' + suffix]), borderColor: '#f1c40f', tension: 0.3, fill: false },
    { label: '영어', data: items.map(it => currentMode === 'pct' ? it.eng_grade : it.eng_raw), borderColor: '#9b59b6', tension: 0.3, yAxisID: currentMode === 'pct' ? 'y_eng' : 'y', fill: false, pointStyle: 'rectRot', pointRadius: 6 },
    
    // --- [5~9] 전체 상위 30% 컷오프 ---
    { label: '국어 전체 30%', data: items.map(it => it['cutoff_kor' + suffix]), borderColor: 'rgba(52, 152, 219, 0.4)', backgroundColor: 'rgba(52, 152, 219, 0.4)', borderWidth: 2, borderDash: [6, 6], pointRadius: 4, pointStyle: 'rect', tension: 0.3, fill: false, hidden: !showTop30 },
    { label: '수학 전체 30%', data: items.map(it => it['cutoff_math' + suffix]), borderColor: 'rgba(231, 76, 60, 0.4)', backgroundColor: 'rgba(231, 76, 60, 0.4)', borderWidth: 2, borderDash: [6, 6], pointRadius: 4, pointStyle: 'rect', tension: 0.3, fill: false, hidden: !showTop30 },
    { label: '탐구1 전체 30%', data: items.map(it => it['cutoff_tam1' + suffix]), borderColor: 'rgba(46, 204, 113, 0.4)', backgroundColor: 'rgba(46, 204, 113, 0.4)', borderWidth: 2, borderDash: [6, 6], pointRadius: 4, pointStyle: 'rect', tension: 0.3, fill: false, hidden: !showTop30 },
    { label: '탐구2 전체 30%', data: items.map(it => it['cutoff_tam2' + suffix]), borderColor: 'rgba(241, 196, 15, 0.4)', backgroundColor: 'rgba(241, 196, 15, 0.4)', borderWidth: 2, borderDash: [6, 6], pointRadius: 4, pointStyle: 'rect', tension: 0.3, fill: false, hidden: !showTop30 },
    { label: '영어 전체 30%', data: items.map(it => currentMode === 'pct' ? null : it.cutoff_eng_raw), borderColor: 'rgba(155, 89, 182, 0.4)', backgroundColor: 'rgba(155, 89, 182, 0.4)', borderWidth: 2, borderDash: [6, 6], pointRadius: 4, pointStyle: 'rect', tension: 0.3, fill: false, hidden: !showTop30 },

    // ✅ [추가 3] 선택과목(언매/미적 등) 상위 30% 컷오프 데이터셋
    { label: korLabel + ' 30%', data: items.map(it => it['choice_cutoff_kor' + suffix]), borderColor: '#3498db', backgroundColor: 'rgba(52, 152, 219, 0.2)', borderWidth: 2, borderDash: [2, 4], pointRadius: 3, tension: 0.3, fill: false, hidden: !showChoiceTop30, isChoiceLine: true, subjIndex: 0 },
    { label: mathLabel + ' 30%', data: items.map(it => it['choice_cutoff_math' + suffix]), borderColor: '#e74c3c', backgroundColor: 'rgba(231, 76, 60, 0.2)', borderWidth: 2, borderDash: [2, 4], pointRadius: 3, tension: 0.3, fill: false, hidden: !showChoiceTop30, isChoiceLine: true, subjIndex: 1 }
  ];

  // --- [10+] 반별 상위 30% 컷오프 ---
  classList.forEach((className, cIdx) => {
    const style = classStyles[cIdx % classStyles.length];
    const isHidden = !activeClasses.has(className); 

    datasets.push({ label: `국어 ${className} 30%`, data: items.map(it => getClassVal(it, className, '국어')), borderColor: 'rgba(52, 152, 219, 0.8)', backgroundColor: 'rgba(52, 152, 219, 0.8)', borderWidth: 2, borderDash: style.borderDash, pointRadius: 5, pointStyle: style.pointStyle, tension: 0.3, fill: false, hidden: isHidden, classGroup: className, subjIndex: 0 });
    datasets.push({ label: `수학 ${className} 30%`, data: items.map(it => getClassVal(it, className, '수학')), borderColor: 'rgba(231, 76, 60, 0.8)', backgroundColor: 'rgba(231, 76, 60, 0.8)', borderWidth: 2, borderDash: style.borderDash, pointRadius: 5, pointStyle: style.pointStyle, tension: 0.3, fill: false, hidden: isHidden, classGroup: className, subjIndex: 1 });
    datasets.push({ label: `탐구1 ${className} 30%`, data: items.map(it => getClassVal(it, className, '탐구1')), borderColor: 'rgba(46, 204, 113, 0.8)', backgroundColor: 'rgba(46, 204, 113, 0.8)', borderWidth: 2, borderDash: style.borderDash, pointRadius: 5, pointStyle: style.pointStyle, tension: 0.3, fill: false, hidden: isHidden, classGroup: className, subjIndex: 2 });
    datasets.push({ label: `탐구2 ${className} 30%`, data: items.map(it => getClassVal(it, className, '탐구2')), borderColor: 'rgba(241, 196, 15, 0.8)', backgroundColor: 'rgba(241, 196, 15, 0.8)', borderWidth: 2, borderDash: style.borderDash, pointRadius: 5, pointStyle: style.pointStyle, tension: 0.3, fill: false, hidden: isHidden, classGroup: className, subjIndex: 3 });
    // 💡 [추가] 영어 반별 상위 30%
    datasets.push({ label: `영어 ${className} 30%`, data: items.map(it => currentMode === 'pct' ? null : getClassVal(it, className, '영어')), borderColor: 'rgba(155, 89, 182, 0.8)', backgroundColor: 'rgba(155, 89, 182, 0.8)', borderWidth: 2, borderDash: style.borderDash, pointRadius: 5, pointStyle: style.pointStyle, tension: 0.3, fill: false, hidden: isHidden, classGroup: className, subjIndex: 4 });
  });
  
  // 차트 생성
  window.adminChart = new Chart(ctx, {
    type: 'line',
    data: { labels: items.map(it => it.label), datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { min: 0, max: 100, ticks: { color: 'rgba(255,255,255,0.6)' }, grid: { color: 'rgba(255,255,255,0.1)' }, title: { display: true, text: currentMode === 'pct' ? '백분위' : '원점수', color: '#fff' } },
        y_eng: { display: currentMode === 'pct', position: 'right', min: 1, max: 9, reverse: true, grid: { drawOnChartArea: false }, ticks: { color: 'rgba(255,255,255,0.6)' } }
      },
      plugins: { 
        legend: { display: false },
        tooltip: { 
          callbacks: {
            label: function(context) { return context.dataset.label + ': ' + context.parsed.y; }
          }
        }
      } 
    }
  });

  // 동적 버튼(반별) 생성 및 이벤트 연동
  const container = document.getElementById("classButtonsContainer");
  if (container) {
    container.innerHTML = "";
    classList.forEach((className) => {
      const btn = document.createElement("button");
      btn.className = "btn btn-mini";
      const isOn = activeClasses.has(className);
      
      btn.style.boxSizing = "border-box";
      btn.style.minWidth = "110px"; 
      btn.style.textAlign = "center";
      
      btn.style.background = isOn ? "#27ae60" : "transparent";
      btn.style.color = isOn ? "white" : "rgba(255,255,255,0.5)";
      btn.style.border = isOn ? "1px solid #27ae60" : "1px solid rgba(255,255,255,0.3)";
      btn.style.padding = "4px 10px";
      btn.style.fontSize = "11px";
      btn.style.borderRadius = "6px";
      btn.style.cursor = "pointer";
      btn.style.fontWeight = "bold";
      btn.textContent = `${className} 30% ${isOn ? 'ON' : 'OFF'}`;

      btn.onclick = function() {
        if (activeClasses.has(className)) {
          activeClasses.delete(className); 
          this.style.background = "transparent";
          this.style.color = "rgba(255,255,255,0.5)";
          this.style.border = "1px solid rgba(255,255,255,0.3)";
          this.textContent = `${className} 30% OFF`;
        } else {
          activeClasses.add(className); 
          this.style.background = "#27ae60";
          this.style.color = "white";
          this.style.border = "1px solid #27ae60"; 
          this.textContent = `${className} 30% ON`;
        }

        if (!window.adminChart) return;
        
        window.adminChart.data.datasets.forEach((ds, dsIdx) => {
          if (ds.classGroup === className) {
            const isSubjVisible = window.adminChart.isDatasetVisible(ds.subjIndex);
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
        window.adminChart.hide(idx); 
        // 💡 [수정] 영어(idx:4)도 전체 상위 30% 선을 숨기도록 if(idx < 4) 조건 해제
        window.adminChart.hide(idx + 5); 
        window.adminChart.data.datasets.forEach((ds, dsIdx) => {
            if (ds.subjIndex === idx) window.adminChart.hide(dsIdx);
        });
        this.style.opacity = "0.3";
      } else {
        window.adminChart.show(idx);
        // 💡 [수정] 영어(idx:4)도 전체 상위 30% 선을 보여주도록 조건 해제
        if (showTop30) window.adminChart.show(idx + 5); 
        window.adminChart.data.datasets.forEach((ds, dsIdx) => {
            if (ds.subjIndex === idx && activeClasses.has(ds.classGroup)) window.adminChart.show(dsIdx);
        });
        this.style.opacity = "1";
      }
    };
  });

  // 전체 상위 30% 토글
  // 전체 상위 30% 토글
  const top30Btn = document.getElementById("btnToggleTop30");
  if (top30Btn) {
    top30Btn.style.boxSizing = "border-box";
    top30Btn.style.minWidth = "115px"; 
    top30Btn.style.textAlign = "center";
    
    top30Btn.style.background = showTop30 ? "#e67e22" : "transparent";
    top30Btn.style.color = showTop30 ? "white" : "rgba(255,255,255,0.5)";
    top30Btn.style.border = showTop30 ? "1px solid #e67e22" : "1px solid rgba(255,255,255,0.3)";
    top30Btn.textContent = showTop30 ? "전체 상위 30% ON" : "전체 상위 30% OFF";

    top30Btn.onclick = function() {
      showTop30 = !showTop30;
      this.style.background = showTop30 ? "#e67e22" : "transparent";
      this.style.color = showTop30 ? "white" : "rgba(255,255,255,0.5)";
      this.style.border = showTop30 ? "1px solid #e67e22" : "1px solid rgba(255,255,255,0.3)";
      this.textContent = showTop30 ? "전체 상위 30% ON" : "전체 상위 30% OFF";

      if (!window.adminChart) return;
      for (let i = 0; i <= 4; i++) {
        const isSubjVisible = window.adminChart.isDatasetVisible(i);
        if (showTop30 && isSubjVisible) window.adminChart.show(i + 5);
        else window.adminChart.hide(i + 5);
      }
      window.adminChart.update();
    };
  }

  // ✅ [추가] 선택 상위 30% 토글 버튼 로직
  const choiceTop30Btn = document.getElementById("btnToggleChoiceTop30");
  if (choiceTop30Btn) {
    choiceTop30Btn.style.boxSizing = "border-box";
    choiceTop30Btn.style.minWidth = "115px"; 
    choiceTop30Btn.style.textAlign = "center";
    
    choiceTop30Btn.style.background = showChoiceTop30 ? "#f39c12" : "transparent";
    choiceTop30Btn.style.color = showChoiceTop30 ? "white" : "rgba(255,255,255,0.5)";
    choiceTop30Btn.style.border = showChoiceTop30 ? "1px solid #f39c12" : "1px solid rgba(255,255,255,0.3)";
    choiceTop30Btn.textContent = showChoiceTop30 ? "선택 상위 30% ON" : "선택 상위 30% OFF";

    choiceTop30Btn.onclick = function() {
      showChoiceTop30 = !showChoiceTop30;
      this.style.background = showChoiceTop30 ? "#f39c12" : "transparent";
      this.style.color = showChoiceTop30 ? "white" : "rgba(255,255,255,0.5)";
      this.style.border = showChoiceTop30 ? "1px solid #f39c12" : "1px solid rgba(255,255,255,0.3)";
      this.textContent = showChoiceTop30 ? "선택 상위 30% ON" : "선택 상위 30% OFF";

      if (!window.adminChart) return;
      
      // isChoiceLine 속성을 가진 데이터셋을 찾아 켜고 끕니다.
      window.adminChart.data.datasets.forEach((ds, dsIdx) => {
        if (ds.isChoiceLine) {
          const isSubjVisible = window.adminChart.isDatasetVisible(ds.subjIndex); // 부모 과목(국어, 수학)이 켜져있는지 확인
          if (showChoiceTop30 && isSubjVisible) window.adminChart.show(dsIdx);
          else window.adminChart.hide(dsIdx);
        }
      });
      window.adminChart.update();
    };
  }
}
  /** ✅ 취약 영역 방사형 차트 (+ 행동영역 크로스 분석 토글 기능 추가) */
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

  // 🎯 세부 분석 카드 DOM 생성
  let detailCard = document.getElementById("vulnDetailCard");
  if (!detailCard) {
    detailCard = document.createElement("div");
    detailCard.id = "vulnDetailCard";
    detailCard.style.marginTop = "20px";
    detailCard.style.display = "none";
    canvasWrap.parentNode.insertBefore(detailCard, canvasWrap.nextSibling);
  }
  detailCard.style.display = "none";

  const subjects = Object.keys(unitsBySubject);
  let currentSubject = subjects[0];

  let isAccumulatedMode = false;
  let isBehaviorMode = false; // 💡 [추가] 행동영역 보기 모드 상태
  let accumulatedData = null;

  const drawChart = () => {
    detailCard.style.display = "none"; 

    const dataSource = isAccumulatedMode ? accumulatedData : unitsBySubject;
    const rawData = dataSource ? dataSource[currentSubject] : null;

    if (!rawData || rawData.length === 0) {
      if (window.vulnChart) window.vulnChart.destroy();
      return;
    }

    // 💡 [핵심] 모드에 따라 데이터를 다르게 뭉칩니다.
    let chartData = [];
    
    if (isBehaviorMode) {
        // 행동영역 모드: behDetails 안의 행동영역들을 끄집어내서 합침
        const behMap = {};
        rawData.forEach(unit => {
            if (unit.behDetails) { 
                Object.entries(unit.behDetails).forEach(([beh, stats]) => { 
                    if (!beh || beh === "기타" || beh === "-") return;
                    if (!behMap[beh]) behMap[beh] = { o: 0, n: 0, details: {} };
                    behMap[beh].o += stats.o;
                    behMap[beh].n += stats.n;
                    
                    // 행동영역 클릭 시 '어느 단원'인지 보여주기 위해 역으로 저장
                    behMap[beh].details[unit.area] = { o: stats.o, n: stats.n };
                });
            }
        });
        
        // 💡 [신규] 선생님이 제안하신 '평가원 표준 행동영역 순서' 함수
        const getBehOrder = (subj, behName) => {
            // 띄어쓰기 및 가운데점을 통일하여 인식률 100% 보장
            const name = String(behName).replace(/\s+/g, '').replace(/∙/g, '·'); 
            
            if (subj === "국어") {
                const arr = ["사실적이해", "추론적이해", "비판적이해", "창의적이해", "어휘", "어법"];
                const idx = arr.findIndex(o => name.includes(o));
                return idx !== -1 ? idx : 99;
            } 
            else if (subj === "수학") {
                const arr = ["계산", "이해", "문제해결", "추론"];
                const idx = arr.findIndex(o => name.includes(o));
                return idx !== -1 ? idx : 99;
            } 
            else if (subj === "영어") {
                const arr = ["어법", "어휘", "사실적이해", "적용", "종합적이해", "추론적이해"];
                const idx = arr.findIndex(o => name.includes(o));
                return idx !== -1 ? idx : 99;
            } 
            else {
                // 💡 사탐 & 과탐 통합 순서 (기가 막히게 정렬됩니다!)
                const arr = [
                    "개념·원리의이해", "이해", 
                    "문제파악및인식", "적용", 
                    "문제인식및가설설정", 
                    "탐구설계및수행", 
                    "자료분석및해석", 
                    "결론도출및평가", 
                    "가치판단및의사결정"
                ];
                const idx = arr.findIndex(o => name.includes(o));
                return idx !== -1 ? idx : 99;
            }
        };

        chartData = Object.keys(behMap).map(beh => ({
            area: beh,
            score: behMap[beh].n > 0 ? Math.round((behMap[beh].o / behMap[beh].n) * 100) : 0,
            o: behMap[beh].o,
            n: behMap[beh].n,
            details: behMap[beh].details,
            code: '99' 
        })).sort((a, b) => getBehOrder(currentSubject, a.area) - getBehOrder(currentSubject, b.area)); // 💡 지정된 순서대로 완벽 정렬!

    } else {
        // 단원별 모드 (기존)
        chartData = [...rawData].sort((a, b) => Number(a.code || 99) - Number(b.code || 99));
    }

    if (window.vulnChart) window.vulnChart.destroy();
    const ctx = canvas.getContext('2d');

    // 💡 색상 팔레트 지정 (모드에 따라 변환)
    const behaviorPalette = ['#9b59b6', '#e67e22', '#1abc9c', '#e74c3c', '#3498db', '#f1c40f', '#34495e'];
    const pointColors = chartData.map((d, i) => {
      if (isBehaviorMode) return behaviorPalette[i % behaviorPalette.length];
      
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
        labels: chartData.map(d => d.area),
        datasets: [{
          label: `${currentSubject} 성취도(%)`,
          data: chartData.map(d => d.score),
          backgroundColor: isAccumulatedMode ? 'rgba(231, 76, 60, 0.15)' : (isBehaviorMode ? 'rgba(155, 89, 182, 0.15)' : 'rgba(52, 152, 219, 0.15)'), 
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
          const item = chartData[idx]; 

          const renderDetailCard = (targetItem, targetIdx) => {
            if (!targetItem || !targetItem.details || Object.keys(targetItem.details).length === 0) {
              detailCard.innerHTML = `<div style="padding:12px; text-align:center; opacity:0.7; font-size:13px; background: rgba(255,255,255,0.04); border-radius:10px;">세부 분석 데이터가 없습니다.</div>`;
              detailCard.style.display = "block";
              return;
            }

            let html = `<div style="background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">`;
            
            // 💡 [수정] 모드에 따라 제목 아이콘과 텍스트 변경
            const icon = isBehaviorMode ? "🧠" : "🔍";
            const suffix = isBehaviorMode ? "단원별 득점 비중" : "세부 영역 분석";
            html += `<div style="font-size: 15px; font-weight: 800; margin-bottom: 12px; color: ${pointColors[targetIdx]}; border-bottom: 1px dashed rgba(255,255,255,0.1); padding-bottom: 8px;">`;
            html += `${icon} [${escapeHtml(targetItem.area)}] ${suffix}</div>`;

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

            setTimeout(() => { detailCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);
          };

          const zeroItems = [];
          chartData.forEach((d, i) => {
            if (d.score === 0 || d.score === 0.0) zeroItems.push({ item: d, index: i });
          });

          if (item.score === 0 && zeroItems.length > 1) {
            let html = `<div style="background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">`;
            html += `<div style="font-size: 14px; font-weight: 800; margin-bottom: 12px; color: #fff; border-bottom: 1px dashed rgba(255,255,255,0.1); padding-bottom: 8px;">`;
            html += `🎯 여러 영역의 성취도가 0%로 겹쳐있습니다.<br>상세 분석을 확인할 영역을 선택하세요.</div>`;
            html += `<div style="display: flex; flex-wrap: wrap; gap: 8px;">`;

            zeroItems.forEach(z => {
              const btnColor = pointColors[z.index] || '#3498db';
              html += `<button class="zero-select-btn" data-idx="${z.index}" style="padding: 6px 12px; background: transparent; border: 1px solid ${btnColor}; border-radius: 6px; color: ${btnColor}; font-weight:bold; cursor: pointer; transition: background 0.2s;">
                ${escapeHtml(z.item.area)}
              </button>`;
            });

            html += `</div></div>`;
            detailCard.innerHTML = html;
            detailCard.style.display = "block";

            const btns = detailCard.querySelectorAll('.zero-select-btn');
            btns.forEach(btn => {
              btn.addEventListener('click', function() {
                const selectedIdx = parseInt(this.getAttribute('data-idx'));
                renderDetailCard(chartData[selectedIdx], selectedIdx); 
              });
              btn.addEventListener('mouseover', function() { this.style.background = 'rgba(255,255,255,0.1)'; });
              btn.addEventListener('mouseout', function() { this.style.background = 'transparent'; });
            });

            setTimeout(() => { detailCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);
            return; 
          }

          renderDetailCard(item, idx);
        }
      },
      plugins: { 
        legend: { display: false },
        tooltip: { 
          callbacks: {
            label: function(context) {
              const item = chartData[context.dataIndex];
              if (item && item.n !== undefined) {
                return ` 성취도: ${item.score}% (${item.o}맞음 / ${item.n}문항) - 클릭하여 상세분석`;
              }
              return ` 성취도: ${item.score}%`;
            }
          }
        }
      }
    });
  };

  // 💡 [전체 (누적)] 토글 버튼
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

  // 💡 [행동영역 보기] 토글 버튼 (새로 추가됨)
  const behaviorBtn = document.createElement("button");
  behaviorBtn.className = "btn btn-mini";
  behaviorBtn.innerHTML = "🔄 행동영역 보기";
  behaviorBtn.style.background = "rgba(255,255,255,0.1)";
  behaviorBtn.style.color = "#fff";
  behaviorBtn.style.border = "1px solid rgba(255,255,255,0.3)";
  behaviorBtn.style.padding = "6px 14px";
  behaviorBtn.style.borderRadius = "8px";
  behaviorBtn.style.cursor = "pointer";
  behaviorBtn.style.fontWeight = "bold";
  behaviorBtn.style.marginRight = "auto"; // 버튼들을 양쪽으로 밀어내기 위함
  
  behaviorBtn.onclick = () => {
    isBehaviorMode = !isBehaviorMode;
    behaviorBtn.innerHTML = isBehaviorMode ? "🔄 단원별 보기" : "🔄 행동영역 보기";
    behaviorBtn.style.background = isBehaviorMode ? "#9b59b6" : "rgba(255,255,255,0.1)";
    behaviorBtn.style.borderColor = isBehaviorMode ? "#9b59b6" : "rgba(255,255,255,0.3)";
    drawChart();
  };
  btnContainer.appendChild(behaviorBtn);

  // 과목 탭 버튼들 생성
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
  // 💡 [최종] 우리 반 전체 현황(대시보드 홈) - 정렬 스위치 추가본
  // =========================================================================
  window.__dashboardItems = [];
  window.__dashboardSortMode = 'name'; // 초기 정렬 상태: 'name' (이름순) 또는 'seat' (자리순)

  // ✅ 정렬 스위치 작동 함수 (버튼 누를 때 실행됨)
  window.toggleDashboardSort = function() {
      window.__dashboardSortMode = window.__dashboardSortMode === 'name' ? 'seat' : 'name';
      window.renderDashboardGrid(); // 데이터를 새로 안 불러오고 화면만 즉시 다시 그립니다!
  };

  // ✅ 화면 그리기 전용 함수 (서버 요청 없이 주머니에서 꺼내 그림)
  window.renderDashboardGrid = function() {
      const dashDiv = document.getElementById("classDashboard");
      if (!dashDiv) return;

      const sess = getAdminSession();
      const items = window.__dashboardItems; // 주머니에서 데이터 꺼내기

      if (!items || items.length === 0) {
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
      
      // 💡 현재 정렬 모드에 따라 버튼 텍스트를 다르게 보여줍니다.
      const sortBtnText = window.__dashboardSortMode === 'name' ? '🔤 이름순' : '🔢 자리번호순';

      let gridHtml = `
             <div id="riskNoticePanel" style="margin-bottom: 24px; display: none; animation: fadeIn 0.6s ease-out;"></div>
             <div id="dashHeader" style="font-size:16px; font-weight:800; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; cursor:pointer; padding: 10px 14px; background: rgba(255,255,255,0.05); border-radius: 10px; border: 1px solid rgba(255,255,255,0.08); transition: all 0.2s ease;">
               <span>${titleText} <span style="font-size:13px; color:rgba(255,255,255,0.6); font-weight:normal; margin-left:6px;">(총 ${items.length}명)</span></span>
               <div style="display:flex; align-items:center; gap:10px;">
                 <button onclick="event.stopPropagation(); window.toggleDashboardSort();" style="background:rgba(52, 152, 219, 0.2); color:#3498db; border:1px solid rgba(52, 152, 219, 0.5); padding:4px 10px; border-radius:6px; font-size:12px; font-weight:bold; cursor:pointer; transition:all 0.2s;">${sortBtnText}</button>
                 <span id="dashToggleIcon" style="font-size:13px; opacity:0.8; background: rgba(255,255,255,0.1); padding: 4px 8px; border-radius: 6px;">🔼 접기</span>
               </div>
             </div>
             <div id="dashContent" style="display:block; animation: fadeIn 0.3s ease;">
      `;

      teacherNames.forEach(tName => {
          const groupItems = grouped[tName];
          
          // 💡 [핵심] 선택된 모드에 따라 학생 배열을 미리 정렬합니다!
          groupItems.sort((a, b) => {
              if (window.__dashboardSortMode === 'seat') {
                  const sA = a.seat || "zzzz"; // 자리가 없으면 맨 뒤로 보냄
                  const sB = b.seat || "zzzz";
                  // 자리번호(4-1G04 등) 내의 숫자까지 똑똑하게 비교
                  return sA.localeCompare(sB, undefined, {numeric: true, sensitivity: 'base'});
              } else {
                  return a.name.localeCompare(b.name);
              }
          });

          gridHtml += `
            <div style="margin-top: 16px; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; align-items: baseline;">
              <span style="font-size:15px; font-weight:800; color:#3498db;">🧑‍🏫 ${escapeHtml(tName)} 선생님</span>
              <span style="font-size:12px; opacity:0.6; margin-left:8px;">${groupItems.length}명</span>
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px;">
          `;

          groupItems.forEach(st => {
              const bStyle = "font-size:9px; font-weight:900; padding:2px 6px; border-radius:6px; box-shadow: 0 2px 4px rgba(0,0,0,0.2); white-space:nowrap; display:inline-flex; align-items:center;";
              const isSunday = new Date().getDay() === 0;
              const abs = Number(st.todayAbs || 0);
              let badgeAtt = "";
              if (!isSunday) {
                  if (abs >= 6) badgeAtt = `<span style="${bStyle} background:#ff4757; color:white;">📅 위험 ${abs}</span>`;
                  else if (abs >= 3) badgeAtt = `<span style="${bStyle} background:#ffa502; color:white;">📅 경고 ${abs}</span>`;
              }
              const sleep = Number(st.sleepToday || 0);
              let badgeSleep = "";
              if (sleep >= 6) badgeSleep = `<span style="${bStyle} background:#eb4d4b; color:white;">💤 위험 ${sleep}</span>`;
              else if (sleep >= 3) badgeSleep = `<span style="${bStyle} background:#f9ca24; color:#111;">💤 경고 ${sleep}</span>`;

              const edu = Number(st.monthTotal || 0);
              let badgeEdu = "";
              if (edu >= 15) badgeEdu = `<span style="${bStyle} background:#6c5ce7; color:white;">💯 위험 ${edu}</span>`;
              else if (edu >= 10) badgeEdu = `<span style="${bStyle} background:#a29bfe; color:white;">💯 경고 ${edu}</span>`;

              const late = Number(st.todayLate || 0);
              let badgeLate = "";
              if (late > 0) {
                  badgeLate = `<span style="${bStyle} background:#e67e22; color:white;">⏰ 지각 ${late}</span>`;
              }

              const cs = String(st.currentStatus);
              const reason = String(st.currentReason || "").trim(); 
              let lampColor = "rgba(255,255,255,0.15)";
              if (cs === "1") lampColor = "#2ecc71"; 
              else if (cs === "3S") lampColor = reason === "화장실/정수기" ? "#2ecc71" : "#f39c12";
              else if (cs === "3") lampColor = "#ff4757"; 
              else if (cs === "2") lampColor = "#f1c40f"; 

              const lampHtml = `<div style="width:10px; height:10px; border-radius:50%; background:${lampColor}; display:inline-block; margin-right:8px; box-shadow: 0 0 6px ${lampColor}; flex-shrink:0;"></div>`;

              let reasonBadge = "";
              if (cs !== "1" && reason !== "화장실/정수기") {
                  let bg = lampColor;
                  let textColor = bg === "#f1c40f" ? "#000" : "#fff"; 
                  let shortReason = reason;
                  if (!shortReason) {
                      if (cs === "3S") shortReason = "이동중";
                      else if (cs === "2") shortReason = "지각";
                      else if (cs === "3") shortReason = "결석";
                      else shortReason = "기타";
                  } else {
                      shortReason = shortReason.replace(/\[설문\]/g, "").trim();
                      shortReason = shortReason.split('(')[0].trim();
                      if (shortReason.length > 6) shortReason = shortReason.substring(0, 6) + "..";
                  }
                  let icon = "🏃";
                  if (cs === "2") icon = "⏰";
                  else if (cs === "3") icon = "❌";
                  reasonBadge = `<span style="${bStyle} background:${bg}; color:${textColor}; border:1px solid rgba(255,255,255,0.2);" title="${escapeHtml(reason)}">${icon} ${escapeHtml(shortReason)}</span>`;
              }

              gridHtml += `
                <div class="class-dash-card" style="position:relative; background: rgba(255,255,255,0.04); border-radius: 12px; padding: 14px 12px; cursor: pointer; display:flex; flex-direction:column; gap:8px; transition: all 0.2s ease;"
                     onclick="document.getElementById('qInput').value='${st.studentId}'; document.getElementById('searchBtn').click();">
                  <div style="position:absolute; top:-10px; left:8px; display:flex; gap:4px; z-index:12;">
                      ${reasonBadge} ${badgeLate} ${badgeAtt} ${badgeSleep} ${badgeEdu}
                  </div>
                  <div style="display:flex; align-items:center; justify-content:space-between; margin-top:4px;">
                    <div style="font-weight:800; font-size:14px; display:flex; align-items:center; white-space:nowrap;">
                      ${lampHtml} 
                      <span>${escapeHtml(st.name)}</span>
                    </div>
                    <div style="font-size:11px; opacity:0.5; white-space:nowrap;">${escapeHtml(st.seat)}</div>
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

      // 💡 이벤트 리스너 다시 연결 (아코디언 토글, 호버 등)
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

      // 집중관리대상 알림판 최신화 유지
      if (typeof window.updateRiskNoticePanel === 'function') {
          window.updateRiskNoticePanel();
      }
  };

  // ✅ 데이터를 한 번만 가져오는 메인 함수
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

          // 💡 서버에서 받은 데이터를 주머니(__dashboardItems)에 저장하고, 화면 그리기 함수 호출!
          window.__dashboardItems = res.items || [];
          window.renderDashboardGrid();

          // 💡 요약 데이터 백그라운드 로딩은 그대로 유지
          if (window.__dashboardItems.length > 0 && typeof prefetchAllSummaries === 'function') {
              prefetchAllSummaries(window.__dashboardItems);
          }

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
 * ✅ [기능 확장] 복귀 안 함(3회↑) 추가 및 스마트 알림판 안정화 버전
 * 💡 + 최근 지각 주의(2회 이상) 추가 및 취침(3회) 기준 변경 반영!
 */
window.updateRiskNoticePanel = function() {
  const panel = document.getElementById("riskNoticePanel");
  if (!panel) return;

  const store = loadLocalCache_();
  if (typeof __memSummaryCache !== 'undefined') {
    __memSummaryCache.forEach((pack, key) => { if (!store[key]) store[key] = pack; });
  }

  let smartDismissStr = localStorage.getItem("admin_smart_dismiss_v2") || "{}";
  let smartDismissMap = JSON.parse(smartDismissStr);
  const now = new Date();
  const todayStr = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, '0') + "-" + String(now.getDate()).padStart(2, '0');

  // 💡 1. risks 객체에 late(지각) 목록 추가
  const risks = { penalty: [], attendance: [], sleep: [], move: [], late: [] }; 
  const dismissedList = [];

  Object.keys(store).forEach(key => {
    const item = store[key].summary || store[key].data; 
    if (!item || !item.student || !item.student.name || item.student.name === "알 수 없음") return;
    
    const id = item.student.studentId;
    const name = item.student.name;
    const record = smartDismissMap[id];

    // 💡 2. 각 수치 추출 (curL = 최근 7일 지각 횟수 추출)
    const curP = item.eduscore?.ok ? (item.eduscore.monthTotal || 0) : 0;
    const curA = item.attendance?.ok ? (item.attendance.absent || 0) : 0;
    const curL = item.attendance?.ok ? (item.attendance.weekLate || 0) : 0; // ⏰ 지각
    const curS = item.sleep?.ok ? (item.sleep.sleepTotal7d || 0) : 0;
    const curM = item.move?.ok ? (item.move.noReturn7d || 0) : 0;

    // 💡 3. 스마트 체크용 최대 수치 계산 (지각 2회 이상, 취침 3회 이상 반영)
    const maxCurVal = Math.max(
      curP >= 10 ? curP : 0, 
      curA >= 3 ? curA : 0, 
      curL >= 2 ? curL : 0, // ⏰ 지각 기준 2회
      curS >= 3 ? curS : 0, // 💤 취침 기준 3회
      curM >= 3 ? curM : 0 
    );

    if (maxCurVal > 0) {
      let shouldShow = false;
      if (!record) {
        shouldShow = true;
      } else {
        // 유효기간 만료 혹은 수치 증가 시 다시 노출
        if (todayStr > record.expireDate || maxCurVal > record.maxVal) shouldShow = true; 
        else dismissedList.push({ id, name, val: maxCurVal, expire: record.expireDate });
      }

      if (shouldShow) {
        if (curP >= 10) risks.penalty.push({ name, val: curP, id, maxCurVal });
        if (curA >= 3) risks.attendance.push({ name, val: curA, id, maxCurVal });
        if (curL >= 2) risks.late.push({ name, val: curL, id, maxCurVal }); // ⏰ 지각 명단 추가
        if (curS >= 3) risks.sleep.push({ name, val: curS, id, maxCurVal });
        if (curM >= 3) risks.move.push({ name, val: curM, id, maxCurVal }); 
      }
    }
  });

  // 💡 4. risks.late.length 검사 조건 추가
  if (risks.penalty.length === 0 && risks.attendance.length === 0 && risks.late.length === 0 && risks.sleep.length === 0 && risks.move.length === 0 && dismissedList.length === 0) {
    panel.style.display = "none";
    return;
  }

  let html = `<div style="background: rgba(231, 76, 60, 0.08); border: 1px solid rgba(231, 76, 60, 0.2); border-radius: 14px; padding: 18px; box-shadow: 0 4px 15px rgba(0,0,0,0.15);">
                <div style="font-weight: 900; color: #ff6b6b; margin-bottom: 12px; font-size: 15px; display:flex; align-items:center; justify-content:space-between;">
                  <div style="display:flex; align-items:center; gap:8px;"><span style="font-size:18px;">🚨</span> 오늘의 집중 관리 대상</div>
                  <div style="font-size:11px; opacity:0.6; color:#fff;">새로운 기록이 추가되면 다시 나타납니다.</div>
                </div>
                <div style="display: flex; gap: 12px; flex-wrap: wrap;">`;

  const createTag = (color, label, list) => {
    if (list.length === 0) return "";
    return `<div style="background: rgba(0,0,0,0.25); padding: 8px 12px; border-radius: 10px; border-left: 4px solid ${color}; flex-grow:1; min-width:200px;">
              <b style="color:${color}; font-size:12px;">${label}</b><br>
              <div style="margin-top:6px; font-size:13px; line-height:2.2;">
                ${list.map(s => `
                  <span style="display:inline-flex; align-items:center; margin-right:8px; background:rgba(255,255,255,0.06); padding:2px 8px; border-radius:6px;">
                    <span style="cursor:pointer; text-decoration:underline;" onclick="document.getElementById('qInput').value='${s.id}'; document.getElementById('searchBtn').click();">${escapeHtml(s.name)}(${s.val})</span>
                    <button onclick="smartDismissStudent('${s.id}', ${s.maxCurVal})" style="background:none; border:none; cursor:pointer; margin-left:4px; font-size:13px;" title="7일간 숨기기">✅</button>
                  </span>
                `).join("")}
              </div>
            </div>`;
  };

  html += createTag("#ff4757", "🔴 누적 벌점 주의", risks.penalty);
  html += createTag("#ffa502", "📅 최근 결석 주의", risks.attendance);
  html += createTag("#e67e22", "⏰ 최근 지각 주의", risks.late); // 💡 주황색 지각 태그 렌더링 추가!
  html += createTag("#f1c40f", "💤 최근 취침 주의", risks.sleep);
  html += createTag("#9b59b6", "🚶‍♂️ 최근 복귀 안 함 주의", risks.move); 

  html += `</div>`;

  if (dismissedList.length > 0) {
    html += `<details style="margin-top: 15px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 10px;">
        <summary style="font-size: 12px; color: rgba(255,255,255,0.5); cursor: pointer;">✔️ 확인 완료된 학생 보기 (${dismissedList.length}명)</summary>
        <div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">
          ${dismissedList.map(s => `<div style="font-size: 11px; background: rgba(255,255,255,0.03); padding: 4px 10px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.6); display: flex; align-items: center; gap: 6px;">
              <span>${escapeHtml(s.name)} (${s.val})</span>
              <button onclick="undoSmartDismiss('${s.id}')" style="background:none; border:none; cursor:pointer; color:#ff6b6b;">✕</button>
            </div>`).join("")}
        </div></details>`;
  }

  html += `</div>`;
  panel.innerHTML = html;
  panel.style.display = "block";
};

/**
 * ✅ [필수 추가] 스마트 숨기기 실행 함수
 */
window.smartDismissStudent = function(studentId, currentMaxVal) {
  let smartDismissStr = localStorage.getItem("admin_smart_dismiss_v2") || "{}";
  let smartDismissMap = JSON.parse(smartDismissStr);

  const now = new Date();
  const expireDate = new Date(now.setDate(now.getDate() + 7));
  const expireStr = expireDate.getFullYear() + "-" + String(expireDate.getMonth() + 1).padStart(2, '0') + "-" + String(expireDate.getDate()).padStart(2, '0');

  smartDismissMap[studentId] = { maxVal: currentMaxVal, expireDate: expireStr };
  localStorage.setItem("admin_smart_dismiss_v2", JSON.stringify(smartDismissMap));
  
  window.updateRiskNoticePanel();
};

/**
 * ✅ 확인 완료 취소 (다시 위험 목록으로 복구)
 */
window.undoSmartDismiss = function(studentId) {
  let smartDismissStr = localStorage.getItem("admin_smart_dismiss_v2") || "{}";
  let smartDismissMap = JSON.parse(smartDismissStr);

  delete smartDismissMap[studentId]; // 기록 삭제
  localStorage.setItem("admin_smart_dismiss_v2", JSON.stringify(smartDismissMap));
  
  window.updateRiskNoticePanel(); // 즉시 새로고침
};

}); // 💡 핵심: 반드시 }); 로 끝나야 합니다!
