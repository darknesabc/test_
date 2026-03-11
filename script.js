/***********************
 * Frontend (GitHub Pages)
 * - 로그인: name + parent4 -> Apps Script login -> sessionStorage 저장
 * - 대시보드: 세션 체크 + 출결 요약(attendance_summary) + 취침 요약(sleep_summary) + 이동 요약(move_summary)
 * - 이동 상세: move_detail (move.html)
 * - ✅ 교육점수 요약: eduscore_summary
 * - ✅ 교육점수 상세: eduscore_detail (eduscore.html)
 * - ✅ 공지: notice_list (dashboard에서 슬라이드 + 모달)
 * - ✅ 성적(표): grade_summary (dashboard)
 ***********************/

// ====== 설정 ======
const DEMO_MODE = false; // 실전
const SESSION_KEY = "parent_session_v1";

// ✅ Apps Script Web App URL
const API_BASE = "https://script.google.com/macros/s/AKfycbwxYd2tK4nWaBSZRyF0A3_oNES0soDEyWz0N0suAsuZU35QJOSypO2LFC-Z2dpbDyoD/exec";

// ====== 유틸 ======
function $(id) { return document.getElementById(id); }

function setSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
function getSession() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// ✅ 안전 유틸
function safeNum_(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function safeText_(v, fallback = "-") {
  const s = String(v ?? "").trim();
  return s ? s : fallback;
}


/* =========================================================
   ✅ 선택과목 축약 표시(학부모용 성적 표)
   - 예: "언어와 매체" / "언어와매체" / "언매" -> "언매"
========================================================= */
const __CHOICE_ABBR_ALIASES = {
  "언매": ["언매", "언어와매체", "언어와 매체"],
  "화작": ["화작", "화법과작문", "화법과 작문"],
  "미적": ["미적", "미적분"],
  "확통": ["확통", "확률과통계", "확률과 통계"],
  "기하": ["기하"],
  "생윤": ["생윤", "생활과윤리", "생활과 윤리"],
  "윤사": ["윤사", "윤리와사상", "윤리와 사상"],
  "한지": ["한지", "한국지리", "한국 지리"],
  "세지": ["세지", "세계지리", "세계 지리"],
  "동사": ["동사", "동아시아사", "동아시아 사"],
  "세사": ["세사", "세계사", "세계 사"],
  "경제": ["경제"],
  "정법": ["정법", "정치와법", "정치와 법"],
  "사문": ["사문", "사회문화", "사회 문화"],

  // 과탐
  "물1": ["물1", "물I", "물Ⅰ", "물리학1", "물리학I", "물리학Ⅰ", "물리학 1", "물리학 I", "물리학 Ⅰ"],
  "물2": ["물2", "물II", "물Ⅱ", "물리학2", "물리학II", "물리학Ⅱ", "물리학 2", "물리학 II", "물리학 Ⅱ"],

  "화1": ["화1", "화I", "화Ⅰ", "화학1", "화학I", "화학Ⅰ", "화학 1", "화학 I", "화학 Ⅰ"],
  "화2": ["화2", "화II", "화Ⅱ", "화학2", "화학II", "화학Ⅱ", "화학 2", "화학 II", "화학 Ⅱ"],

  "생1": ["생1", "생I", "생Ⅰ", "생명과학1", "생명과학I", "생명과학Ⅰ", "생명과학 1", "생명과학 I", "생명과학 Ⅰ"],
  "생2": ["생2", "생II", "생Ⅱ", "생명과학2", "생명과학II", "생명과학Ⅱ", "생명과학 2", "생명과학 II", "생명과학 Ⅱ"],

  "지1": ["지1", "지I", "지Ⅰ", "지구과학1", "지구과학I", "지구과학Ⅰ", "지구과학 1", "지구과학 I", "지구과학 Ⅰ"],
  "지2": ["지2", "지II", "지Ⅱ", "지구과학2", "지구과학II", "지구과학Ⅱ", "지구과학 2", "지구과학 II", "지구과학 Ⅱ"],
};

const __CHOICE_ABBR_LOOKUP = (() => {
  const map = new Map();
  const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, "").replace(/[·ㆍ]/g, "");
  for (const [abbr, aliases] of Object.entries(__CHOICE_ABBR_ALIASES)) {
    for (const a of aliases) map.set(norm(a), abbr);
  }
  return { map, norm };
})();

function shortenChoiceName_(name) {
  const raw = String(name ?? "").trim();
  if (!raw || raw === "-") return "-";
  const key = __CHOICE_ABBR_LOOKUP.norm(raw);
  return __CHOICE_ABBR_LOOKUP.map.get(key) || raw;
}

/* =========================================================
   ✅ 공지 상태 (TDZ 방지: var로 최상단 선선언)
========================================================= */
var __noticeItems = [];
var __noticeIndex = 0;

var __noticeTimer = null;
var __NOTICE_AUTOPLAY_MS = 6000;

var __noticeBound = false;
var __noticeGlobalBound = false;
var __noticeModalOpen = false;

var __noticeSuppressClickUntil = 0;
var __noticeModalSwipeBound = false;

/* =========================================================
   ✅ (중요) select UI 깨짐 방지
   - 기존 HTML에서 select에 btn 클래스를 줬을 때(깨짐) 자동으로 교정
   - styles.css의 .select-ghost를 실제로 적용
========================================================= */
function fixSelectUi_() {
  const sel = $("gradeExamSelect");
  if (!sel) return;

  // ✅ btn류 클래스가 select에 붙어있으면 제거(브라우저 드롭다운 UI랑 충돌 방지)
  // 대신 .select-ghost를 붙여서 안정적으로 표시
  sel.classList.add("select-ghost");

  // 혹시 HTML에서 btn 클래스가 붙어있다면 제거
  sel.classList.remove("btn");
  sel.classList.remove("btn-ghost");
  sel.classList.remove("btn-mini");

  // ✅ inline style padding이 있으면 select-ghost와 충돌할 수 있어서 제거 권장
  // (원하면 주석 처리 가능)
  sel.style.padding = "";
}

/* =========================================================
   ====== (데모) 로그인 ======
========================================================= */
async function demoLogin(name, parent4) {
  if (!name || name.trim().length < 1) throw new Error("이름을 입력하세요.");
  if (!/^\d{4,10}$/.test(parent4)) throw new Error("비밀번호는 숫자 4~10자리로 입력하세요.");

  return {
    ok: true,
    studentName: name.trim(),
    seat: "DEMO-SEAT",
    teacher: "DEMO",
    token: "demo-token",
    studentId: "DEMO-ID"
  };
}

// ====== (실전) Apps Script 로그인 ======
async function apiLogin(name, parent4) {
  const res = await fetch(`${API_BASE}?path=login`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ name, parent4 })
  });

  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "로그인 실패");

  return {
    studentName: data.studentName,
    seat: data.seat,
    teacher: data.teacher,
    token: data.token,
    studentId: data.studentId || ""
  };
}

/* =========================================================
   로그인 페이지 로직 (index.html)
========================================================= */
(function initLoginPage(){
  const form = $("loginForm");
  if (!form) return;

  const msg = $("msg");

  if (getSession()) {
    location.href = "dashboard.html";
    return;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (msg) msg.textContent = "";

    const name = $("studentName")?.value ?? "";
    const parent4 = $("last4")?.value ?? "";

    try {
      const result = DEMO_MODE ? await demoLogin(name, parent4) : await apiLogin(name, parent4);

      setSession({
        studentName: result.studentName,
        seat: result.seat ?? null,
        teacher: result.teacher ?? null,
        token: result.token,
        studentId: result.studentId ?? "",
        createdAt: Date.now()
      });

      location.href = "dashboard.html";
    } catch (err) {
      if (msg) msg.textContent = err?.message ?? String(err);
      else alert(err?.message ?? String(err));
    }
  });
})();

/* =========================================================
   로그인 필요 페이지 가드
========================================================= */
(function guardAnyPrivatePage(){
  const needsLogin = document.body?.dataset?.needsLogin === "1";
  if (!needsLogin) return;

  if (!getSession()) location.href = "index.html";
})();

/* =========================================================
   대시보드 로직 (dashboard.html)
========================================================= */
(function initDashboard(){
  const logoutBtn = $("logoutBtn");
  if (!logoutBtn) return;

  const session = getSession();
  if (!session) {
    location.href = "index.html";
    return;
  }

  // ✅ select UI 깨짐 방지(대시보드 들어오자마자)
  fixSelectUi_();

  const userLine = $("userLine");
  const extra = [session.seat, session.teacher ? `${session.teacher} 담임` : null].filter(Boolean).join(" · ");
  if (userLine) userLine.textContent = extra ? `${session.studentName} (${extra})` : `${session.studentName} 학부모님`;

  logoutBtn.addEventListener("click", () => {
    clearSession();
    location.href = "index.html";
  });

// --- 비밀번호 변경 버튼 기능 추가 시작 ---
  const changePwBtn = $("changePwBtn");
  if (changePwBtn) {
    changePwBtn.addEventListener("click", async () => {
      const session = getSession();
      if (!session) return;

      const newPw = prompt("새로 사용할 비밀번호(숫자 4~10자리)를 입력해주세요.");
      if (!newPw) return; // 취소 누르면 중단

      if (!/^\d{4,10}$/.test(newPw)) {
        alert("비밀번호는 4~10자리의 숫자로 입력해야 합니다.");
        return;
      }

      try {
        changePwBtn.disabled = true;
        changePwBtn.textContent = "변경 중...";

        const res = await fetch(`${API_BASE}?path=change_password`, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ token: session.token, newPw: newPw })
        });

        const data = await res.json();
        if (data.ok) {
          alert("비밀번호가 성공적으로 변경되었습니다. 다음 로그인부터 적용됩니다.");
        } else {
          alert("변경 실패: " + data.error);
        }
      } catch (e) {
        alert("통신 오류가 발생했습니다.");
      } finally {
        changePwBtn.disabled = false;
        changePwBtn.textContent = "비밀번호 변경";
      }
    });
  }
  // --- 비밀번호 변경 버튼 기능 추가 끝 ---  

  // ✅ 요약들 로드
  loadAttendanceSummary(session);
  loadSleepSummary(session);
  loadMoveSummary(session);
  loadEduScoreSummary(session);

  // ✅ 성적(표)
  loadGradeSummary(session);

  // ✅ 공지
  loadNoticeList(session);
})();

/* =========================================================
   출결 요약 (대시보드 카드)
========================================================= */
function fmtMdDow_(md, dow) {
  const m = String(md ?? "").trim();
  const d = String(dow ?? "").trim();
  if (!m) return "";
  return d ? `${m}(${d})` : m;
}

async function loadAttendanceSummary(session) {
  const loading = $("attLoading");
  const error = $("attError");
  const box = $("attSummary");
  const counts = $("attCounts");
  const recent = $("attRecent");

  if (!loading || !error || !box || !counts || !recent) return;

  try {
    loading.textContent = "불러오는 중...";
    error.textContent = "";
    box.style.display = "none";

    const res = await fetch(`${API_BASE}?path=attendance_summary`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: session.token })
    });

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "출결 요약 불러오기 실패");

    loading.textContent = "";

    const present = Number(data.present ?? 0);
    const absent = Number(data.absent ?? 0);
    const rec = Array.isArray(data.recentAbsences) ? data.recentAbsences : [];

    counts.innerHTML = `이번 주 출결 요약<br>출석 ${present}회 · 결석 ${absent}회`;

    if (!rec.length) {
      recent.textContent = "최근 결석: 없음";
    } else {
      const items = rec.map(x => `${fmtMdDow_(x.md, x.dow)} ${x.period}교시`);
      recent.textContent = `최근 결석: ${items.join(", ")}`;
    }

    box.style.display = "";
  } catch (e) {
    loading.textContent = "";
    error.textContent = e?.message ?? String(e);
  }
}

/* =========================================================
   ✅ 취침 요약 (대시보드 카드)
========================================================= */
async function loadSleepSummary(session) {
  const loading = $("sleepLoading");
  const error = $("sleepError");
  const box = $("sleepSummary");
  const line = $("sleepLine");

  if (!loading || !error || !box || !line) return;

  try {
    loading.textContent = "불러오는 중...";
    error.textContent = "";
    box.style.display = "none";

    const res = await fetch(`${API_BASE}?path=sleep_summary`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: session.token })
    });

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "취침 요약 불러오기 실패");

    const total = (data.sleepTotal7d !== undefined && data.sleepTotal7d !== null)
      ? Number(data.sleepTotal7d ?? 0)
      : Number(data.sleepCount7d ?? 0);

    loading.textContent = "";
    line.textContent = `최근 7일 취침 ${total}회`;
    box.style.display = "";
  } catch (e) {
    loading.textContent = "";
    error.textContent = e?.message ?? String(e);
  }
}

/* =========================================================
   ✅ 이동 요약 (대시보드 카드)
========================================================= */
async function loadMoveSummary(session) {
  const loading = $("moveLoading");
  const error = $("moveError");
  const box = $("moveSummary");
  const line = $("moveLine");
  const recent = $("moveRecent");

  if (!loading || !error || !box || !line || !recent) return;

  try {
    loading.textContent = "불러오는 중...";
    error.textContent = "";
    box.style.display = "none";

    const res = await fetch(`${API_BASE}?path=move_summary`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: session.token })
    });

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "이동 요약 불러오기 실패");

    loading.textContent = "";

    function prettyMD_(iso) {
      iso = String(iso || "").trim();
      if (!iso) return "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso.slice(5).replace("-", "/");
      return iso;
    }

    const md = prettyMD_(data.latestDate);
    const time = String(data.latestTime || "").trim();
    const reasonLine = String(data.latestText || "-").trim();

// 💡 [추가] 요약(Dashboard)에서도 화장실 기록은 노출하지 않으려면
if (reasonLine.includes("화장실/정수기")) {
  recent.textContent = "상세 페이지에서 확인 가능"; 
} else {
  recent.textContent = (md && time) ? `${md} ${time} · ${reasonLine}` : "-";
}

    box.style.display = "";
  } catch (e) {
    loading.textContent = "";
    error.textContent = e?.message ?? String(e);
  }
}

/* =========================================================
   ✅ 교육점수 요약 (대시보드 카드)
========================================================= */
async function loadEduScoreSummary(session) {
  const loading = $("eduScoreLoading");
  const error   = $("eduScoreError");
  const box     = $("eduScoreSummary");
  const line    = $("eduScoreLine");
  const recent  = $("eduScoreRecent");

  if (!loading || !error || !box || !line || !recent) return;

  try {
    loading.textContent = "불러오는 중...";
    error.textContent = "";
    box.style.display = "none";

    const res = await fetch(`${API_BASE}?path=eduscore_summary`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: session.token })
    });

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "교육점수 요약 불러오기 실패");

    loading.textContent = "";

    const total = Number(data.monthTotal ?? 0);
    line.textContent = `이번 달 교육점수 ${total}점`;

    function prettyMD_(iso) {
      iso = String(iso || "").trim();
      if (!iso) return "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso.slice(5).replace("-", "/");
      return iso;
    }

    const md = prettyMD_(data.latestDate);
    const time = String(data.latestTime || "").trim();
    const latestText = String(data.latestText || "").trim();

    if (md && time && latestText && latestText !== "-") {
      const m = latestText.match(/\((\d+)\s*점\)/);
      const score = m ? m[1] : "";
      recent.textContent = score
        ? `최근 교육점수: ${md} ${time} · ${latestText.replace(/\(\d+\s*점\)/, "").trim()} (${score}점)`
        : `최근 교육점수: ${md} ${time} · ${latestText}`;
    } else {
      recent.textContent = "최근 교육점수: 없음";
    }

    box.style.display = "";
  } catch (e) {
    loading.textContent = "";
    error.textContent = e?.message ?? String(e);
  }
}

/* =========================================================
   ✅ 성적(대시보드 표)
========================================================= */
async function loadGradeSummary(session) {
  const sel     = $("gradeExamSelect");
  const loading = $("gradeLoading");
  const error   = $("gradeError");
  const wrap    = $("gradeTableWrap");
  const tbody   = $("gradeTbody");

  if (!sel || !loading || !error || !wrap || !tbody) return;

  // ✅ 혹시 대시보드 렌더 전에 클래스가 다시 붙었을 수 있어서 한번 더 보정
  fixSelectUi_();

  sel.addEventListener("change", () => fetchAndRender());
  fetchAndRender();

  async function fetchAndRender() {
    try {
      loading.textContent = "불러오는 중...";
      error.textContent = "";
      wrap.style.display = "none";
      tbody.innerHTML = "";

      const exam = String(sel.value || "mar");
      const res = await fetch(`${API_BASE}?path=grade_summary`, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ token: session.token, exam })
      });

      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "성적 불러오기 실패");

      const rows = buildGradeTableRows_(data);

      tbody.innerHTML = rows.map(r => `
        <tr>
          <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${escapeHtml_(r.label)}</td>
          <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${escapeHtml_(r.kor)}</td>
          <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${escapeHtml_(r.math)}</td>
          <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${escapeHtml_(r.eng)}</td>
          <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${escapeHtml_(r.hist)}</td>
          <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${escapeHtml_(r.tam1)}</td>
          <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">${escapeHtml_(r.tam2)}</td>
        </tr>
      `).join("");

      loading.textContent = "";
      wrap.style.display = "";
    } catch (e) {
      loading.textContent = "";
      wrap.style.display = "none";
      error.textContent = e?.message ?? String(e);
    }
  }
}

/** 이미지처럼: 선택과목/원점수/표준점수/백분위/등급 */
function buildGradeTableRows_(data) {
  const kor  = data.kor  || {};
  const math = data.math || {};
  const eng  = data.eng  || {};
  const hist = data.hist || {};
  const tam1 = data.tam1 || {};
  const tam2 = data.tam2 || {};

  const dash = "-";
  const fmt = (v) => {
    const s = String(v ?? "").trim();
    return s ? s : dash;
  };
  const fmtNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && String(v).trim() !== "" ? String(n) : dash;
  };

  return [
    { label: "선택과목", kor: shortenChoiceName_(fmt(kor.choice)), math: shortenChoiceName_(fmt(math.choice)), eng: dash, hist: dash, tam1: shortenChoiceName_(fmt(tam1.name)), tam2: shortenChoiceName_(fmt(tam2.name)) },
    { label: "원점수",   kor: fmtNum(kor.raw_total), math: fmtNum(math.raw_total), eng: fmtNum(eng.raw), hist: fmtNum(hist.raw), tam1: fmtNum(tam1.raw), tam2: fmtNum(tam2.raw) },
    
    // ⭐️ 표준점수: 국어와 수학을 expected_std로 변경
    { label: "표준점수", kor: fmtNum(kor.expected_std), math: fmtNum(math.expected_std), eng: dash, hist: dash, tam1: fmtNum(tam1.expected_std), tam2: fmtNum(tam2.expected_std) },
    
    // ⭐️ 백분위: 국어와 수학을 expected_pct로 변경
    { label: "백분위",   kor: fmtNum(kor.expected_pct), math: fmtNum(math.expected_pct), eng: dash, hist: dash, tam1: fmtNum(tam1.expected_pct), tam2: fmtNum(tam2.expected_pct) },
    
    // ⭐️ 등급: 국어와 수학을 expected_grade로 변경
    { label: "등급",     kor: fmt(kor.expected_grade), math: fmt(math.expected_grade), eng: fmt(eng.grade), hist: fmt(hist.grade), tam1: fmt(tam1.expected_grade), tam2: fmt(tam2.expected_grade) },
  ];
}
/* =========================================================
   ✅ 공지 (dashboard 슬라이드 + 모달 + 스와이프 + 자동전환 + 모달 스와이프)
========================================================= */

async function loadNoticeList(session) {
  const loading = $("noticeLoading");
  const error   = $("noticeError");

  const sliderWrap = $("noticeSwipeArea") || $("noticeSlider");
  const slider  = $("noticeSlider");

  const titleEl = $("noticeTitle");
  const metaEl  = $("noticeMeta");
  const prevEl  = $("noticePreview");

  const btnOpen = $("noticeOpenBtn");
  const btnPrev = $("noticePrevBtn");
  const btnNext = $("noticeNextBtn");
  const dotsEl  = $("noticeDots");

  if (!loading || !error || !sliderWrap || !slider || !titleEl || !metaEl || !prevEl || !btnOpen || !btnPrev || !btnNext || !dotsEl) return;

  try {
    loading.textContent = "불러오는 중...";
    error.textContent = "";
    sliderWrap.style.display = "none";
    btnOpen.style.display = "none";

    stopNoticeAutoplay_();

    const res = await fetch(`${API_BASE}?path=notice_list`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: session.token })
    });

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "공지 불러오기 실패");

    const items = Array.isArray(data.items) ? data.items : [];
    __noticeItems = normalizeNoticeItems_(items);

    loading.textContent = "";

    if (!__noticeItems.length) {
      loading.textContent = "공지사항이 없습니다.";
      return;
    }

    __noticeIndex = 0;

    initNoticeInteractions_();
    renderNoticeCard_();

    sliderWrap.style.display = "";
    btnOpen.style.display = "";

    if (__noticeItems.length >= 2) startNoticeAutoplay_();
  } catch (e) {
    loading.textContent = "";
    error.textContent = e?.message ?? String(e);
  }
}

function initNoticeInteractions_() {
  if (__noticeBound) return;
  __noticeBound = true;

  const btnOpen = $("noticeOpenBtn");
  const btnPrev = $("noticePrevBtn");
  const btnNext = $("noticeNextBtn");

  const modal = $("noticeModal");
  const modalClose = $("noticeModalClose");

  const tapArea = $("noticeTapArea");

  if (btnPrev) btnPrev.onclick = () => { setNoticeIndex_(__noticeIndex - 1); restartNoticeAutoplay_(); };
  if (btnNext) btnNext.onclick = () => { setNoticeIndex_(__noticeIndex + 1); restartNoticeAutoplay_(); };
  if (btnOpen) btnOpen.onclick = () => { openNoticeModal_(__noticeItems[__noticeIndex]); };

  if (tapArea && btnOpen) {
    tapArea.addEventListener("click", () => {
      if (__noticeModalOpen) return;
      if (Date.now() < __noticeSuppressClickUntil) return;
      btnOpen.click();
    });

    tapArea.addEventListener("keydown", (e) => {
      if (__noticeModalOpen) return;
      if (Date.now() < __noticeSuppressClickUntil) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        btnOpen.click();
      }
    });
  }

  if (modalClose) modalClose.onclick = () => closeNoticeModal_();
  if (modal) {
    modal.onclick = (e) => {
      const t = e.target;
      if (t && t.dataset && t.dataset.close === "1") closeNoticeModal_();
    };
  }

  if (!__noticeGlobalBound) {
    __noticeGlobalBound = true;

    window.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeNoticeModal_();
    }, { passive: true });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopNoticeAutoplay_();
      else restartNoticeAutoplay_();
    });
  }

  const swipeTarget = $("noticeSwipeArea") || $("noticeCard") || $("noticeSlider");
  if (!swipeTarget) return;

  let startX = 0;
  let lastX = 0;
  let dragging = false;
  const thresholdRatio = 0.18;

  function onDown(x) {
    if (__noticeItems.length < 2) return;
    if (__noticeModalOpen) return;
    dragging = true;
    startX = x;
    lastX = x;
    stopNoticeAutoplay_();
  }
  function onMove(x) {
    if (!dragging) return;
    lastX = x;
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;

    const dx = lastX - startX;
    const w = swipeTarget.clientWidth || 1;
    const threshold = w * thresholdRatio;

    if (Math.abs(dx) > threshold) {
      __noticeSuppressClickUntil = Date.now() + 350;
    }

    if (dx > threshold) setNoticeIndex_(__noticeIndex - 1);
    else if (dx < -threshold) setNoticeIndex_(__noticeIndex + 1);

    restartNoticeAutoplay_();
  }

  swipeTarget.addEventListener("touchstart", (e) => onDown(e.touches[0].clientX), { passive: true });
  swipeTarget.addEventListener("touchmove",  (e) => onMove(e.touches[0].clientX),  { passive: true });
  swipeTarget.addEventListener("touchend",   ()  => onUp());

  swipeTarget.addEventListener("mousedown", (e) => { e.preventDefault(); onDown(e.clientX); });
  window.addEventListener("mousemove", (e) => onMove(e.clientX), { passive: true });
  window.addEventListener("mouseup",   ()  => onUp(), { passive: true });

  bindNoticeModalSwipe_();
}

function bindNoticeModalSwipe_() {
  if (__noticeModalSwipeBound) return;
  __noticeModalSwipeBound = true;

  const panel = document.querySelector("#noticeModal .modal-panel");
  if (!panel) return;

  let startX = 0, startY = 0;
  let lastX = 0, lastY = 0;
  let dragging = false;

  const thresholdRatio = 0.18;
  const vertCancelRatio = 1.2;

  function down(x, y) {
    if (__noticeItems.length < 2) return;
    if (!__noticeModalOpen) return;
    dragging = true;
    startX = lastX = x;
    startY = lastY = y;
  }
  function move(x, y) {
    if (!dragging) return;
    lastX = x;
    lastY = y;
  }
  function up() {
    if (!dragging) return;
    dragging = false;

    if (!__noticeModalOpen) return;

    const dx = lastX - startX;
    const dy = lastY - startY;

    if (Math.abs(dy) > Math.abs(dx) * vertCancelRatio) return;

    const w = panel.clientWidth || 1;
    const threshold = w * thresholdRatio;

    if (dx > threshold) {
      setNoticeIndex_(__noticeIndex - 1);
      openNoticeModal_(__noticeItems[__noticeIndex]);
    } else if (dx < -threshold) {
      setNoticeIndex_(__noticeIndex + 1);
      openNoticeModal_(__noticeItems[__noticeIndex]);
    }
  }

  panel.addEventListener("touchstart", (e) => {
    const t = e.touches && e.touches[0];
    if (!t) return;
    down(t.clientX, t.clientY);
  }, { passive: true });

  panel.addEventListener("touchmove", (e) => {
    const t = e.touches && e.touches[0];
    if (!t) return;
    move(t.clientX, t.clientY);
  }, { passive: true });

  panel.addEventListener("touchend", () => up());

  panel.addEventListener("mousedown", (e) => {
    if (!__noticeModalOpen) return;
    e.preventDefault();
    down(e.clientX, e.clientY);
  });

  window.addEventListener("mousemove", (e) => move(e.clientX, e.clientY), { passive: true });
  window.addEventListener("mouseup", () => up(), { passive: true });
}

function normalizeNoticeItems_(items) {
  const out = items.map((it, idx) => {
    const title = safeText_(it?.title, "공지");
    const bodyText = safeText_(it?.body ?? it?.content ?? it?.text, "");
    const bodyHtml = String(it?.body_html ?? it?.html ?? "").trim() || textToSafeHtml_(bodyText);

    const order = (it?.order !== undefined && it?.order !== null && it?.order !== "")
      ? Number(it.order)
      : null;

    const createdRaw = it?.createdAt ?? it?.at ?? it?.date ?? it?.created ?? "";
    const created = String(createdRaw ?? "").trim();

    const link = String(it?.link ?? it?.url ?? "").trim();
    const images = Array.isArray(it?.images) ? it.images.filter(Boolean).map(String) : [];

    const id = String(it?.id ?? it?.key ?? idx);

    return { id, title, bodyText, bodyHtml, order, created, link, images };
  });

  out.sort((a, b) => {
    const ao = (a.order === null || Number.isNaN(a.order)) ? null : a.order;
    const bo = (b.order === null || Number.isNaN(b.order)) ? null : b.order;

    if (ao !== null && bo !== null && ao !== bo) return ao - bo;
    if (ao !== null && bo === null) return -1;
    if (ao === null && bo !== null) return 1;

    const ak = noticeSortKey_(a.created);
    const bk = noticeSortKey_(b.created);
    if (ak !== bk) return bk.localeCompare(ak);

    return String(a.id).localeCompare(String(b.id));
  });

  return out;
}

function noticeSortKey_(created) {
  const s = String(created || "").trim();
  if (!s) return "0000-00-00 00:00";
  const m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})(?:\D+(\d{1,2})\D+(\d{1,2}))?/);
  if (m) {
    const y = m[1];
    const mo = String(Number(m[2])).padStart(2, "0");
    const d = String(Number(m[3])).padStart(2, "0");
    const hh = String(Number(m[4] || 0)).padStart(2, "0");
    const mm = String(Number(m[5] || 0)).padStart(2, "0");
    return `${y}-${mo}-${d} ${hh}:${mm}`;
  }
  return s;
}

function setNoticeIndex_(next) {
  if (!__noticeItems.length) return;
  const n = __noticeItems.length;
  __noticeIndex = (next % n + n) % n;
  renderNoticeCard_();
}

function renderNoticeCard_() {
  const it = __noticeItems[__noticeIndex];
  if (!it) return;

  const titleEl = $("noticeTitle");
  const metaEl  = $("noticeMeta");
  const prevEl  = $("noticePreview");
  const dotsEl  = $("noticeDots");

  if (!titleEl || !metaEl || !prevEl || !dotsEl) return;

  titleEl.textContent = it.title;

  const createdPretty = prettyNoticeDate_(it.created);
  const orderText = (it.order !== null && !Number.isNaN(it.order)) ? `노출순번 ${it.order}` : "";
  const idxText = `${__noticeIndex + 1}/${__noticeItems.length}`;

  metaEl.textContent = [createdPretty, orderText, idxText].filter(Boolean).join(" · ");

  const preview = makeNoticePreview_(it.bodyText, 180);
  prevEl.textContent = preview || "(내용 없음)";

  if (__noticeItems.length <= 8) {
    dotsEl.textContent = __noticeItems.map((_, i) => (i === __noticeIndex ? "●" : "○")).join(" ");
  } else {
    dotsEl.textContent = idxText;
  }
}

function prettyNoticeDate_(created) {
  const s = String(created || "").trim();
  if (!s) return "";
  const m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) {
    const mm = String(Number(m[2])).padStart(2, "0");
    const dd = String(Number(m[3])).padStart(2, "0");
    return `${mm}/${dd}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(5).replace("-", "/");
  return s;
}

function makeNoticePreview_(body, maxLen = 180) {
  const s = String(body ?? "").replace(/\r/g, "").trim();
  if (!s) return "";
  const normalized = s.replace(/[ \t]+/g, " ");
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, maxLen) + "…";
}

function textToSafeHtml_(text) {
  const raw = String(text ?? "").replace(/\r/g, "");
  const escaped = escapeHtml_(raw);
  return escaped.replace(/\n/g, "<br>");
}

// ✅ 자동전환 타이머
function startNoticeAutoplay_() {
  if (__noticeTimer) return;
  if (__noticeItems.length < 2) return;
  if (__noticeModalOpen) return;

  __noticeTimer = setInterval(() => {
    if (__noticeModalOpen) return;
    setNoticeIndex_(__noticeIndex + 1);
  }, __NOTICE_AUTOPLAY_MS);
}
function stopNoticeAutoplay_() {
  if (__noticeTimer) {
    clearInterval(__noticeTimer);
    __noticeTimer = null;
  }
}
function restartNoticeAutoplay_() {
  stopNoticeAutoplay_();
  startNoticeAutoplay_();
}

function openNoticeModal_(it) {
  const modal = $("noticeModal");
  const titleEl = $("noticeModalTitle");
  const metaEl  = $("noticeModalMeta");
  const bodyEl  = $("noticeModalBody");
  const linkWrap = $("noticeModalLinkWrap");
  const linkEl   = $("noticeModalLink");
  const imgWrap  = $("noticeModalImages");

  if (!modal || !titleEl || !metaEl || !bodyEl || !linkWrap || !linkEl || !imgWrap) return;

  __noticeModalOpen = true;
  stopNoticeAutoplay_();

  titleEl.textContent = it?.title || "공지";
  metaEl.textContent = [
    prettyNoticeDate_(it?.created),
    (it?.order !== null && it?.order !== undefined ? `노출순번 ${it.order}` : "")
  ].filter(Boolean).join(" · ");

  const html = String(it?.bodyHtml ?? "").trim() || textToSafeHtml_(String(it?.bodyText ?? "").trim());
  bodyEl.innerHTML = html;

  const link = String(it?.link ?? "").trim();
  if (link) {
    linkWrap.style.display = "";
    linkEl.textContent = link;
    linkEl.href = link;
  } else {
    linkWrap.style.display = "none";
    linkEl.textContent = "";
    linkEl.removeAttribute("href");
  }

  const images = Array.isArray(it?.images) ? it.images : [];
  imgWrap.innerHTML = "";

  if (images.length) {
    imgWrap.style.display = "";
    const frag = document.createDocumentFragment();
    images.forEach((url) => {
      const u = String(url || "").trim();
      if (!u) return;
      const img = document.createElement("img");
      img.src = u;
      img.alt = "공지 이미지";
      img.loading = "lazy";
      frag.appendChild(img);
    });
    imgWrap.appendChild(frag);
  } else {
    imgWrap.style.display = "none";
  }

  modal.style.display = "";
  document.body.style.overflow = "hidden";
}

function closeNoticeModal_() {
  const modal = $("noticeModal");
  if (!modal) return;
  modal.style.display = "none";
  document.body.style.overflow = "";
  __noticeModalOpen = false;
  restartNoticeAutoplay_();
}

/* =========================================================
   ✅ 이동 상세 페이지 (move.html)
========================================================= */
(async function initMoveDetailPage(){
  const userLine = $("moveUserLine");
  const daysSel  = $("moveDaysSelect");
  const loading  = $("moveDetailLoading");
  const error    = $("moveDetailError");
  const wrap     = $("moveDetailTableWrap");
  const tbody    = $("moveDetailTbody");

  if (!loading || !error || !wrap || !tbody || !daysSel) return;

  const session = getSession();
  if (!session) {
    location.href = "index.html";
    return;
  }

  if (userLine) {
    const extra = [session.seat, session.teacher ? `${session.teacher} 담임` : null]
      .filter(Boolean).join(" · ");
    userLine.textContent = extra ? `${session.studentName} (${extra})` : session.studentName;
  }

  daysSel.addEventListener("change", () => {
    const days = Number(daysSel.value || 7);
    fetchAndRender(days);
  });

  fetchAndRender(Number(daysSel.value || 7));

  async function fetchAndRender(days) {
    try {
      loading.textContent = "불러오는 중...";
      error.textContent = "";
      wrap.style.display = "none";
      tbody.innerHTML = "";

      const res = await fetch(`${API_BASE}?path=move_detail`, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ token: session.token, days })
      });

      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "이동 상세 불러오기 실패");

      const items = Array.isArray(data.items) ? data.items : [];
      loading.textContent = "";

      if (!items.length) {
        loading.textContent = "이동 기록이 없습니다.";
        return;
      }

      tbody.innerHTML = items.map(it => {
        const date = String(it.date || "").trim();
        const time = String(it.time || "").trim();
        const reason = escapeHtml_(it.reason || "-");
        const returnPeriod = escapeHtml_(it.returnPeriod || it.score || "-");

        let prettyDate = date || "-";
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          prettyDate = date.slice(5).replace("-", "/");
        }

        let prettyTime = time;
        if (!prettyTime) {
          const dt = String(it.dt || "").trim();
          const m = dt.match(/(\d{2}:\d{2})/);
          if (m) prettyTime = m[1];
        }
        if (!prettyTime) prettyTime = "-";

        return `
          <tr>
            <td style="padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">
              ${escapeHtml_(prettyDate)}
            </td>
            <td style="padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">
              ${escapeHtml_(prettyTime)}
            </td>
            <td style="padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); font-weight:700;">
              ${reason}
            </td>
            <td style="padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">
              ${returnPeriod}
            </td>
          </tr>
        `;
      }).join("");

      wrap.style.display = "";
    } catch (e) {
      loading.textContent = "";
      error.textContent = e?.message ?? String(e);
    }
  }
})();

/* =========================================================
   ✅ 교육점수 상세 페이지 (eduscore.html)
========================================================= */
(async function initEduScoreDetailPage(){
  const userLine = $("eduUserLine");
  const monthLine = $("eduMonthLine");
  const daysSel  = $("eduDaysSelect");

  const loading  = $("eduDetailLoading");
  const error    = $("eduDetailError");
  const empty    = $("eduDetailEmpty");

  const wrap     = $("eduDetailTableWrap");
  const tbody    = $("eduDetailTbody");

  if (!loading || !error || !wrap || !tbody || !daysSel) return;

  const session = getSession();
  if (!session) {
    location.href = "index.html";
    return;
  }

  if (userLine) {
    const extra = [session.seat, session.teacher ? `${session.teacher} 담임` : null]
      .filter(Boolean).join(" · ");
    userLine.textContent = extra ? `${session.studentName} (${extra})` : session.studentName;
  }

  try {
    if (monthLine) {
      monthLine.textContent = "이번 달 누적 불러오는 중...";
      const res = await fetch(`${API_BASE}?path=eduscore_summary`, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ token: session.token })
      });
      const data = await res.json();
      if (data.ok) {
        const total = Number(data.monthTotal ?? 0);
        monthLine.textContent = `이번 달 누적: ${total}점`;
      } else {
        monthLine.textContent = "";
      }
    }
  } catch {
    if (monthLine) monthLine.textContent = "";
  }

  daysSel.addEventListener("change", () => {
    const days = Number(daysSel.value || 30);
    fetchAndRender(days);
  });

  fetchAndRender(Number(daysSel.value || 30));

  async function fetchAndRender(days) {
    try {
      loading.textContent = "불러오는 중...";
      error.textContent = "";
      wrap.style.display = "none";
      tbody.innerHTML = "";
      if (empty) empty.style.display = "none";

      const res = await fetch(`${API_BASE}?path=eduscore_detail`, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ token: session.token, days })
      });

      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "교육점수 상세 불러오기 실패");

      const items = Array.isArray(data.items) ? data.items : [];
      loading.textContent = "";

      if (!items.length) {
        if (empty) empty.style.display = "";
        loading.textContent = "";
        return;
      }

      tbody.innerHTML = items.map(it => {
        const date = String(it.date || "").trim();
        const time = String(it.time || "").trim();
        const reason = escapeHtml_(it.reason || "-");
        const score = Number(it.score ?? 0);

        let prettyDate = date || "-";
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          prettyDate = date.slice(5).replace("-", "/");
        }

        const prettyTime = time ? time : "-";

        return `
          <tr>
            <td style="padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">
              ${escapeHtml_(prettyDate)}
            </td>
            <td style="padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); white-space:nowrap;">
              ${escapeHtml_(prettyTime)}
            </td>
            <td style="padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); font-weight:700;">
              ${reason}
            </td>
            <td style="padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); text-align:right; white-space:nowrap;">
              ${escapeHtml_(String(score))}점
            </td>
          </tr>
        `;
      }).join("");

      wrap.style.display = "";
    } catch (e) {
      loading.textContent = "";
      if (empty) empty.style.display = "none";
      error.textContent = e?.message ?? String(e);
    }
  }
})();

/* =========================================================
   공통: XSS 방지
========================================================= */
function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}




