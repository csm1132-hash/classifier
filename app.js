/* 고객 한마디 분류기 — 화면.
 *
 * 흐름: 문장 → 가림(mask.js, 브라우저 안) → AI(api/classify) → 실패하면 규칙(rules.js)
 * 채점: 정답 100건을 규칙으로, 또는 AI로(BATCH 건씩 나눠) 돌려 맞힌 비율을 잰다.
 * 모델: 화면 위 «AI 모델»에서 고른다. «서버 기본값»이면 빈 문자열을 보내고 서버가 정한다.
 */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const S = { criteria: null, test: [], practice: [], aiResults: null, aiModel: "", serverDefault: null };

  // 채점할 때 한 번에 보내는 문장 수. 서버의 MAX_TEXTS(20) 를 넘지 않는다.
  // 20개씩 보내면 느린 모델에서 서버의 대기 한도를 넘겨 채점이 통째로 실패해서 10으로 줄였다.
  const BATCH = 10;

  // ── 모델 목록 ───────────────────────────────────────
  // 2026-11-06 공식 가격표(https://aistudio.google.com/docs/pricing)에서 Free tier 가
  // «Free of charge» 로 표시된 글쓰기(텍스트) 모델 중 다섯 개. 음성·번역·임베딩·TTS·그림 모델은 뺐다.
  // 같은 날 무료로 표시됐지만 뺀 것: gemini-2.5-pro · gemini-2.5-flash (지원 중단 — 2026-12-01 부터 다른 모델로 넘어감).
  //
  // 순서는 «추정»이다 — 무료 하루 한도가 높을 것 같은 순서로 짐작해 놓았을 뿐 근거를 찾지 못했다.
  //   모델별 무료 한도는 AI Studio 에 로그인해야 보이고, 공식 문서(pricing · rate-limits)에는 표가 없다.
  //   짐작의 바탕: 이름에 Lite 가 붙은 가벼운 모델일수록 한도가 넉넉할 것이라는 것뿐.
  // 모델 이름은 자주 바뀐다. 목록을 고칠 때는 가격표를 다시 확인한다.
  const MODELS = [
    { id: "gemini-3.5-flash-lite" },
    { id: "gemini-3.1-flash-lite" },
    { id: "gemini-2.5-flash-lite" },   // 가격표엔 무료·중단 표시 없음. 다만 예전 서버 주석에 «2.5 계열은 예전 사용자에게만 열려 있다(2026-09)»
    { id: "gemini-3.8-flash" },
    { id: "gemini-3-flash-preview", tag: "프리뷰" },   // 가격표에 "legacy Flash model" 이라고 적혀 있다
  ];
  const DEFAULT = "";            // «서버 기본값»
  const CUSTOM = "__custom__";   // «직접 입력…»
  const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$/;   // 서버와 같은 규칙 (서버가 최종 검사)

  // localStorage 를 못 쓰는 곳(시크릿 창 · 막힌 사이트 데이터)에서도 앱은 그대로 돈다
  function remember(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 기억 못 해도 된다 */ } }
  function recall(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function setupModels() {
    const sel = $("#model-select");
    sel.innerHTML = "";
    const opt = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; sel.append(o); };
    opt(DEFAULT, "서버 기본값");
    MODELS.forEach(m => opt(m.id, m.tag ? `${m.id} (${m.tag})` : m.id));
    opt(CUSTOM, "직접 입력…");

    const saved = recall("classifier.model");
    if (saved !== null && [...sel.options].some(o => o.value === saved)) sel.value = saved;
    $("#model-custom").value = recall("classifier.model.custom") || "";

    sel.addEventListener("change", () => { remember("classifier.model", sel.value); showModel(); });
    $("#model-custom").addEventListener("input", () => { remember("classifier.model.custom", $("#model-custom").value); showModel(); });
    showModel();
  }

  // 요청에 넣을 모델 이름. «서버 기본값»이면 빈 문자열
  function chosenModel() {
    const v = $("#model-select").value;
    return v === CUSTOM ? $("#model-custom").value.trim() : v;
  }

  // 사람이 읽을 이름 — 빈 문자열이면 서버 기본값
  function modelLabel(m) {
    if (m) return m;
    return S.serverDefault ? `서버 기본값 ${S.serverDefault}` : "서버 기본값";
  }

  function showModel() {
    const custom = $("#model-select").value === CUSTOM;
    $("#model-custom").hidden = !custom;
    const m = chosenModel();
    const now = $("#model-now");
    now.classList.remove("bad");
    if (m && !MODEL_RE.test(m)) {
      now.classList.add("bad");
      now.textContent = "모델 이름 형식이 맞지 않습니다 — 영문·숫자로 시작, 영문·숫자·. _ - 만, 64자 이하. 이대로 보내면 서버가 거절합니다.";
    } else if (m) {
      now.textContent = `지금 호출하는 모델: ${m}`;
    } else {
      const d = S.serverDefault ? S.serverDefault : "(서버 함수에 닿지 못해 이름을 모릅니다)";
      now.textContent = (custom ? "이름이 비어 있어 서버 기본값으로 호출합니다: " : "지금 호출하는 모델: 서버 기본값 — ") + d;
    }
  }

  // 서버 기본 모델 이름을 묻는다. 로컬처럼 서버 함수가 없으면 모르는 채로 둔다
  async function loadServerDefault() {
    try {
      const r = await fetch("api/classify", { method: "GET", cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      if (d && typeof d.default === "string") S.serverDefault = d.default;
    } catch (e) { /* 모르는 채로 둔다 */ }
    showModel();
  }

  async function load() {
    const [c, t, p] = await Promise.all([
      fetch("criteria.json").then(r => r.json()),
      fetch("data/answer100.json").then(r => r.json()),
      fetch("data/practice200.json").then(r => r.json()),
    ]);
    S.criteria = c; S.test = t; S.practice = p;
    renderCriteria();
  }

  // ── 탭 ──────────────────────────────────────────────
  document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
    ["try", "score", "rules"].forEach(k => { $("#tab-" + k).hidden = k !== b.dataset.tab; });
  }));

  // ── AI 호출 ─────────────────────────────────────────
  // model 을 주지 않으면 지금 고른 모델로. 채점은 시작할 때 고른 모델을 끝까지 넘긴다
  async function askAI(maskedTexts, model = chosenModel()) {
    try {
      const r = await fetch("api/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: maskedTexts, criteria: S.criteria, model }),
      });
      if (r.status === 404 || r.status === 405 || r.status === 501) {
        return { results: null, reason: `서버 함수가 없습니다 (${r.status}) — 배포하면 생깁니다` };
      }
      // 504: 서버 함수 자체가 배포 서비스의 시간 한도를 넘김 — 느린 것이므로 타임아웃으로 본다
      if (r.status === 504) {
        return { results: null, timeout: true, reason: `서버 함수가 시간 안에 끝나지 않았습니다 (504) — 모델 ${modelLabel(model)}` };
      }
      if (!r.ok) return { results: null, reason: `서버 함수 오류 (${r.status}) — 모델 ${modelLabel(model)}` };
      return await r.json();
    } catch (e) {
      return { results: null, reason: "서버 함수에 닿지 못했습니다" };
    }
  }

  function chips(el, res) {
    el.innerHTML = ["category", "sentiment", "urgency"]
      .map(k => `<span class="chip ${res[k]}">${res[k]}</span>`).join("");
  }

  // ── 분류해 보기 ─────────────────────────────────────
  $("#btn-sample").addEventListener("click", () => {
    const r = S.practice[Math.floor(Math.random() * S.practice.length)];
    $("#input").value = r.text;
  });

  $("#btn-classify").addEventListener("click", async () => {
    const text = $("#input").value.trim();
    if (!text) return;
    const btn = $("#btn-classify");
    btn.disabled = true; btn.textContent = "분류 중…";

    const m = Mask.mask(text);
    $("#sent").hidden = false;
    $("#sent-text").textContent = m.masked;
    $("#sent-found").innerHTML = m.found.length
      ? m.found.map(f => `<span class="tag">${f.type} 가림</span>`).join("")
      : `<span class="muted">가린 것 없음</span>`;

    const rule = Rules.classify(m.masked, S.criteria);
    const ai = await askAI([m.masked]);
    const got = ai.results && ai.results[0];

    $("#result").hidden = false;
    if (got) {
      $("#main-by").textContent = "AI · " + (ai.model || "");
      chips($("#main-chips"), got);
      $("#main-reason").textContent = got.reason || "";
      $("#note").hidden = true;
    } else {
      $("#main-by").textContent = "규칙";
      chips($("#main-chips"), rule);
      $("#main-reason").textContent = `분류: ${rule.why.category} · 감정: ${rule.why.sentiment} · 긴급도: ${rule.why.urgency}`;
      $("#note").hidden = false;
      $("#note").textContent = `AI 없이 규칙으로만 분류했습니다 — ${ai.reason || "AI 응답 없음"}`;
    }
    chips($("#rule-chips"), rule);
    $("#rule-reason").textContent = `분류: ${rule.why.category}`;
    $("#card-rule").hidden = !got;

    btn.disabled = false; btn.textContent = "분류하기";
  });

  // ── 채점 ───────────────────────────────────────────
  function pct(x) { return x.toFixed(x % 1 ? 1 : 0) + "%"; }

  function showScore(who, s) {
    $("#score-table").hidden = false;
    for (const k of ["category", "sentiment", "urgency"]) {
      document.querySelector(`[data-k="${who}-${k}"]`).textContent = pct(s.accuracy[k]);
    }
    document.querySelector(`[data-k="${who}-all"]`).textContent = `${s.n - s.wrong.length} / ${s.n}`;
    $("#wrong").hidden = false;
    $("#wrong-who").textContent = (who === "ai" ? "— AI" : "— 규칙") + " · 정답 → 판정";
    $("#wrong-list").innerHTML = s.wrong.slice(0, 15).map(w => {
      const diff = ["category", "sentiment", "urgency"].filter(k => w.got[k] !== w.want[k])
        .map(k => `${w.want[k]}→${w.got[k]}`).join(" · ");
      return `<li><span class="t">${w.text}</span><br><span class="d">${diff}${w.note ? " · " + w.note : ""}</span></li>`;
    }).join("") + (s.wrong.length > 15 ? `<li class="d">… 외 ${s.wrong.length - 15}건</li>` : "");
  }

  $("#btn-score-rule").addEventListener("click", () => {
    const s = Rules.score(S.test, r => Rules.classify(Mask.mask(r.text).masked, S.criteria));
    showScore("rule", s);
    $("#score-msg").hidden = true;
  });

  $("#btn-score-ai").addEventListener("click", async () => {
    const btn = $("#btn-score-ai");
    btn.disabled = true;
    const model = chosenModel();          // 채점 도중에 드롭다운을 바꿔도 이 모델로 끝까지 간다
    const masked = S.test.map(r => Mask.mask(r.text).masked);
    const results = [];
    const used = new Set();
    for (let i = 0; i < masked.length; i += BATCH) {
      const part = masked.slice(i, i + BATCH);
      btn.textContent = `AI 채점 중… ${i}/${masked.length}`;
      let r = await askAI(part, model);
      let tries = 1;
      if (!r.results && r.timeout) {      // 느려서 끊긴 것만 그 묶음을 한 번 더
        btn.textContent = `다시 시도… ${i}/${masked.length}`;
        r = await askAI(part, model);
        tries = 2;
      }
      if (!r.results) {
        const where = `${i + 1}~${i + part.length}번 문장${tries > 1 ? " · 두 번 시도" : ""}`;
        $("#score-msg").hidden = false;
        $("#score-msg").textContent = `AI로 채점하지 못했습니다 (${where}) — ${r.reason}`;
        btn.disabled = false; btn.textContent = "AI로 채점";
        return;
      }
      if (r.model) used.add(r.model);
      // 서버가 보낸 개수만큼 받는다 — 모자라면 빈칸(오답)으로 채워 번호가 밀리지 않게
      for (let k = 0; k < part.length; k++) results.push(r.results[k] || null);
    }
    // 답을 못 받은 문장은 «오답»으로 센다 — 빠진 것을 빼고 세면 점수가 부풀려진다
    const miss = { category: "-", sentiment: "-", urgency: "-" };
    S.aiResults = results;
    S.aiModel = [...used].join(", ") || modelLabel(model);
    const s = Rules.score(S.test, (r, i) => results[i] || miss);
    showScore("ai", s);
    $("#ai-col").textContent = "AI · " + S.aiModel;
    const blank = results.filter(x => !x).length;
    $("#score-msg").hidden = !blank;
    if (blank) $("#score-msg").textContent = `AI가 답하지 않은 문장 ${blank}건은 오답으로 셌습니다.`;
    $("#btn-download").hidden = false;
    btn.disabled = false; btn.textContent = "AI로 채점";
  });

  $("#btn-download").addEventListener("click", () => {
    const rows = S.test.map((r, i) => ({ id: r.id, text: r.text, 정답: r, AI: S.aiResults[i], 모델: S.aiModel }));
    const blob = new Blob([JSON.stringify(rows, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "ai_채점결과.json"; a.click();
  });

  // ── 기준 ───────────────────────────────────────────
  function renderCriteria() {
    const c = S.criteria;
    $("#owner").textContent = c.owner;
    $("#crit-cats").innerHTML = c.categories
      .map(x => `<tr><td>${x.name}</td><td>${x.definition}</td></tr>`).join("");
    $("#crit-priority").textContent = c.priority.join(" → ") + " 순서로 먼저 봅니다.";
    $("#crit-priority-reason").textContent = c.priority_reason;
    $("#crit-sent").textContent = c.sentiment.guide;
    $("#crit-urg").textContent = c.urgency.guide;
  }

  setupModels();
  loadServerDefault();
  load();
})();
