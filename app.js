/* =========================================================
   Anatomy Question Bank – Heart Unit  |  Phase 7 script
   Phase 1: i18n, language toggle, cards, particles, toast
   Phase 2: real lessons (data.js), quiz view, answering logic,
            explanations, lesson modal, localStorage progress
   Phase 3: exam simulation (intro modal, 1 random question per lesson,
            no feedback until the end, animated results, saved history)
   Phase 4: spaced repetition (wrong questions, due dates, review dashboard,
            2-in-a-row mastery) + flashcards (deck, 3D flip page)
   Phase 5: annotations (highlighter, freehand drawing, personal notes saved
            per question) + "Export my mistakes" PDF (jsPDF + html2canvas)
   Phase 6: PWA offline (service worker + "Download for offline use" button),
            working FR / EN / AR toggle (strings in translations.js, per-field
            "Translation unavailable" badge, RTL/LTR switching, saved choice)
   Phase 7: challenge mode (pass & play for two), stats dashboard on the
            home page, settings + "Reset all data" with confirmation
   ========================================================= */

(function () {
  'use strict';

  /* ---------- Config ---------- */
  const DEFAULT_LANG = 'ar';
  const STORAGE_KEY = 'heartUnit.lang';
  const PROGRESS_KEY = 'heartUnit.progress'; // used by Phase 4 (wrong questions / spaced repetition)
  const LOG_LIMIT = 3000;
  const EXAMS_KEY = 'heartUnit.exams';   // exam history (Phase 3) – read by the Phase 7 dashboard
  const EXAM_HISTORY_LIMIT = 500;
  const REVIEW_KEY = 'heartUnit.review';       // spaced repetition (Phase 4)
  const FLASH_KEY = 'heartUnit.flashcards';    // flashcard deck (Phase 4)
  const HOUR_MS = 3600000;
  const INTERVAL_CHOICES = [24, 48, 72];       // hours
  const DEFAULT_INTERVAL = 48;
  const MASTER_STREAK = 2;                     // correct answers in a row to master a question
  const LANG_ORDER = ['fr', 'en', 'ar']; // order of buttons in the toggle
  const SW_URL = 'service-worker.js';        // Phase 6
  const OFFLINE_FLAG = 'heartUnit.offlineReady';
  const LETTERS = 'ABCDEFGH';
  const ANN_PREFIX = 'heartUnit.ann.';          // Phase 5: one entry per question id
  const HL_COLORS = ['yellow', 'green', 'blue'];
  const PEN_PRESETS = ['#ff4757', '#ffd700', '#4da3ff', '#2ee59d', '#ffffff'];
  const PDF_LIBS = {
    jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    html2canvas: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
  };

  const LESSON_ICONS = [
    'fa-heart', 'fa-heart-pulse', 'fa-droplet', 'fa-lungs',
    'fa-bolt', 'fa-wave-square', 'fa-diagram-project', 'fa-shield-heart',
    'fa-stethoscope', 'fa-syringe', 'fa-notes-medical', 'fa-dna'
  ];

  /* ---------- Data (from data.js) ---------- */
  const LESSONS = (window.HEART_DATA && Array.isArray(window.HEART_DATA.lessons))
    ? window.HEART_DATA.lessons
    : [];
  const TOTAL_QUESTIONS = LESSONS.reduce((sum, l) => sum + (l.questions ? l.questions.length : 0), 0);
  // id -> { q, li }  (used by review + flashcards)
  const QMAP = {};
  LESSONS.forEach((l, li) => (l.questions || []).forEach(q => { QMAP[q.id] = { q: q, li: li }; }));

  /* ---------- Translations ----------
     All UI strings live in translations.js  (window.HEART_I18N). */
  const I18N = (window.HEART_I18N && window.HEART_I18N.en) ? window.HEART_I18N : { en: {} };

  /* ---------- State ---------- */
  let currentLang = DEFAULT_LANG;
  let toastTimer = null;
  let quiz = null;          // active quiz session (null on home)
  let lastFocus = null;     // element to refocus after closing the modal
  let currentView = 'home'; // 'home' | 'quiz' | 'review' | 'flash'

  /* Phase 5 state */
  let annot = null;          // open editor: { qid, q, editing, dirty, draft:{hl,strokes,note} }
  const annPrefs = { tool: 'hl', hlColor: 'yellow', penColor: PEN_PRESETS[0], size: 4 };  // remembered between questions
  let annShown = [];         // strokes currently painted on the canvas
  let annRO = null;          // ResizeObserver on the question area
  let annDrawing = null;     // stroke being drawn right now
  let annMouseDown = false;
  let annSelTimer = null;
  let pdfBusy = false;

  /* Phase 7 state */
  let chal = null;           // active challenge: { phase:'setup'|'play'|'result', ... }
  const chalSetup = { p1: '', p2: '', lesson: 'all', count: 10 };   // remembered between games
  let confettiRaf = null;
  let confettiCv = null;

  /* ---------- Helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function t(key) {
    return (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /* ---------- Content helpers (language fallback) ----------
     data.js has fields like question / questionFr / questionEn.
     We pick the current language first, then fall back to any
     filled-in version so nothing ever shows up empty. */
  const SUFFIX = { fr: 'Fr', en: 'En', ar: '' };

  function fieldOrder(base) {
    return [base + (SUFFIX[currentLang] || ''), base, base + 'Fr', base + 'En', base + 'Ar'];
  }

  function pickText(obj, base) {
    if (!obj) return '';
    for (const key of fieldOrder(base)) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  }

  function pickList(obj, base) {
    if (!obj) return [];
    for (const key of fieldOrder(base)) {
      const v = obj[key];
      if (Array.isArray(v) && v.some(s => s != null && String(s).trim())) {
        return v.map(s => (s == null ? '' : String(s).trim()));
      }
    }
    return [];
  }

  // Phase 6: true when the CURRENT language really has this field filled in
  // (otherwise pickText / pickList silently fell back to another language).
  function hasLang(obj, base, isList) {
    if (!obj) return false;
    const v = obj[base + (SUFFIX[currentLang] || '')];
    if (isList) return Array.isArray(v) && v.some(s => s != null && String(s).trim());
    return typeof v === 'string' && !!v.trim();
  }

  // Small badge shown next to text that is not available in the chosen language.
  function tuBadge() {
    return `<span class="tu-badge"><i class="fa-solid fa-language"></i> ${esc(t('translationUnavailable'))}</span>`;
  }

  function qBadge(q) {
    return (hasLang(q, 'question') && hasLang(q, 'options', true)) ? '' : tuBadge();
  }

  function explBadge(q) {
    return hasLang(q, 'explanation') ? '' : tuBadge();
  }

  // wrongExplanations may be null, an array (one per option) or an object keyed by option index.
  function pickWrongExplanations(q, count) {
    for (const key of fieldOrder('wrongExplanations')) {
      const v = q[key];
      if (!v) continue;
      const out = new Array(count).fill('');
      if (Array.isArray(v)) {
        v.forEach((s, i) => { if (i < count && typeof s === 'string') out[i] = s.trim(); });
      } else if (typeof v === 'object') {
        Object.keys(v).forEach(k => {
          const i = Number(k);
          if (Number.isInteger(i) && i >= 0 && i < count && typeof v[k] === 'string') out[i] = v[k].trim();
        });
      }
      if (out.some(Boolean)) return out;
    }
    return null;
  }

  function lessonTitle(lesson, index) {
    return pickText(lesson, 'title') || (t('lesson') + ' ' + (index + 1));
  }

  /* ---------- Progress storage (for Phase 4) ----------
     {
       v: 1,
       answers: { "<questionId>": { lessonId, selected, correct, attempts,
                                     correctCount, wrongCount, lastAnswered } },
       log: [ { id, lessonId, correct, t } ]   // chronological history
     }                                                              */
  function loadProgress() {
    try {
      const raw = safeGet(PROGRESS_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && typeof data === 'object' && data.answers) {
          if (!Array.isArray(data.log)) data.log = [];
          return data;
        }
      }
    } catch (e) { /* fall through */ }
    return { v: 1, answers: {}, log: [] };
  }

  function recordAnswer(q, lessonId, selected, correct, skipWrong) {
    const store = loadProgress();
    const now = Date.now();
    const prev = store.answers[q.id] || { attempts: 0, correctCount: 0, wrongCount: 0 };
    store.answers[q.id] = {
      lessonId: lessonId,
      selected: selected,
      correct: correct,
      attempts: prev.attempts + 1,
      correctCount: prev.correctCount + (correct ? 1 : 0),
      wrongCount: prev.wrongCount + (correct ? 0 : 1),
      lastAnswered: now
    };
    store.log.push({ id: q.id, lessonId: lessonId, correct: correct, t: now });
    if (store.log.length > LOG_LIMIT) store.log = store.log.slice(-LOG_LIMIT);
    safeSet(PROGRESS_KEY, JSON.stringify(store));
    // Phase 4: every wrong answer joins the wrong-questions / spaced-repetition list
    // (review sessions handle their own scheduling, so they pass skipWrong).
    if (!correct && !skipWrong) addWrong(q, lessonId, selected);
  }

  /* ---------- Toast ---------- */
  function showToast(message, ms) {
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), ms || 2200);
  }

  /* ---------- Views ---------- */
  function showView(name) {
    currentView = name;
    const map = { home: '#homeView', quiz: '#quizView', review: '#reviewView', flash: '#flashView', challenge: '#challengeView' };
    Object.keys(map).forEach(k => {
      const el = $(map[k]);
      if (el) el.hidden = k !== name;
    });
    if (name === 'home') renderStats();   // Phase 7
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  // Cleans up the current screen before navigating elsewhere.
  // Returns false if the user chose to stay (unfinished exam).
  function leaveCurrent() {
    if (quiz && quiz.mode === 'exam' && !quiz.done && !window.confirm(t('examLeaveConfirm'))) return false;
    if (chal && chal.phase === 'play' && !window.confirm(t('chalLeaveConfirm'))) return false;   // Phase 7
    chal = null;
    stopConfetti();
    const chalEl = $('#challengeView');
    if (chalEl) chalEl.innerHTML = '';
    annFlush();           // Phase 5: keep unsaved annotations
    closeModal(true);
    closeExamModal(true);
    quiz = null;
    const quizEl = $('#quizView');
    if (quizEl) quizEl.innerHTML = '';
    return true;
  }

  function goHome() {
    if (!leaveCurrent()) return;
    showView('home');
  }

  /* ---------- Card builders ---------- */
  function buildLessonCard(index) {
    const lesson = LESSONS[index];
    const n = index + 1;
    const count = lesson.questions ? lesson.questions.length : 0;
    const card = document.createElement('article');
    card.className = 'card lesson-card';
    card.style.setProperty('--i', index);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.dataset.lesson = String(index);

    card.innerHTML = `
      <span class="card-num">${String(n).padStart(2, '0')}</span>
      <div class="card-icon"><i class="fa-solid ${LESSON_ICONS[index % LESSON_ICONS.length]}"></i></div>
      <h3 class="lesson-title" dir="auto">${esc(lessonTitle(lesson, index))}</h3>
      <p class="lesson-label"><span data-i18n="lesson"></span> ${n}</p>
      <div class="card-meta">
        <i class="fa-regular fa-circle-question"></i>
        <span>${count}</span>
        <span data-i18n="questions"></span>
        <i class="fa-solid fa-arrow-right card-arrow"></i>
      </div>
    `;
    return card;
  }

  function buildSpecialCards() {
    const wrapAll = document.createElement('div');
    wrapAll.className = 'special-wrap';
    wrapAll.innerHTML = `
      <article class="card card--special card--gold" style="--i:12" tabindex="0" role="button" data-action="all">
        <div class="card-icon"><i class="fa-solid fa-book-open"></i></div>
        <h3 data-i18n="allLessons"></h3>
        <p data-i18n="allLessonsDesc"></p>
        <div class="card-meta">
          <i class="fa-solid fa-layer-group"></i>
          <span>${TOTAL_QUESTIONS}</span>
          <span data-i18n="questions"></span>
          <i class="fa-solid fa-arrow-right card-arrow"></i>
        </div>
      </article>
    `;

    const wrapExam = document.createElement('div');
    wrapExam.className = 'special-wrap';
    wrapExam.innerHTML = `
      <article class="card card--special card--exam" style="--i:13" tabindex="0" role="button" data-action="exam">
        <div class="card-icon"><i class="fa-solid fa-stopwatch"></i></div>
        <h3 data-i18n="exam"></h3>
        <p data-i18n="examDesc"></p>
        <div class="card-meta">
          <i class="fa-solid fa-circle-question"></i>
          <span>12</span>
          <span data-i18n="questions"></span>
          <i class="fa-solid fa-arrow-right card-arrow"></i>
        </div>
      </article>
      <p class="card-caption">
        <i class="fa-solid fa-circle-info"></i>
        <span data-i18n="examCaption"></span>
      </p>
    `;

    const wrapChal = document.createElement('div');
    wrapChal.className = 'special-wrap special-wrap--chal';
    wrapChal.innerHTML = `
      <article class="card card--special card--chal" style="--i:14" tabindex="0" role="button" data-action="challenge">
        <div class="card-icon"><i class="fa-solid fa-khanda"></i></div>
        <h3><span aria-hidden="true">⚔️</span> <span data-i18n="chalCard"></span></h3>
        <p data-i18n="chalCardDesc"></p>
        <div class="card-meta">
          <i class="fa-solid fa-user-group"></i>
          <span>2</span>
          <span data-i18n="chalPlayers"></span>
          <i class="fa-solid fa-arrow-right card-arrow"></i>
        </div>
      </article>
    `;

    return [wrapAll, wrapExam, wrapChal];
  }

  function renderCards() {
    const grid = $('#lessonsGrid');
    const special = $('#specialRow');
    if (!grid || !special) return;

    const fragLessons = document.createDocumentFragment();
    for (let i = 0; i < LESSONS.length; i++) fragLessons.appendChild(buildLessonCard(i));
    grid.appendChild(fragLessons);

    buildSpecialCards().forEach(el => special.appendChild(el));
  }

  function updateCardTitles() {
    $$('.lesson-card').forEach(card => {
      const idx = Number(card.dataset.lesson);
      const h3 = $('.lesson-title', card);
      if (h3 && LESSONS[idx]) h3.textContent = lessonTitle(LESSONS[idx], idx);
    });
  }

  /* =========================================================
     QUIZ
     ========================================================= */
  function startLesson(lessonIdx) {
    const lesson = LESSONS[lessonIdx];
    if (!lesson || !lesson.questions || !lesson.questions.length) {
      showToast(t('noQuestions'));
      return;
    }
    quiz = {
      mode: 'lesson',
      lessonIdx: lessonIdx,
      items: lesson.questions.map(q => ({ q: q, li: lessonIdx })),
      pos: 0,
      answers: {},
      done: false
    };
    showView('quiz');
    renderQuiz();
  }

  function startAll() {
    const items = [];
    LESSONS.forEach((lesson, li) => {
      (lesson.questions || []).forEach(q => items.push({ q: q, li: li }));
    });
    if (!items.length) {
      showToast(t('noQuestions'));
      return;
    }
    shuffle(items);
    quiz = { mode: 'all', lessonIdx: -1, items: items, pos: 0, answers: {}, done: false };
    showView('quiz');
    renderQuiz();
  }

  function restartQuiz() {
    if (!quiz) return;
    if (quiz.mode === 'exam') startExam();
    else if (quiz.mode === 'review') startReview(quiz.scored);
    else if (quiz.mode === 'all') startAll();
    else startLesson(quiz.lessonIdx);
  }

  function quizTitle() {
    if (!quiz) return '';
    if (quiz.mode === 'exam') return t('examTitle');
    if (quiz.mode === 'all') return t('allLessonsHeader');
    if (quiz.mode === 'review') return t(quiz.scored ? 'todayTitle' : 'reviewPracticeTitle');
    return t('lesson') + ' ' + (quiz.lessonIdx + 1) + ' — ' + lessonTitle(LESSONS[quiz.lessonIdx], quiz.lessonIdx);
  }

  function tally() {
    const list = Object.keys(quiz.answers).map(k => quiz.answers[k]);
    const correct = list.filter(a => a.correct).length;
    return { answered: list.length, correct: correct, wrong: list.length - correct };
  }

  function optionState(i, q, ans) {
    if (!ans) return { cls: '', icon: '' };
    if (i === q.correctIndex) return { cls: 'correct', icon: 'fa-check' };
    if (i === ans.selected) return { cls: 'wrong', icon: 'fa-xmark' };
    return { cls: 'dim', icon: '' };
  }

  function feedbackHtml(q, ans, opts) {
    let html = '';

    html += `
      <div class="fb-status ${ans.correct ? 'is-right' : 'is-wrong'}">
        <i class="fa-solid ${ans.correct ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
        <span>${esc(t(ans.correct ? 'correctMsg' : 'wrongMsg'))}</span>
      </div>`;

    if (ans.review) {
      const r = ans.review;
      let cls = 'is-reset', icon = 'fa-rotate-left', msg = t('reviewReset');
      if (r.status === 'mastered') { cls = 'is-mastered'; icon = 'fa-trophy'; msg = t('reviewMastered'); }
      else if (r.status === 'progress') { cls = 'is-progress'; icon = 'fa-seedling'; msg = fmt(t('reviewProgress'), { n: r.streak, max: MASTER_STREAK }); }
      html += `
      <div class="fb-review ${cls}"><i class="fa-solid ${icon}"></i><span dir="auto">${esc(msg)}</span></div>`;
    } else if (ans.addedToWrong) {
      html += `
      <div class="fb-review is-added"><i class="fa-solid fa-bookmark"></i><span dir="auto">${esc(t('addedToWrong'))}</span></div>`;
    }

    const explanation = pickText(q, 'explanation');
    if (explanation) {
      html += `
      <div class="fb-block fb-ok">
        <h4><i class="fa-solid fa-lightbulb"></i> ${esc(t('whyCorrect'))}</h4>
        ${explBadge(q)}
        <p class="fb-text" dir="auto">${esc(explanation)}</p>
      </div>`;
    }

    const wrongs = pickWrongExplanations(q, opts.length);
    if (wrongs) {
      const rows = wrongs
        .map((text, i) => ({ text: text, i: i }))
        .filter(r => r.text && r.i !== q.correctIndex)
        .map(r => `
          <li>
            <span class="opt-letter">${LETTERS[r.i] || r.i + 1}</span>
            <p class="fb-text" dir="auto">${esc(r.text)}</p>
          </li>`)
        .join('');
      if (rows) {
        html += `
      <div class="fb-block fb-no">
        <h4><i class="fa-solid fa-circle-xmark"></i> ${esc(t('whyOthersWrong'))}</h4>
        <ul class="wrong-list">${rows}</ul>
      </div>`;
      }
    }

    const hasPage = q.pageNumber !== null && q.pageNumber !== undefined && q.pageNumber !== '';
    if (hasPage || (q.lessonQuote && String(q.lessonQuote).trim())) {
      html += `
      <button type="button" class="lesson-btn" data-act="lesson">${esc(t('showLesson'))}</button>`;
    }

    return html;
  }

  function renderQuiz() {
    if (!quiz) return;
    annEnsure();   // Phase 5: unsaved annotations of the previous question are auto-saved
    if (quiz.mode === 'exam') {
      if (quiz.done) renderExamResult();
      else renderExamQuestion();
      return;
    }
    if (quiz.done) renderResult();
    else renderQuestion();
  }

  function renderQuestion() {
    const view = $('#quizView');
    if (!view || !quiz) return;

    const item = quiz.items[quiz.pos];
    const q = item.q;
    const opts = pickList(q, 'options');
    const ans = quiz.answers[q.id];
    const total = quiz.items.length;
    const stats = tally();
    const isLast = quiz.pos === total - 1;
    const progress = Math.round(((quiz.pos + (ans ? 1 : 0)) / total) * 100);

    const chip = (quiz.mode === 'all' || quiz.mode === 'review')
      ? `<span class="q-chip" dir="auto">${esc(t('lesson') + ' ' + (item.li + 1) + ' · ' + lessonTitle(LESSONS[item.li], item.li))}</span>`
      : '';

    view.innerHTML = `
      <div class="quiz-top">
        <button type="button" class="back-btn" data-act="home">
          <i class="fa-solid fa-house"></i><span>${esc(t('backHome'))}</span>
        </button>
        <div class="quiz-score">
          <i class="fa-solid fa-star"></i>
          <span>${esc(t('scoreLabel'))}:</span>
          <strong id="scoreCorrect">${stats.correct}</strong>
          <span>/</span>
          <span id="scoreAnswered">${stats.answered}</span>
        </div>
      </div>

      <h2 class="quiz-title" dir="auto">${esc(quizTitle())}</h2>
      <div class="qbar" aria-hidden="true"><span id="qbarFill" style="width:${progress}%"></span></div>

      <article class="quiz-card" id="quizCard">
        <div class="q-meta">
          <span class="q-count">${esc(t('question'))} ${quiz.pos + 1} / ${total}</span>
          ${chip}
        </div>
        ${annotEditorHtml()}
        ${annotAreaHtml(q)}
        <div class="q-tools">${flashBtnHtml(q.id)}${annotBtnHtml(q.id)}</div>
        ${annotNoteHtml(q.id)}
        <div class="feedback" id="feedback">${ans ? feedbackHtml(q, ans, opts) : ''}</div>
      </article>

      <div class="quiz-nav">
        <button type="button" class="nav-step" data-act="prev" ${quiz.pos === 0 ? 'disabled' : ''}>
          <i class="fa-solid fa-arrow-left"></i><span>${esc(t('previous'))}</span>
        </button>
        <button type="button" class="nav-step primary${ans ? ' pulse' : ''}" id="btnNext" data-act="next">
          <span>${esc(t(isLast ? 'finish' : 'next'))}</span><i class="fa-solid ${isLast ? 'fa-flag-checkered' : 'fa-arrow-right'}"></i>
        </button>
      </div>
    `;
    annAfterRender(q);
  }

  function renderResult() {
    const view = $('#quizView');
    if (!view || !quiz) return;

    const total = quiz.items.length;
    const stats = tally();
    const skipped = total - stats.answered;
    const isReview = quiz.mode === 'review';
    const masteredNow = Object.keys(quiz.answers).filter(k => quiz.answers[k].review && quiz.answers[k].review.status === 'mastered').length;

    view.innerHTML = `
      <div class="quiz-top">
        <button type="button" class="back-btn" data-act="home">
          <i class="fa-solid fa-house"></i><span>${esc(t('backHome'))}</span>
        </button>
      </div>

      <h2 class="quiz-title" dir="auto">${esc(quizTitle())}</h2>

      <article class="quiz-card result">
        <div class="result-trophy"><i class="fa-solid fa-trophy"></i></div>
        <h2>${esc(t('resultTitle'))}</h2>
        <div class="result-score">${stats.correct} / ${total}</div>
        <div class="result-stats">
          <div class="stat ok"><strong>${stats.correct}</strong>${esc(t('correctAnswers'))}</div>
          <div class="stat bad"><strong>${stats.wrong}</strong>${esc(t('wrongAnswers'))}</div>
          <div class="stat"><strong>${skipped}</strong>${esc(t('skipped'))}</div>
          ${isReview && quiz.scored ? `<div class="stat ok"><strong>${masteredNow}</strong>${esc(t('masteredSession'))}</div>` : ''}
        </div>
        <div class="result-actions">
          ${isReview
            ? `<button type="button" class="nav-step" data-act="dashboard"><i class="fa-solid fa-arrows-rotate no-flip"></i><span>${esc(t('reviewDashboard'))}</span></button>`
            : `<button type="button" class="nav-step" data-act="retry"><i class="fa-solid fa-rotate-right"></i><span>${esc(t('retry'))}</span></button>`}
          <button type="button" class="nav-step primary" data-act="home"><i class="fa-solid fa-house"></i><span>${esc(t('backHome'))}</span></button>
        </div>
      </article>
    `;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function onAnswer(idx) {
    if (!quiz || quiz.done) return;
    if (quiz.mode === 'exam') { examSelect(idx); return; }
    const item = quiz.items[quiz.pos];
    const q = item.q;
    if (quiz.answers[q.id]) return; // already answered

    const opts = pickList(q, 'options');
    if (idx < 0 || idx >= opts.length) return;

    const correct = idx === q.correctIndex;
    const ans = { selected: idx, correct: correct };
    quiz.answers[q.id] = ans;

    // Persist + Phase 4 scheduling
    const inReview = quiz.mode === 'review';
    recordAnswer(q, LESSONS[item.li].id, idx, correct, inReview);
    if (inReview) {
      if (quiz.scored) ans.review = gradeReview(q, LESSONS[item.li].id, correct, idx);
    } else if (!correct) {
      ans.addedToWrong = true;
    }

    // Paint options in place (keeps animations smooth)
    $$('#options .option').forEach((btn, i) => {
      const st = optionState(i, q, ans);
      btn.classList.add('locked');
      if (st.cls) btn.classList.add(st.cls);
      if (st.cls === 'correct' || st.cls === 'wrong') btn.classList.add('anim');
      const icon = $('.opt-icon i', btn);
      if (icon && st.icon) icon.className = 'fa-solid ' + st.icon;
    });

    // Feedback
    const fb = $('#feedback');
    if (fb) {
      fb.innerHTML = feedbackHtml(q, ans, opts);
      fb.classList.add('reveal');
      setTimeout(() => fb.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 250);
    }

    // Score + progress + next button
    const stats = tally();
    const sc = $('#scoreCorrect');
    const sa = $('#scoreAnswered');
    if (sc) sc.textContent = stats.correct;
    if (sa) sa.textContent = stats.answered;
    const fill = $('#qbarFill');
    if (fill) fill.style.width = Math.round(((quiz.pos + 1) / quiz.items.length) * 100) + '%';
    const next = $('#btnNext');
    if (next) next.classList.add('pulse');
  }

  function goNext() {
    if (!quiz) return;
    if (quiz.mode === 'exam') { examNext(); return; }
    if (quiz.pos >= quiz.items.length - 1) {
      quiz.done = true;
    } else {
      quiz.pos++;
    }
    renderQuiz();
    if (!quiz.done) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function goPrev() {
    if (!quiz || quiz.pos === 0) return;
    quiz.pos--;
    renderQuiz();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* =========================================================
     EXAM SIMULATION  (Phase 3)
     One random question per lesson, no feedback until the end,
     result saved to localStorage ("heartUnit.exams") for Phase 7.
     ========================================================= */
  function fmt(str, vars) {
    return String(str).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m));
  }

  /* ---------- Exam history storage ----------
     {
       v: 1,
       results: [ { id, date (ISO), ts, score, total, percent,
                    correct, wrong, skipped,
                    questions: [ { id, lessonId, selected, correct } ] } ]
     }                                                              */
  function loadExams() {
    try {
      const raw = safeGet(EXAMS_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && typeof data === 'object' && Array.isArray(data.results)) return data;
      }
    } catch (e) { /* fall through */ }
    return { v: 1, results: [] };
  }

  function saveExamResult(result) {
    const store = loadExams();
    store.results.push(result);
    if (store.results.length > EXAM_HISTORY_LIMIT) {
      store.results = store.results.slice(-EXAM_HISTORY_LIMIT);
    }
    safeSet(EXAMS_KEY, JSON.stringify(store));
    return store;
  }

  /* ---------- Intro modal ---------- */
  let examLastFocus = null;

  function openExamModal(triggerEl) {
    const modal = $('#examModal');
    if (!modal) return;
    if (!LESSONS.some(l => l.questions && l.questions.length)) {
      showToast(t('noQuestions'));
      return;
    }
    examLastFocus = triggerEl || document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    const startBtn = $('#examStart');
    if (startBtn) startBtn.focus();
  }

  function closeExamModal(silent) {
    const modal = $('#examModal');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.style.overflow = '';
    if (!silent && examLastFocus && document.body.contains(examLastFocus)) {
      try { examLastFocus.focus(); } catch (e) { /* ignore */ }
    }
    examLastFocus = null;
  }

  function isExamModalOpen() {
    const modal = $('#examModal');
    return !!modal && !modal.hidden;
  }

  /* ---------- Build + start ---------- */
  function isUsableQuestion(q) {
    return !!q && Number.isInteger(q.correctIndex) &&
      pickList(q, 'options').length > q.correctIndex &&
      !!pickText(q, 'question');
  }

  // One random question from every lesson (kept in lesson order).
  function pickExamItems() {
    const items = [];
    LESSONS.forEach((lesson, li) => {
      const pool = (lesson.questions || []).filter(isUsableQuestion);
      if (pool.length) {
        items.push({ q: pool[Math.floor(Math.random() * pool.length)], li: li });
      }
    });
    return items;
  }

  function startExam() {
    const items = pickExamItems();
    if (!items.length) {
      showToast(t('noQuestions'));
      return;
    }
    closeExamModal(true);
    closeModal(true);
    quiz = {
      mode: 'exam',
      lessonIdx: -1,
      items: items,
      pos: 0,
      answers: {},      // questionId -> { selected }   (no correctness stored until finish)
      done: false,
      animated: false,  // score count-up already played?
      result: null
    };
    showView('quiz');
    renderQuiz();
  }

  /* ---------- Question screen ---------- */
  function examAnsweredCount() {
    return Object.keys(quiz.answers).length;
  }

  function renderExamQuestion() {
    const view = $('#quizView');
    if (!view || !quiz) return;

    const total = quiz.items.length;
    const item = quiz.items[quiz.pos];
    const q = item.q;
    const ans = quiz.answers[q.id];
    const isLast = quiz.pos === total - 1;
    const pct = Math.round(((quiz.pos + 1) / total) * 100);

    const dotsHtml = quiz.items.map((it, i) => `
        <button type="button" class="exam-dot${i === quiz.pos ? ' current' : ''}${quiz.answers[it.q.id] ? ' answered' : ''}"
                data-act="goto" data-pos="${i}" aria-label="${esc(t('question') + ' ' + (i + 1))}">${i + 1}</button>`).join('');

    view.innerHTML = `
      <div class="quiz-top">
        <button type="button" class="back-btn" data-act="home">
          <i class="fa-solid fa-house"></i><span>${esc(t('backHome'))}</span>
        </button>
        <div class="quiz-score">
          <i class="fa-solid fa-pen-to-square"></i>
          <span>${esc(t('examAnswered'))}:</span>
          <strong id="examAnsweredN">${examAnsweredCount()}</strong>
          <span>/</span>
          <span>${total}</span>
        </div>
      </div>

      <h2 class="quiz-title" dir="auto">${esc(quizTitle())}</h2>

      <div class="exam-progress">
        <div class="exam-progress-label">
          <span class="exam-qnum">${esc(t('question'))} ${quiz.pos + 1}/${total}</span>
          <span class="exam-pct">${pct}%</span>
        </div>
        <div class="qbar" role="progressbar" aria-valuemin="1" aria-valuemax="${total}" aria-valuenow="${quiz.pos + 1}">
          <span style="width:${pct}%"></span>
        </div>
        <div class="exam-dots" id="examDots">${dotsHtml}</div>
      </div>

      <article class="quiz-card" id="quizCard">
        ${annotEditorHtml()}
        ${annotAreaHtml(q)}
        <div class="q-tools">${annotBtnHtml(q.id)}</div>
        ${annotNoteHtml(q.id)}
      </article>

      <div class="quiz-nav">
        <button type="button" class="nav-step" data-act="prev" ${quiz.pos === 0 ? 'disabled' : ''}>
          <i class="fa-solid fa-arrow-left"></i><span>${esc(t('previous'))}</span>
        </button>
        <button type="button" class="nav-step primary${ans ? ' pulse' : ''}" id="btnNext" data-act="next">
          <span>${esc(t(isLast ? 'finish' : 'next'))}</span><i class="fa-solid ${isLast ? 'fa-flag-checkered' : 'fa-arrow-right'}"></i>
        </button>
      </div>
    `;
    annAfterRender(q);
  }

  // Select (or change) an option — nothing is revealed.
  function examSelect(idx) {
    if (!quiz || quiz.mode !== 'exam' || quiz.done) return;
    const q = quiz.items[quiz.pos].q;
    const opts = pickList(q, 'options');
    if (idx < 0 || idx >= opts.length) return;

    quiz.answers[q.id] = { selected: idx };

    $$('#options .option').forEach((btn, i) => {
      const on = i === idx;
      btn.classList.toggle('selected', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) {
        btn.classList.remove('anim');
        void btn.offsetWidth; // restart the pop animation
        btn.classList.add('anim');
      }
    });

    const n = $('#examAnsweredN');
    if (n) n.textContent = examAnsweredCount();
    const dot = $$('#examDots .exam-dot')[quiz.pos];
    if (dot) dot.classList.add('answered');
    const next = $('#btnNext');
    if (next) next.classList.add('pulse');
  }

  function examGoto(pos) {
    if (!quiz || quiz.mode !== 'exam' || quiz.done) return;
    if (!Number.isInteger(pos) || pos < 0 || pos >= quiz.items.length) return;
    quiz.pos = pos;
    renderQuiz();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function examNext() {
    if (!quiz || quiz.mode !== 'exam' || quiz.done) return;
    const total = quiz.items.length;
    if (quiz.pos < total - 1) {
      quiz.pos++;
      renderQuiz();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    // Last question → "Finish"
    const unanswered = total - examAnsweredCount();
    if (unanswered > 0 && !window.confirm(fmt(t('examUnansweredConfirm'), { n: unanswered }))) return;
    finishExam();
  }

  /* ---------- Grading + saving ---------- */
  function finishExam() {
    const details = quiz.items.map(it => {
      const a = quiz.answers[it.q.id];
      const selected = a ? a.selected : null;
      return {
        id: it.q.id,
        lessonId: LESSONS[it.li].id,
        selected: selected,
        correct: selected !== null && selected === it.q.correctIndex
      };
    });

    const total = details.length;
    const correct = details.filter(d => d.correct).length;
    const skipped = details.filter(d => d.selected === null).length;
    const wrong = total - correct - skipped;
    const now = Date.now();

    const result = {
      id: 'exam_' + now,
      date: new Date(now).toISOString(),
      ts: now,
      score: correct,
      total: total,
      percent: Math.round((correct / total) * 100),
      correct: correct,
      wrong: wrong,
      skipped: skipped,
      questions: details
    };

    // Answered exam questions also feed the Phase 4 "wrong questions" data.
    quiz.items.forEach((it, i) => {
      const d = details[i];
      if (d.selected !== null) recordAnswer(it.q, d.lessonId, d.selected, d.correct);
    });

    const store = saveExamResult(result);
    const best = store.results.reduce((m, r) => Math.max(m, r.percent), 0);

    quiz.result = Object.assign({}, result, { attempt: store.results.length, bestPercent: best });
    quiz.done = true;
    renderQuiz();
  }

  /* ---------- Results screen ---------- */
  function verdictFor(percent) {
    if (percent >= 90) return { key: 'examVerdict4', cls: 't-top' };
    if (percent >= 75) return { key: 'examVerdict3', cls: 't-high' };
    if (percent >= 50) return { key: 'examVerdict2', cls: 't-mid' };
    return { key: 'examVerdict1', cls: 't-low' };
  }

  function reviewItemHtml(it, d, idx) {
    const q = it.q;
    const opts = pickList(q, 'options');
    const letter = i => LETTERS[i] || (i + 1);
    const skipped = d.selected === null;
    const explanation = pickText(q, 'explanation');

    const yourAnswer = skipped
      ? `<div class="review-ans none">
           <i class="fa-solid fa-minus"></i>
           <div><small>${esc(t('examYourAnswer'))}</small><p>${esc(t('examNoAnswer'))}</p></div>
         </div>`
      : `<div class="review-ans bad">
           <i class="fa-solid fa-xmark"></i>
           <div><small>${esc(t('examYourAnswer'))}</small><p dir="auto"><strong>${letter(d.selected)}.</strong> ${esc(opts[d.selected])}</p></div>
         </div>`;

    return `
      <li class="review-item${skipped ? ' is-skipped' : ''}" style="--i:${idx}">
        <div class="review-head">
          <span class="q-chip" dir="auto">${esc(t('lesson') + ' ' + (it.li + 1) + ' · ' + lessonTitle(LESSONS[it.li], it.li))}</span>
          <span class="review-tag ${skipped ? 'is-skipped' : 'is-wrong'}">${esc(t(skipped ? 'examSkippedTag' : 'examWrongTag'))}</span>
        </div>
        ${qBadge(q)}
        <h4 class="review-q" dir="auto">${esc(pickText(q, 'question'))}</h4>
        ${yourAnswer}
        <div class="review-ans ok">
          <i class="fa-solid fa-check"></i>
          <div><small>${esc(t('examCorrectAnswer'))}</small><p dir="auto"><strong>${letter(q.correctIndex)}.</strong> ${esc(opts[q.correctIndex])}</p></div>
        </div>
        ${explanation ? `<p class="review-expl" dir="auto"><strong>${esc(t('examExplanation'))}:</strong> ${esc(explanation)}${hasLang(q, 'explanation') ? '' : ' ' + tuBadge()}</p>` : ''}
        <div class="q-tools">${flashBtnHtml(q.id)}</div>
      </li>`;
  }

  function renderExamResult() {
    const view = $('#quizView');
    if (!view || !quiz || !quiz.result) return;

    const r = quiz.result;
    const verdict = verdictFor(r.percent);
    const already = quiz.animated;
    const shownScore = already ? r.score : 0;
    const shownPct = already ? r.percent : 0;

    const reviewRows = quiz.items
      .map((it, i) => ({ it: it, d: r.questions[i] }))
      .filter(x => !x.d.correct)
      .map((x, idx) => reviewItemHtml(x.it, x.d, idx))
      .join('');
    const wrongCount = r.wrong + r.skipped;

    const reviewHtml = wrongCount
      ? `<section class="review-section">
           <h3 class="review-title">
             <i class="fa-solid fa-circle-xmark"></i>
             <span>${esc(t('examReviewTitle'))}</span>
             <span class="review-count">${wrongCount}</span>
           </h3>
           <ul class="review-list">${reviewRows}</ul>
         </section>`
      : `<div class="perfect-box"><i class="fa-solid fa-crown"></i><span>${esc(t('examPerfect'))}</span></div>`;

    view.innerHTML = `
      <div class="quiz-top">
        <button type="button" class="back-btn" data-act="home">
          <i class="fa-solid fa-house"></i><span>${esc(t('backHome'))}</span>
        </button>
      </div>

      <h2 class="quiz-title" dir="auto">${esc(t('examTitle'))}</h2>

      <article class="quiz-card result exam-result">
        <div class="result-trophy"><i class="fa-solid fa-trophy"></i></div>
        <h2>${esc(t('examResultTitle'))}</h2>

        <div class="score-ring">
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <defs>
              <linearGradient id="examGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#FFD700" />
                <stop offset="100%" stop-color="#FF4757" />
              </linearGradient>
            </defs>
            <circle class="ring-bg" cx="60" cy="60" r="52" />
            <circle class="ring-fg" id="examRing" cx="60" cy="60" r="52" pathLength="100"
                    style="stroke-dasharray:${shownPct} 100" />
          </svg>
          <div class="score-center" role="img" aria-label="${r.score}/${r.total}">
            <div class="score-line">
              <span class="score-num" id="examScoreNum">${shownScore}</span><span class="score-total">/${r.total}</span>
            </div>
          </div>
        </div>

        <div class="score-percent"><span id="examPct">${shownPct}</span>%</div>
        <p class="exam-verdict ${verdict.cls}">${esc(t(verdict.key))}</p>

        <div class="result-stats">
          <div class="stat ok"><strong>${r.correct}</strong>${esc(t('correctAnswers'))}</div>
          <div class="stat bad"><strong>${r.wrong}</strong>${esc(t('wrongAnswers'))}</div>
          <div class="stat"><strong>${r.skipped}</strong>${esc(t('skipped'))}</div>
        </div>

        <div class="result-actions">
          <button type="button" class="nav-step" data-act="retry"><i class="fa-solid fa-rotate-right"></i><span>${esc(t('retry'))}</span></button>
          <button type="button" class="nav-step primary" data-act="home"><i class="fa-solid fa-house"></i><span>${esc(t('backHome'))}</span></button>
        </div>

        <p class="exam-saved">
          <i class="fa-solid fa-floppy-disk"></i>
          ${esc(t('examSaved'))} · ${esc(t('examAttempt'))} #${r.attempt} · ${esc(t('examBest'))}: ${r.bestPercent}%
        </p>

        ${reviewHtml}
      </article>
    `;

    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (!already) {
      quiz.animated = true;
      animateExamScore(r);
    }
  }

  // Count-up for the score + percentage, and the ring fill.
  function animateExamScore(r) {
    const numEl = $('#examScoreNum');
    const pctEl = $('#examPct');
    const ring = $('#examRing');
    if (!numEl || !pctEl) return;

    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      numEl.textContent = r.score;
      pctEl.textContent = r.percent;
      if (ring) ring.style.strokeDasharray = r.percent + ' 100';
      return;
    }

    if (ring) {
      void ring.getBoundingClientRect(); // commit the 0% start state so the CSS transition runs
      ring.style.strokeDasharray = r.percent + ' 100';
    }

    const duration = 1700;
    const startTime = performance.now();
    function step(now) {
      const p = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      numEl.textContent = Math.round(r.score * eased);
      pctEl.textContent = Math.round(r.percent * eased);
      if (p < 1 && document.body.contains(numEl)) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* =========================================================
     SPACED REPETITION  (Phase 4)
     Storage "heartUnit.review":
     {
       v: 1,
       interval: 48,                         // hours (24 / 48 / 72)
       items:    { "<qid>": { lessonId, addedAt, lastReview, streak, wrongCount } },
       mastered: { "<qid>": <timestamp> }
     }
     A question is "due" when  now >= lastReview + interval.
     ========================================================= */
  function seedReviewFromProgress() {
    // Questions answered wrong before Phase 4 existed are carried over once.
    const seeded = { v: 1, interval: DEFAULT_INTERVAL, items: {}, mastered: {} };
    const p = loadProgress();
    Object.keys(p.answers || {}).forEach(id => {
      const a = p.answers[id];
      if (a && a.correct === false && QMAP[id]) {
        const ts = a.lastAnswered || Date.now();
        seeded.items[id] = { lessonId: a.lessonId, addedAt: ts, lastReview: ts, streak: 0, wrongCount: a.wrongCount || 1, lastWrong: Number.isInteger(a.selected) ? a.selected : null };
      }
    });
    return seeded;
  }

  function loadReview() {
    let raw = null;
    try {
      raw = safeGet(REVIEW_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && typeof d === 'object') {
          if (!d.items || typeof d.items !== 'object') d.items = {};
          if (!d.mastered || typeof d.mastered !== 'object') d.mastered = {};
          if (INTERVAL_CHOICES.indexOf(d.interval) === -1) d.interval = DEFAULT_INTERVAL;
          return d;
        }
      }
    } catch (e) { /* fall through */ }
    return { v: 1, interval: DEFAULT_INTERVAL, items: {}, mastered: {} };
  }

  // Runs once at startup: if the review store does not exist yet, carry over
  // questions the student already got wrong in Phases 2–3.
  function initReviewStore() {
    if (safeGet(REVIEW_KEY) === null) safeSet(REVIEW_KEY, JSON.stringify(seedReviewFromProgress()));
  }

  function saveReview(s) {
    safeSet(REVIEW_KEY, JSON.stringify(s));
    updateNavBadge();
  }

  // Every wrong answer lands here (lesson quiz, all-lessons quiz, exam).
  function addWrong(q, lessonId, selected) {
    if (!q || !q.id) return;
    const s = loadReview();
    const now = Date.now();
    const it = s.items[q.id];
    const chosen = Number.isInteger(selected) ? selected : null;
    if (it) {
      it.lastReview = now;
      it.streak = 0;
      it.wrongCount = (it.wrongCount || 0) + 1;
      if (lessonId) it.lessonId = lessonId;
      if (chosen !== null) it.lastWrong = chosen;   // Phase 5: shown (in red) in the PDF report
    } else {
      s.items[q.id] = { lessonId: lessonId, addedAt: now, lastReview: now, streak: 0, wrongCount: 1, lastWrong: chosen };
    }
    delete s.mastered[q.id];
    saveReview(s);
  }

  // Grades one answer given during a scheduled review session.
  // Returns { status: 'mastered' | 'progress' | 'reset', streak }
  function gradeReview(q, lessonId, correct, selected) {
    const s = loadReview();
    const now = Date.now();
    const it = s.items[q.id];

    if (!it) {
      if (!correct) { addWrong(q, lessonId, selected); return { status: 'reset', streak: 0 }; }
      return { status: 'progress', streak: 0 };
    }

    it.lastReview = now;
    if (correct) {
      it.streak = (it.streak || 0) + 1;
      if (it.streak >= MASTER_STREAK) {
        delete s.items[q.id];
        s.mastered[q.id] = now;
        saveReview(s);
        return { status: 'mastered', streak: MASTER_STREAK };
      }
      saveReview(s);
      return { status: 'progress', streak: it.streak };
    }
    it.streak = 0;
    it.wrongCount = (it.wrongCount || 0) + 1;
    if (Number.isInteger(selected)) it.lastWrong = selected;
    saveReview(s);
    return { status: 'reset', streak: 0 };
  }

  function reviewEntries(s) {
    s = s || loadReview();
    const now = Date.now();
    const list = [];
    Object.keys(s.items).forEach(id => {
      const ref = QMAP[id];
      if (!ref) return;
      const it = s.items[id];
      const dueAt = (it.lastReview || 0) + s.interval * HOUR_MS;
      list.push({ id: id, q: ref.q, li: ref.li, item: it, dueAt: dueAt, due: dueAt <= now });
    });
    list.sort((a, b) => a.dueAt - b.dueAt);
    return list;
  }

  function updateNavBadge() {
    const badge = $('#reviewBadge');
    if (!badge) return;
    const due = reviewEntries().filter(e => e.due).length;
    badge.textContent = due > 99 ? '99+' : String(due);
    badge.hidden = due === 0;
  }

  function fmtSpan(ms) {
    const h = Math.max(1, Math.ceil(ms / HOUR_MS));
    if (h < 48) return h + ' ' + t('unitH');
    const d = Math.floor(h / 24);
    const r = h % 24;
    return d + ' ' + t('unitD') + (r ? ' ' + r + ' ' + t('unitH') : '');
  }

  function fmtDate(ts) {
    try {
      return new Date(ts).toLocaleString(currentLang === 'ar' ? 'ar-DZ' : currentLang,
        { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return new Date(ts).toLocaleString();
    }
  }

  /* ---------- Review dashboard ---------- */
  function openReview(focusList) {
    if (!leaveCurrent()) return;
    showView('review');
    renderReview();
    if (focusList) {
      setTimeout(() => {
        const el = $('#rvWrong');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 80);
    }
  }

  function renderReview() {
    const view = $('#reviewView');
    if (!view) return;

    const s = loadReview();
    const entries = reviewEntries(s);
    const due = entries.filter(e => e.due);
    const next = entries.find(e => !e.due);
    const mastered = Object.keys(s.mastered).filter(id => QMAP[id]).length;
    const now = Date.now();
    const deck = deckSet();

    const intervalBtns = INTERVAL_CHOICES.map(h => `
        <button type="button" class="seg-btn${s.interval === h ? ' active' : ''}" data-act="interval" data-h="${h}"
                aria-pressed="${s.interval === h ? 'true' : 'false'}">${esc(t('interval' + h))}</button>`).join('');

    let todayText;
    if (due.length) todayText = fmt(t('dueCount'), { n: due.length });
    else if (!entries.length) todayText = t('noWrongYet');
    else todayText = t('allCaughtUp') + (next ? ' ' + fmt(t('nextReviewIn'), { t: fmtSpan(next.dueAt - now) }) : '');

    const rows = entries.map(e => {
      const streak = Math.min(e.item.streak || 0, MASTER_STREAK);
      let dots = '';
      for (let i = 0; i < MASTER_STREAK; i++) dots += `<span class="rv-dot${i < streak ? ' on' : ''}"></span>`;
      const badge = e.due
        ? `<span class="due-badge"><i class="fa-solid fa-bolt"></i> ${esc(t('dueNow'))}</span>`
        : `<span class="wait-badge"><i class="fa-regular fa-clock"></i> ${esc(fmt(t('dueIn'), { t: fmtSpan(e.dueAt - now) }))}</span>`;
      return `
        <li class="rv-item${e.due ? ' is-due' : ''}">
          <div class="rv-main">
            <span class="q-chip" dir="auto">${esc(t('lesson') + ' ' + (e.li + 1))}</span>
            ${qBadge(e.q)}
            <p class="rv-q" dir="auto">${esc(pickText(e.q, 'question'))}</p>
            <p class="rv-sub"><i class="fa-regular fa-calendar-check"></i> ${esc(t('lastReviewed'))}: ${esc(fmtDate(e.item.lastReview))}</p>
          </div>
          <div class="rv-side">
            ${badge}
            <span class="rv-streak" title="${esc(t('streakLabel'))}: ${streak}/${MASTER_STREAK}">${dots}</span>
            ${flashBtnHtml(e.id, true, deck)}
          </div>
        </li>`;
    }).join('');

    view.innerHTML = `
      <div class="quiz-top">
        <button type="button" class="back-btn" data-act="home">
          <i class="fa-solid fa-house"></i><span>${esc(t('backHome'))}</span>
        </button>
      </div>

      <h2 class="quiz-title" dir="auto">${esc(t('reviewTitle'))}</h2>

      <div class="rv-stats">
        <div class="rv-stat due"><i class="fa-solid fa-bell"></i><strong>${due.length}</strong><span>${esc(t('statDue'))}</span></div>
        <div class="rv-stat wrong"><i class="fa-solid fa-circle-xmark"></i><strong>${entries.length}</strong><span>${esc(t('statWrong'))}</span></div>
        <div class="rv-stat ok"><i class="fa-solid fa-trophy"></i><strong>${mastered}</strong><span>${esc(t('statMastered'))}</span></div>
      </div>

      <section class="rv-card rv-today${due.length ? ' has-due' : ''}">
        <div class="rv-sec-head">
          <h3 class="rv-sec-title"><i class="fa-solid fa-calendar-day"></i> ${esc(t('todayTitle'))}</h3>
          ${due.length ? `<span class="due-badge"><i class="fa-solid fa-bolt"></i> ${esc(t('dueNow'))}</span>` : ''}
        </div>
        <p class="rv-today-text" dir="auto">${esc(todayText)}</p>
        <div class="rv-actions">
          <button type="button" class="nav-step primary" data-act="startReview" ${due.length ? '' : 'disabled'}>
            <i class="fa-solid fa-play"></i><span>${esc(t('startReview'))}</span>
          </button>
          <button type="button" class="nav-step" data-act="practice" ${entries.length ? '' : 'disabled'}>
            <i class="fa-solid fa-dumbbell no-flip"></i><span>${esc(t('practiceAll'))}</span>
          </button>
        </div>
        <p class="rv-note"><i class="fa-solid fa-circle-info"></i> ${esc(t('practiceNote'))}</p>
      </section>

      <section class="rv-card">
        <h3 class="rv-sec-title"><i class="fa-solid fa-hourglass-half"></i> ${esc(t('intervalTitle'))}</h3>
        <div class="seg" role="group" aria-label="${esc(t('intervalTitle'))}">${intervalBtns}</div>
        <p class="rv-note"><i class="fa-solid fa-circle-info"></i> ${esc(t('intervalHint'))}</p>
      </section>

      <section class="rv-card" id="rvWrong">
        <div class="rv-sec-head">
          <h3 class="rv-sec-title"><i class="fa-solid fa-circle-xmark"></i> ${esc(t('wrongListTitle'))}</h3>
          <span class="rv-count">${entries.length}</span>
        </div>
        ${pdfExportHtml(entries.length)}
        ${entries.length ? `<ul class="rv-list">${rows}</ul>` : `<p class="rv-empty" dir="auto">${esc(t('noWrongYet'))}</p>`}
      </section>
    `;
  }

  function setReviewInterval(h) {
    if (INTERVAL_CHOICES.indexOf(h) === -1) return;
    const s = loadReview();
    s.interval = h;
    saveReview(s);
    renderReview();
    showToast(t('intervalSaved'));
  }

  // scored = true  → today's due questions, answers update the schedule.
  // scored = false → practice on every wrong question, schedule untouched.
  function startReview(scored) {
    const pool = reviewEntries().filter(e => (scored ? e.due : true) && isUsableQuestion(e.q));
    if (!pool.length) {
      showToast(t(scored ? 'allCaughtUp' : 'noWrongYet'));
      return;
    }
    const items = shuffle(pool.map(e => ({ q: e.q, li: e.li })));
    quiz = { mode: 'review', scored: !!scored, lessonIdx: -1, items: items, pos: 0, answers: {}, done: false };
    showView('quiz');
    renderQuiz();
  }

  /* =========================================================
     FLASHCARDS  (Phase 4)
     Storage "heartUnit.flashcards": { v:1, cards:[ { id, addedAt } ] }
     ========================================================= */
  function loadDeck() {
    try {
      const raw = safeGet(FLASH_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && typeof d === 'object' && Array.isArray(d.cards)) return d;
      }
    } catch (e) { /* fall through */ }
    return { v: 1, cards: [] };
  }

  function saveDeck(d) { safeSet(FLASH_KEY, JSON.stringify(d)); }

  function deckSet() { return new Set(loadDeck().cards.map(c => c.id)); }

  function deckIds() { return loadDeck().cards.map(c => c.id).filter(id => QMAP[id]); }

  function addToDeck(id) {
    const d = loadDeck();
    if (d.cards.some(c => c.id === id)) return false;
    d.cards.push({ id: id, addedAt: Date.now() });
    saveDeck(d);
    return true;
  }

  function removeFromDeck(id) {
    const d = loadDeck();
    d.cards = d.cards.filter(c => c.id !== id);
    saveDeck(d);
  }

  // "🃏 Convert to Flashcard" button (full or icon-only "mini" version)
  function flashBtnHtml(id, mini, set) {
    const on = (set || deckSet()).has(id);
    return `<button type="button" class="fc-btn${on ? ' added' : ''}${mini ? ' mini' : ''}" data-act="flash" data-qid="${esc(id)}"
              aria-pressed="${on ? 'true' : 'false'}" title="${esc(t(on ? 'inDeck' : 'toFlashcard'))}" aria-label="${esc(t(on ? 'inDeck' : 'toFlashcard'))}">
              <i class="fa-solid ${on ? 'fa-check' : 'fa-clone'}"></i>${mini ? '' : `<span>${esc(t(on ? 'inDeck' : 'toFlashcard'))}</span>`}
            </button>`;
  }

  function syncFlashButtons(id) {
    $$('.fc-btn').forEach(b => {
      if (b.dataset.qid !== id) return;
      b.classList.add('added');
      b.setAttribute('aria-pressed', 'true');
      b.title = t('inDeck');
      const icon = $('i', b);
      if (icon) icon.className = 'fa-solid fa-check';
      const label = $('span', b);
      if (label) label.textContent = t('inDeck');
      b.classList.remove('pop');
      void b.offsetWidth; // restart the pop animation
      b.classList.add('pop');
    });
  }

  function onFlashButton(btn) {
    const id = btn.dataset.qid;
    if (!id || !QMAP[id]) return;
    if (addToDeck(id)) {
      syncFlashButtons(id);
      showToast(t('flashAdded'));
    } else {
      syncFlashButtons(id);
      showToast(t('flashAlready'));
    }
  }

  /* ---------- Flashcards page ---------- */
  let flash = null; // { order: [questionIds], pos }

  function openFlashcards() {
    if (!leaveCurrent()) return;
    flash = { order: deckIds(), pos: 0 };
    showView('flash');
    renderFlash();
  }

  function renderFlash() {
    const view = $('#flashView');
    if (!view) return;
    if (!flash) flash = { order: deckIds(), pos: 0 };

    const live = new Set(deckIds());
    flash.order = flash.order.filter(id => live.has(id));
    const n = flash.order.length;
    if (flash.pos >= n) flash.pos = Math.max(0, n - 1);

    const top = `
      <div class="quiz-top">
        <button type="button" class="back-btn" data-act="home">
          <i class="fa-solid fa-house"></i><span>${esc(t('backHome'))}</span>
        </button>
        ${n ? `<div class="quiz-score"><i class="fa-solid fa-clone"></i><span>${esc(t('card'))}</span>
                 <strong>${flash.pos + 1}</strong><span>/</span><span>${n}</span></div>` : ''}
      </div>
      <h2 class="quiz-title" dir="auto">${esc(t('flashTitle'))}</h2>`;

    if (!n) {
      view.innerHTML = top + `
        <article class="quiz-card fc-empty">
          <div class="fc-empty-icon"><i class="fa-solid fa-clone"></i></div>
          <h3>${esc(t('flashEmpty'))}</h3>
          <p dir="auto">${esc(t('flashEmptyDesc'))}</p>
          <div class="result-actions">
            <button type="button" class="nav-step primary" data-act="home"><i class="fa-solid fa-house"></i><span>${esc(t('backHome'))}</span></button>
          </div>
        </article>`;
      return;
    }

    const ref = QMAP[flash.order[flash.pos]];
    const q = ref.q;
    const opts = pickList(q, 'options');
    const letter = i => LETTERS[i] || (i + 1);
    const optsHtml = opts.map((o, i) => o
      ? `<li><span class="opt-letter">${letter(i)}</span><span class="fc-opt-text" dir="auto">${esc(o)}</span></li>`
      : '').join('');
    const correctText = opts[q.correctIndex] || '';
    const explanation = pickText(q, 'explanation');
    const chip = `<span class="q-chip" dir="auto">${esc(t('lesson') + ' ' + (ref.li + 1) + ' · ' + lessonTitle(LESSONS[ref.li], ref.li))}</span>`;
    const pct = Math.round(((flash.pos + 1) / n) * 100);

    view.innerHTML = top + `
      <div class="qbar" aria-hidden="true"><span style="width:${pct}%"></span></div>

      <div class="fc-stage">
        <div class="fc-card" id="fcCard" role="button" tabindex="0" aria-pressed="false" aria-label="${esc(t('flashFlipLabel'))}">
          <div class="fc-inner">
            <div class="fc-face fc-front">
              <div class="fc-meta">${chip}<span class="fc-tag"><i class="fa-solid fa-circle-question"></i> ${esc(t('flashQuestion'))}</span></div>
              ${qBadge(q)}
              <h3 class="fc-q" dir="auto">${esc(pickText(q, 'question'))}</h3>
              ${optsHtml ? `<ul class="fc-opts">${optsHtml}</ul>` : ''}
              <p class="fc-hint"><i class="fa-solid fa-rotate"></i> ${esc(t('flashFlipHint'))}</p>
            </div>
            <div class="fc-face fc-back">
              <div class="fc-meta">${chip}<span class="fc-tag ok"><i class="fa-solid fa-circle-check"></i> ${esc(t('flashAnswer'))}</span></div>
              <div class="fc-answer">
                <span class="opt-letter">${letter(q.correctIndex)}</span>
                <div><small>${esc(t('examCorrectAnswer'))}</small><p dir="auto">${esc(correctText)}</p></div>
              </div>
              ${explanation ? `<div class="fc-expl"><h4><i class="fa-solid fa-lightbulb"></i> ${esc(t('examExplanation'))}</h4>${explBadge(q)}<p dir="auto">${esc(explanation)}</p></div>` : ''}
              <p class="fc-hint"><i class="fa-solid fa-rotate"></i> ${esc(t('flashFlipHint'))}</p>
            </div>
          </div>
        </div>
      </div>

      <div class="fc-controls">
        <button type="button" class="nav-step" data-act="fprev" ${n < 2 ? 'disabled' : ''}>
          <i class="fa-solid fa-arrow-left"></i><span>${esc(t('previous'))}</span>
        </button>
        <button type="button" class="nav-step primary" data-act="fnext" ${n < 2 ? 'disabled' : ''}>
          <span>${esc(t('next'))}</span><i class="fa-solid fa-arrow-right"></i>
        </button>
        <button type="button" class="nav-step" data-act="fshuffle" ${n < 2 ? 'disabled' : ''}>
          <i class="fa-solid fa-shuffle no-flip"></i><span>${esc(t('shuffle'))}</span>
        </button>
        <button type="button" class="nav-step danger" data-act="fremove">
          <i class="fa-solid fa-trash-can no-flip"></i><span>${esc(t('removeFromDeck'))}</span>
        </button>
      </div>
    `;
  }

  function flipCard() {
    const card = $('#fcCard');
    if (!card) return;
    const on = card.classList.toggle('flipped');
    card.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function flashStep(d) {
    if (!flash || flash.order.length < 2) return;
    const n = flash.order.length;
    flash.pos = (flash.pos + d + n) % n;
    renderFlash();
  }

  function flashShuffle() {
    if (!flash || flash.order.length < 2) return;
    shuffle(flash.order);
    flash.pos = 0;
    renderFlash();
    showToast(t('flashShuffled'));
  }

  function flashRemove() {
    if (!flash || !flash.order.length) return;
    const id = flash.order[flash.pos];
    removeFromDeck(id);
    flash.order.splice(flash.pos, 1);
    showToast(t('flashRemoved'));
    renderFlash();
  }

  function handleFlashKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const onButton = e.target.closest && e.target.closest('button');
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const rtl = document.documentElement.dir === 'rtl';
      const forward = (e.key === 'ArrowRight') !== rtl;
      e.preventDefault();
      flashStep(forward ? 1 : -1);
    } else if ((e.key === ' ' || e.key === 'Enter') && !onButton) {
      e.preventDefault();
      flipCard();
    }
  }

  /* =========================================================
     ANNOTATIONS  (Phase 5)
     One localStorage entry per question:  "heartUnit.ann.<questionId>"
     {
       v: 1,
       hl:      [ { g: 'q'|'o0'..'o7', s, e, c: 'yellow'|'green'|'blue', n } ],
                  // g = text segment, s/e = character range, n = length of the
                  // text it was made on (so a range never lands on a different
                  // language's text)
       strokes: [ { c: '#hex', w: width/areaWidth, e: 0|1, p: [[x,y],...] } ],
                  // x/y are 0..1 fractions of the question area → resolution independent
       note:    'personal note',
       updated: timestamp
     }
     ========================================================= */
  function annLoad(id) {
    const empty = { hl: [], strokes: [], note: '', updated: 0 };
    try {
      const raw = safeGet(ANN_PREFIX + id);
      if (!raw) return empty;
      const d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return empty;
      return {
        hl: Array.isArray(d.hl) ? d.hl.filter(r => r && typeof r.g === 'string' && Number.isFinite(r.s) && Number.isFinite(r.e)) : [],
        strokes: Array.isArray(d.strokes) ? d.strokes.filter(s => s && Array.isArray(s.p) && s.p.length) : [],
        note: typeof d.note === 'string' ? d.note : '',
        updated: d.updated || 0
      };
    } catch (e) {
      return empty;
    }
  }

  function annHas(id) { return safeGet(ANN_PREFIX + id) !== null; }

  // Returns true on success (false = storage full / blocked).
  function annStore(id, a) {
    try {
      const empty = !a.hl.length && !a.strokes.length && !a.note.trim();
      if (empty) localStorage.removeItem(ANN_PREFIX + id);
      else localStorage.setItem(ANN_PREFIX + id, JSON.stringify({ v: 1, hl: a.hl, strokes: a.strokes, note: a.note, updated: Date.now() }));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------- Highlights: ranges <-> HTML ---------- */
  function hlColorsFor(ranges, seg, text) {
    const arr = new Array(text.length).fill(null);
    (ranges || []).forEach(r => {
      if (r.g !== seg || r.n !== text.length) return;
      const s = Math.max(0, r.s);
      const e = Math.min(text.length, r.e);
      for (let i = s; i < e; i++) arr[i] = (r.c === 'none') ? null : r.c;
    });
    return arr;
  }

  function segHtml(text, ranges, seg) {
    if (!ranges || !ranges.length || !text) return esc(text);
    const arr = hlColorsFor(ranges, seg, text);
    let out = '';
    let i = 0;
    while (i < text.length) {
      const c = arr[i];
      let j = i + 1;
      while (j < text.length && arr[j] === c) j++;
      const chunk = esc(text.slice(i, j));
      out += (c && HL_COLORS.indexOf(c) !== -1) ? `<mark class="hl hl-${c}">${chunk}</mark>` : chunk;
      i = j;
    }
    return out;
  }

  // Merges overlapping / "remove" ranges into a clean list before saving.
  function annCompact(ranges, texts) {
    const out = [];
    const segs = Object.keys(texts);
    // ranges made on another language's text are kept untouched
    ranges.forEach(r => {
      const text = texts[r.g];
      if (text === undefined || text.length !== r.n) out.push(r);
    });
    segs.forEach(g => {
      const text = texts[g];
      if (!text) return;
      const arr = hlColorsFor(ranges, g, text);
      let i = 0;
      while (i < text.length) {
        const c = arr[i];
        let j = i + 1;
        while (j < text.length && arr[j] === c) j++;
        if (c) out.push({ g: g, s: i, e: j, c: c, n: text.length });
        i = j;
      }
    });
    return out;
  }

  function annSegTexts(q) {
    const texts = { q: pickText(q, 'question') };
    pickList(q, 'options').forEach((o, i) => { texts['o' + i] = o; });
    return texts;
  }

  /* ---------- State ---------- */
  function annEditingFor(id) { return !!(annot && annot.editing && annot.qid === id); }
  function annData(id) { return annEditingFor(id) ? annot.draft : annLoad(id); }

  /* ---------- Markup ---------- */
  function annotBtnHtml(id) {
    const has = annHas(id);
    const on = annEditingFor(id);
    return `<button type="button" class="ann-btn${has ? ' has' : ''}${on ? ' on' : ''}" data-aact="toggle" aria-expanded="${on ? 'true' : 'false'}">
              <span>${esc(t('annotBtn'))}</span>${has ? '<i class="ann-dot" aria-hidden="true"></i>' : ''}
            </button>`;
  }

  function annotNoteHtml(id) {
    const note = annLoad(id).note.trim();
    return `<div class="annot-note-view" id="annotNoteWrap"${note ? '' : ' hidden'}>
              <i class="fa-solid fa-note-sticky" aria-hidden="true"></i>
              <div><small>${esc(t('annotMyNote'))}</small><p dir="auto">${esc(note)}</p></div>
            </div>`;
  }

  function annotEditorHtml() {
    const hlSw = ['yellow', 'green', 'blue'].map(c => {
      const label = t('annot' + c.charAt(0).toUpperCase() + c.slice(1));
      return `<button type="button" class="ae-swatch sw-${c}" data-aact="hlcolor" data-c="${c}" title="${esc(label)}" aria-label="${esc(label)}"></button>`;
    }).join('');
    const penSw = PEN_PRESETS.map(c =>
      `<button type="button" class="ae-swatch" style="--sw:${c}" data-aact="pencolor" data-c="${c}" aria-label="${c}"></button>`).join('');

    return `
      <div class="annot-editor" id="annotEditor" data-tool="hl" hidden>
        <div class="ae-head">
          <h4><i class="fa-solid fa-pen-to-square"></i> ${esc(t('annotTitle'))}</h4>
        </div>

        <div class="ae-tabs" role="group" aria-label="${esc(t('annotTitle'))}">
          <button type="button" class="ae-tab" data-aact="tool" data-tool="hl"><i class="fa-solid fa-highlighter"></i><span>${esc(t('annotToolHl'))}</span></button>
          <button type="button" class="ae-tab" data-aact="tool" data-tool="pen"><i class="fa-solid fa-pencil"></i><span>${esc(t('annotToolPen'))}</span></button>
          <button type="button" class="ae-tab" data-aact="tool" data-tool="erase"><i class="fa-solid fa-eraser"></i><span>${esc(t('annotToolErase'))}</span></button>
        </div>

        <p class="ae-hint" id="aeHint" dir="auto"></p>

        <div class="ae-ctx ae-ctx-hl">
          <div class="ae-swatches">${hlSw}</div>
          <button type="button" class="ae-mini" data-aact="hlcolor" data-c="none"><i class="fa-solid fa-ban"></i><span>${esc(t('annotNoHl'))}</span></button>
        </div>

        <div class="ae-ctx ae-ctx-draw">
          <div class="ae-field ae-pen-only">
            <span class="ae-label">${esc(t('annotColor'))}</span>
            <div class="ae-swatches">${penSw}<input type="color" id="aePenColor" class="ae-color" value="${PEN_PRESETS[0]}" aria-label="${esc(t('annotColor'))}" /></div>
          </div>
          <div class="ae-field">
            <label class="ae-label" for="aeSize">${esc(t('annotSize'))}</label>
            <div class="ae-range"><input type="range" id="aeSize" min="1" max="24" step="1" value="4" /><output id="aeSizeOut">4</output></div>
          </div>
        </div>

        <div class="ae-row">
          <button type="button" class="ae-mini" data-aact="undo" id="aeUndo"><i class="fa-solid fa-rotate-left no-flip"></i><span>${esc(t('annotUndo'))}</span></button>
          <button type="button" class="ae-mini" data-aact="clearDraw"><i class="fa-solid fa-trash-can no-flip"></i><span>${esc(t('annotClearDraw'))}</span></button>
          <button type="button" class="ae-mini" data-aact="clearHl"><i class="fa-solid fa-broom no-flip"></i><span>${esc(t('annotClearHl'))}</span></button>
        </div>

        <label class="ae-label ae-note-label" for="aeNote">${esc(t('annotNote'))}</label>
        <textarea id="aeNote" class="ae-note" rows="3" maxlength="2000" dir="auto" placeholder="${esc(t('annotNotePh'))}"></textarea>

        <div class="ae-foot">
          <button type="button" class="nav-step" data-aact="cancel"><i class="fa-solid fa-xmark no-flip"></i><span>${esc(t('annotCancel'))}</span></button>
          <button type="button" class="nav-step primary" data-aact="save"><i class="fa-solid fa-floppy-disk no-flip"></i><span>${esc(t('annotSave'))}</span></button>
        </div>
      </div>`;
  }

  // Question text + options + drawing canvas (the part the annotations live on).
  function annotAreaInner(q, editing) {
    const opts = pickList(q, 'options');
    const isExam = !!quiz && quiz.mode === 'exam';
    const ans = quiz ? quiz.answers[q.id] : null;
    const ranges = annData(q.id).hl;

    const optsHtml = opts.map((text, i) => {
      let cls = '';
      let icon = 'fa-check';
      if (isExam) {
        if (ans && ans.selected === i) cls = ' selected';
      } else {
        const st = optionState(i, q, ans);
        cls = st.cls ? ' ' + st.cls : '';
        icon = st.icon;
        if (ans && !editing) cls += ' locked';
      }
      const inner = `
          <span class="opt-letter">${LETTERS[i] || i + 1}</span>
          <span class="opt-text" dir="auto" data-seg="o${i}">${segHtml(text, ranges, 'o' + i)}</span>
          <span class="opt-icon"><i class="fa-solid ${icon}"></i></span>`;
      if (editing) return `<div class="option annot-opt${cls}" data-idx="${i}">${inner}</div>`;
      if (isExam) return `<button type="button" class="option${cls}" data-idx="${i}" aria-pressed="${cls.indexOf('selected') !== -1 ? 'true' : 'false'}">${inner}</button>`;
      return `<button type="button" class="option${cls}" data-idx="${i}">${inner}</button>`;
    }).join('');

    return `
        ${qBadge(q)}
        <h3 class="q-text" dir="auto" data-seg="q">${segHtml(pickText(q, 'question'), ranges, 'q')}</h3>
        <div class="options" id="options" role="group">${optsHtml}</div>
        <canvas class="annot-canvas" id="annotCanvas" aria-hidden="true"></canvas>`;
  }

  function annotAreaHtml(q) {
    return `<div class="annot-area" id="annotArea">${annotAreaInner(q, annEditingFor(q.id))}</div>`;
  }

  /* ---------- Canvas ---------- */
  function annSetupCanvas(strokes) {
    annShown = strokes || [];
    const area = $('#annotArea');
    if (annRO) { annRO.disconnect(); annRO = null; }
    if (!area) return;
    annFit();
    if (window.ResizeObserver) {
      annRO = new ResizeObserver(() => annFit());
      annRO.observe(area);
    }
  }

  function annFit() {
    const area = $('#annotArea');
    const cv = $('#annotCanvas');
    if (!area || !cv) return;
    const r = area.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    annRedraw();
  }

  function annStrokeStyle(ctx, s, W) {
    ctx.globalCompositeOperation = s.e ? 'destination-out' : 'source-over';
    ctx.strokeStyle = s.e ? '#000' : (s.c || '#ff4757');
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = Math.max(1, (s.w || 0.005) * W);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function annDrawStroke(ctx, s, W, H) {
    const p = s.p;
    if (!p || !p.length) return;
    ctx.save();
    annStrokeStyle(ctx, s, W);
    if (p.length === 1) {
      ctx.beginPath();
      ctx.arc(p[0][0] * W, p[0][1] * H, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(p[0][0] * W, p[0][1] * H);
      for (let i = 1; i < p.length - 1; i++) {
        const mx = ((p[i][0] + p[i + 1][0]) / 2) * W;
        const my = ((p[i][1] + p[i + 1][1]) / 2) * H;
        ctx.quadraticCurveTo(p[i][0] * W, p[i][1] * H, mx, my);
      }
      const l = p[p.length - 1];
      ctx.lineTo(l[0] * W, l[1] * H);
      ctx.stroke();
    }
    ctx.restore();
  }

  function annRedraw() {
    const cv = $('#annotCanvas');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    annShown.forEach(s => annDrawStroke(ctx, s, cv.width, cv.height));
  }

  function annPt(e, cv) {
    const r = cv.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return [Number(x.toFixed(4)), Number(y.toFixed(4))];
  }

  function annPointerDown(e) {
    const cv = e.target.closest && e.target.closest('#annotCanvas');
    if (!cv || !annot || !annot.editing || annPrefs.tool === 'hl') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const r = cv.getBoundingClientRect();
    const erase = annPrefs.tool === 'erase';
    const size = annPrefs.size * (erase ? 3 : 1);
    const s = { c: annPrefs.penColor, w: Number((size / r.width).toFixed(5)), e: erase ? 1 : 0, p: [annPt(e, cv)] };
    annDrawing = { s: s, id: e.pointerId, cv: cv };
    const ctx = cv.getContext('2d');
    annDrawStroke(ctx, s, cv.width, cv.height);
  }

  function annPointerMove(e) {
    if (!annDrawing || e.pointerId !== annDrawing.id) return;
    const cv = annDrawing.cv;
    if (!cv.isConnected) { annDrawing = null; return; }
    const s = annDrawing.s;
    const r = cv.getBoundingClientRect();
    const pt = annPt(e, cv);
    const last = s.p[s.p.length - 1];
    if (Math.abs(pt[0] - last[0]) * r.width < 1.2 && Math.abs(pt[1] - last[1]) * r.height < 1.2) return;
    s.p.push(pt);
    // draw only the new segment (fast); the full smooth redraw happens on pointer-up
    const ctx = cv.getContext('2d');
    ctx.save();
    annStrokeStyle(ctx, s, cv.width);
    ctx.beginPath();
    ctx.moveTo(last[0] * cv.width, last[1] * cv.height);
    ctx.lineTo(pt[0] * cv.width, pt[1] * cv.height);
    ctx.stroke();
    ctx.restore();
  }

  function annPointerUp(e) {
    if (!annDrawing || e.pointerId !== annDrawing.id) return;
    const s = annDrawing.s;
    annDrawing = null;
    if (!annot || !annot.editing) return;
    annot.draft.strokes.push(s);
    annot.dirty = true;
    annRedraw();
    annSyncUi();
  }

  /* ---------- Highlighting ---------- */
  function annOffsetIn(el, node, offset) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.setEnd(node, offset);
    return r.toString().length;
  }

  // Colors the current text selection (or removes color when color === 'none').
  function annApplySelection(color) {
    if (!annot || !annot.editing) return false;
    const sel = window.getSelection ? window.getSelection() : null;
    if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const area = $('#annotArea');
    if (!area || !area.contains(range.commonAncestorContainer)) return false;

    const texts = annSegTexts(annot.q);
    let changed = false;
    $$('[data-seg]', area).forEach(el => {
      if (!range.intersectsNode(el)) return;
      const seg = el.dataset.seg;
      const text = texts[seg];
      if (!text) return;
      let s = 0;
      let e = text.length;
      if (el.contains(range.startContainer)) s = annOffsetIn(el, range.startContainer, range.startOffset);
      if (el.contains(range.endContainer)) e = annOffsetIn(el, range.endContainer, range.endOffset);
      if (e > s) {
        annot.draft.hl.push({ g: seg, s: s, e: e, c: color, n: text.length });
        changed = true;
      }
    });

    if (changed) {
      sel.removeAllRanges();
      annot.dirty = true;
      annRefreshArea(annot.q);
      annSyncUi();
    }
    return changed;
  }

  /* ---------- Editor open / save / cancel ---------- */
  function annRefreshArea(q) {
    const area = $('#annotArea');
    if (!area) return;
    area.innerHTML = annotAreaInner(q, annEditingFor(q.id));
    annSetupCanvas(annData(q.id).strokes);
  }

  function annSyncUi() {
    const ed = $('#annotEditor');
    if (!ed) return;
    const on = !!(annot && annot.editing);
    ed.hidden = !on;

    const area = $('#annotArea');
    if (area) {
      area.classList.toggle('is-editing', on);
      area.classList.toggle('is-drawing', on && annPrefs.tool !== 'hl');
    }
    const tb = $('[data-aact="toggle"]');
    if (tb) {
      tb.classList.toggle('on', on);
      tb.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
    if (!on) return;

    ed.dataset.tool = annPrefs.tool;
    $$('[data-aact="tool"]', ed).forEach(b => b.classList.toggle('active', b.dataset.tool === annPrefs.tool));
    $$('[data-aact="hlcolor"]', ed).forEach(b => b.classList.toggle('active', b.dataset.c === annPrefs.hlColor));
    $$('[data-aact="pencolor"]', ed).forEach(b => b.classList.toggle('active', b.dataset.c.toLowerCase() === annPrefs.penColor.toLowerCase()));

    const pc = $('#aePenColor');
    if (pc && pc.value.toLowerCase() !== annPrefs.penColor.toLowerCase()) pc.value = annPrefs.penColor;
    const sz = $('#aeSize');
    if (sz && Number(sz.value) !== annPrefs.size) sz.value = annPrefs.size;
    const so = $('#aeSizeOut');
    if (so) so.textContent = annPrefs.size;

    const hint = $('#aeHint');
    if (hint) hint.textContent = t(annPrefs.tool === 'hl' ? 'annotHlHint' : (annPrefs.tool === 'pen' ? 'annotDrawHint' : 'annotEraseHint'));
    const undo = $('#aeUndo');
    if (undo) undo.disabled = !annot.draft.strokes.length;
  }

  function annOpen() {
    if (!quiz || quiz.done) return;
    const q = quiz.items[quiz.pos].q;
    if (annEditingFor(q.id)) { annCancel(); return; }
    const saved = annLoad(q.id);
    annot = {
      qid: q.id,
      q: q,
      editing: true,
      dirty: false,
      draft: { hl: saved.hl.slice(), strokes: saved.strokes.slice(), note: saved.note }
    };
    annRefreshArea(q);
    const ta = $('#aeNote');
    if (ta) ta.value = annot.draft.note;
    annSyncUi();
    const ed = $('#annotEditor');
    if (ed) setTimeout(() => ed.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
  }

  // Writes the draft to localStorage. Returns true on success.
  function annSave() {
    if (!annot) return true;
    const texts = annSegTexts(annot.q);
    const data = {
      hl: annCompact(annot.draft.hl, texts),
      strokes: annot.draft.strokes,
      note: (annot.draft.note || '').trim()
    };
    if (!annStore(annot.qid, data)) {
      showToast(t('annotFailed'));
      return false;
    }
    annot.dirty = false;
    return true;
  }

  // After the editor closes: repaint the question with the saved state.
  function annCloseUi(q) {
    annRefreshArea(q);
    annSyncUi();
    const btn = $('[data-aact="toggle"]');
    if (btn) btn.outerHTML = annotBtnHtml(q.id);
    const nv = $('#annotNoteWrap');
    if (nv) nv.outerHTML = annotNoteHtml(q.id);
  }

  function annSaveClick() {
    if (!annot) return;
    const q = annot.q;
    if (!annSave()) return;
    annot = null;
    annCloseUi(q);
    showToast(t('annotSaved'));
  }

  function annCancel() {
    if (!annot) return;
    if (annot.dirty && !window.confirm(t('annotDiscardConfirm'))) return;
    const q = annot.q;
    annot = null;
    annDrawing = null;
    annCloseUi(q);
  }

  // Called whenever the student leaves the question: unsaved edits are kept, never lost.
  function annFlush() {
    annDrawing = null;
    if (annot && annot.dirty && annSave()) showToast(t('annotAutoSaved'));
    annot = null;
    if (annRO) { annRO.disconnect(); annRO = null; }
  }

  // Runs at the start of every quiz render.
  function annEnsure() {
    if (!annot) return;
    const keep = quiz && !quiz.done && quiz.items[quiz.pos] && quiz.items[quiz.pos].q.id === annot.qid;
    if (!keep) annFlush();
  }

  function annAfterRender(q) {
    annSetupCanvas(annData(q.id).strokes);
    if (annEditingFor(q.id)) {
      annot.q = q;
      const ta = $('#aeNote');
      if (ta) ta.value = annot.draft.note;
    }
    annSyncUi();
  }

  function annAction(el) {
    const act = el.dataset.aact;
    if (act === 'toggle') { annOpen(); return; }
    if (!annot || !annot.editing) return;

    switch (act) {
      case 'tool':
        annPrefs.tool = el.dataset.tool;
        annSyncUi();
        break;
      case 'hlcolor':
        annPrefs.hlColor = el.dataset.c;
        annPrefs.tool = 'hl';
        annApplySelection(annPrefs.hlColor);   // a selection that already exists gets colored right away
        annSyncUi();
        break;
      case 'pencolor':
        annPrefs.penColor = el.dataset.c;
        if (annPrefs.tool !== 'pen') annPrefs.tool = 'pen';
        annSyncUi();
        break;
      case 'undo':
        if (annot.draft.strokes.length) {
          annot.draft.strokes.pop();
          annot.dirty = true;
          annRedraw();
          annSyncUi();
        }
        break;
      case 'clearDraw':
        if (annot.draft.strokes.length) {
          annot.draft.strokes.length = 0;
          annot.dirty = true;
          annRedraw();
          annSyncUi();
        }
        break;
      case 'clearHl':
        if (annot.draft.hl.length) {
          annot.draft.hl = [];
          annot.dirty = true;
          annRefreshArea(annot.q);
          annSyncUi();
        }
        break;
      case 'save': annSaveClick(); break;
      case 'cancel': annCancel(); break;
      default: break;
    }
  }

  function initAnnotations() {
    const view = $('#quizView');
    if (!view) return;

    view.addEventListener('click', e => {
      const el = e.target.closest && e.target.closest('[data-aact]');
      if (el && !el.disabled) annAction(el);
    });

    // Keep the text selection alive when a toolbar button is pressed.
    view.addEventListener('mousedown', e => {
      const el = e.target.closest && e.target.closest('[data-aact]');
      if (el) e.preventDefault();
      annMouseDown = true;
    });
    document.addEventListener('mouseup', () => { annMouseDown = false; });

    view.addEventListener('input', e => {
      if (!annot || !annot.editing) return;
      const id = e.target.id;
      if (id === 'aeNote') {
        annot.draft.note = e.target.value;
        annot.dirty = true;
      } else if (id === 'aePenColor') {
        annPrefs.penColor = e.target.value;
        if (annPrefs.tool === 'erase') annPrefs.tool = 'pen';
        annSyncUi();
      } else if (id === 'aeSize') {
        annPrefs.size = Math.max(1, Math.min(24, Number(e.target.value) || 4));
        annSyncUi();
      }
    });

    // Freehand drawing
    view.addEventListener('pointerdown', annPointerDown);
    view.addEventListener('pointermove', annPointerMove);
    view.addEventListener('pointerup', annPointerUp);
    view.addEventListener('pointercancel', annPointerUp);

    // Highlighting: mouse → right after the drag ends; touch → once the selection settles.
    view.addEventListener('mouseup', e => {
      if (!annot || !annot.editing || annPrefs.tool !== 'hl') return;
      if (!e.target.closest || !e.target.closest('#annotArea')) return;
      setTimeout(() => annApplySelection(annPrefs.hlColor), 10);
    });
    document.addEventListener('selectionchange', () => {
      if (!annot || !annot.editing || annPrefs.tool !== 'hl') return;
      clearTimeout(annSelTimer);
      annSelTimer = setTimeout(() => {
        if (!annMouseDown && annot && annot.editing && annPrefs.tool === 'hl') annApplySelection(annPrefs.hlColor);
      }, 650);
    });

    // Never lose unsaved work when the tab closes.
    window.addEventListener('pagehide', () => { if (annot && annot.dirty) annSave(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && annot && annot.dirty) annSave();
    });
  }

  /* =========================================================
     PDF EXPORT  (Phase 5)
     jsPDF's built-in fonts have no Arabic glyphs and no text shaping, so Arabic
     would come out as broken boxes. Instead each question is laid out as a
     real HTML card (browser shaping + RTL), rasterised with html2canvas,
     and the images are placed on A4 pages with jsPDF.
     Both libraries are loaded from the CDN the first time they are needed.
     ========================================================= */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { s.remove(); reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  async function ensurePdfLibs() {
    if (!(window.jspdf && window.jspdf.jsPDF)) await loadScript(PDF_LIBS.jspdf);
    if (typeof window.html2canvas !== 'function') await loadScript(PDF_LIBS.html2canvas);
    if (!(window.jspdf && window.jspdf.jsPDF) || typeof window.html2canvas !== 'function') {
      throw new Error('PDF libraries unavailable');
    }
  }

  function pdfExportHtml(count) {
    return `
        <div class="rv-export">
          <button type="button" class="nav-step primary" id="pdfBtn" data-act="exportPdf" ${count && !pdfBusy ? '' : 'disabled'}>
            <i class="fa-solid ${pdfBusy ? 'fa-spinner fa-spin' : 'fa-file-pdf'} no-flip"></i>
            <span>${esc(t(pdfBusy ? 'pdfGenerating' : 'pdfBtn'))}</span>
          </button>
          <p class="rv-note"><i class="fa-solid fa-circle-info"></i> ${esc(t('pdfNoteHint'))}</p>
        </div>`;
  }

  function setPdfBusy(on) {
    pdfBusy = on;
    const btn = $('#pdfBtn');
    if (!btn) return;
    btn.disabled = on;
    const icon = $('i', btn);
    const label = $('span', btn);
    if (icon) icon.className = 'fa-solid ' + (on ? 'fa-spinner fa-spin' : 'fa-file-pdf') + ' no-flip';
    if (label) label.textContent = t(on ? 'pdfGenerating' : 'pdfBtn');
  }

  // 'rtl' when the text is mostly Arabic-script, otherwise 'ltr'.
  function pdfDirOf(text) {
    const s = String(text || '');
    const ar = (s.match(/[\u0600-\u06FF\u0750-\u077F]/g) || []).length;
    const la = (s.match(/[A-Za-z\u00C0-\u024F]/g) || []).length;
    return ar > la ? 'rtl' : 'ltr';
  }

  function pdfText(html, plain, cls) {
    const d = pdfDirOf(plain);
    return `<div class="${cls || ''} pdf-${d}" dir="${d}">${html}</div>`;
  }

  function pdfDateLabel(d) {
    try {
      const loc = currentLang === 'ar' ? 'ar-DZ-u-nu-latn' : currentLang;
      return d.toLocaleDateString(loc, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) {
      return d.toLocaleDateString();
    }
  }

  function pdfFileDate(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function pdfStyleCss() {
    return `
      .pdf-host { position: fixed; left: -10000px; top: 0; width: 760px; background: #fff; color: #1b0a0d;
        font-family: 'Cairo', 'Poppins', 'Segoe UI', Tahoma, Arial, sans-serif; letter-spacing: 0; line-height: 1.6; z-index: -1; }
      .pdf-host * { box-sizing: border-box; letter-spacing: 0; }
      .pdf-host .pdf-rtl { direction: rtl; text-align: right; }
      .pdf-host .pdf-ltr { direction: ltr; text-align: left; }
      .pdf-host .pdf-block { width: 760px; padding: 18px 26px; background: #fff; }
      .pdf-host .pdf-head { padding: 28px 30px; background: linear-gradient(135deg, #8B0000, #C41E3A); color: #fff; border-bottom: 5px solid #FFD700; }
      .pdf-host .pdf-brand { font-size: 13px; font-weight: 700; color: #FFD700; margin-bottom: 6px; }
      .pdf-host .pdf-head h1 { font-size: 27px; font-weight: 900; line-height: 1.35; margin: 0 0 12px; }
      .pdf-host .pdf-meta { display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 14px; font-weight: 600; color: #ffe9a8; }
      .pdf-host .pdf-card { border: 1.5px solid #e6c9ce; border-radius: 14px; padding: 16px 18px; background: #fffafa; }
      .pdf-host .pdf-qhead { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-bottom: 10px; }
      .pdf-host .pdf-num { min-width: 32px; height: 32px; padding: 0 9px; border-radius: 16px; background: #C41E3A; color: #fff;
        font-weight: 800; font-size: 14px; line-height: 32px; text-align: center; }
      .pdf-host .pdf-chip { font-size: 12.5px; font-weight: 700; color: #7a4b00; background: #fff3c4; border: 1px solid #f0d36b; border-radius: 999px; padding: 2px 12px; }
      .pdf-host .pdf-page { font-size: 12.5px; font-weight: 700; color: #5a3a40; background: #f3e6e8; border-radius: 999px; padding: 2px 12px; }
      .pdf-host .pdf-qtext { font-size: 16.5px; font-weight: 700; line-height: 1.65; margin-bottom: 12px; white-space: pre-line; }
      .pdf-host .pdf-ans { border: 1.5px solid; border-radius: 10px; padding: 8px 14px; margin-bottom: 8px; font-size: 14.5px; line-height: 1.6; }
      .pdf-host .pdf-ans small, .pdf-host .pdf-expl small, .pdf-host .pdf-note small { display: block; font-size: 11.5px; font-weight: 800; text-transform: uppercase; margin-bottom: 2px; }
      .pdf-host .pdf-bad { background: #fdecee; border-color: #e11d48; color: #9b0f20; }
      .pdf-host .pdf-ok { background: #e8f8ee; border-color: #16a34a; color: #0f5d2c; }
      .pdf-host .pdf-expl { background: #f6f1f2; border-radius: 10px; padding: 8px 14px; margin-bottom: 8px; font-size: 14px; color: #3a2024; }
      .pdf-host .pdf-note { background: #fff8db; border: 1.5px solid #e0b400; border-radius: 10px; padding: 8px 14px; font-size: 14px; color: #5a4300; white-space: pre-line; }
      .pdf-host .pdf-tu { display: inline-block; font-size: 11.5px; font-weight: 700; color: #7a4b00; background: #fff3c4; border: 1px dashed #d4a72c; border-radius: 999px; padding: 1px 10px; margin-bottom: 8px; }
      .pdf-host mark.hl { color: #1a0006; border-radius: 4px; padding: 0 2px; }
      .pdf-host mark.hl-yellow { background: #ffe14d; }
      .pdf-host mark.hl-green { background: #6ee7a0; }
      .pdf-host mark.hl-blue { background: #8ccbff; }`;
  }

  function pdfBlockHtml(e, n, answers) {
    const q = e.q;
    const opts = pickList(q, 'options');
    const letter = i => LETTERS[i] || (i + 1);
    const qPlain = pickText(q, 'question');
    const ann = annLoad(q.id);

    let sel = Number.isInteger(e.item.lastWrong) ? e.item.lastWrong : null;
    if (sel === null) {
      const a = answers[e.id];
      if (a && a.correct === false && Number.isInteger(a.selected)) sel = a.selected;
    }
    const hasSel = sel !== null && opts[sel] !== undefined;
    const yourPlain = hasSel ? letter(sel) + '. ' + opts[sel] : t('pdfNotRecorded');
    const okPlain = letter(q.correctIndex) + '. ' + (opts[q.correctIndex] || '');
    const yourHtml = hasSel ? '<strong>' + esc(letter(sel)) + '.</strong> ' + esc(opts[sel]) : esc(yourPlain);
    const expl = pickText(q, 'explanation');
    const hasPage = q.pageNumber !== null && q.pageNumber !== undefined && q.pageNumber !== '';
    const note = ann.note.trim();
    const uiDir = document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr';

    return `
      <div class="pdf-block pdf-${uiDir}" dir="${uiDir}">
        <div class="pdf-card">
          <div class="pdf-qhead">
            <span class="pdf-num">${n}</span>
            <span class="pdf-chip">${esc(t('lesson') + ' ' + (e.li + 1) + ' · ' + lessonTitle(LESSONS[e.li], e.li))}</span>
            <span class="pdf-page">${esc(t('pdfLessonPage'))}: ${esc(hasPage ? q.pageNumber : t('pageUnknown'))}</span>
          </div>
          ${qBadge(q) ? `<div class="pdf-tu">${esc(t('translationUnavailable'))}</div>` : ''}
          ${pdfText(segHtml(qPlain, ann.hl, 'q'), qPlain, 'pdf-qtext')}
          <div class="pdf-ans pdf-bad"><small>${esc(t('examYourAnswer'))}</small>${pdfText(yourHtml, yourPlain, '')}</div>
          <div class="pdf-ans pdf-ok"><small>${esc(t('examCorrectAnswer'))}</small>${pdfText('<strong>' + esc(letter(q.correctIndex)) + '.</strong> ' + esc(opts[q.correctIndex] || ''), okPlain, '')}</div>
          ${expl ? `<div class="pdf-expl"><small>${esc(t('examExplanation'))}</small>${pdfText(esc(expl), expl, '')}</div>` : ''}
          ${note ? `<div class="pdf-note"><small>${esc(t('annotMyNote'))}</small>${pdfText(esc(note), note, '')}</div>` : ''}
        </div>
      </div>`;
  }

  function pdfBuildHost(entries, now) {
    if (!$('#pdfStyle')) {
      const st = document.createElement('style');
      st.id = 'pdfStyle';
      st.textContent = pdfStyleCss();
      document.head.appendChild(st);
    }
    const uiDir = document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr';
    const answers = loadProgress().answers || {};
    const host = document.createElement('div');
    host.className = 'pdf-host';
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('dir', uiDir);
    host.innerHTML = `
      <div class="pdf-block pdf-head pdf-${uiDir}" dir="${uiDir}">
        <div class="pdf-brand">CardioAnat · ${esc(t('logoSub'))}</div>
        <h1>${esc(t('pdfTitle'))}</h1>
        <div class="pdf-meta"><span>${esc(t('pdfDate'))}: ${esc(pdfDateLabel(now))}</span><span>${esc(t('pdfTotal'))}: ${entries.length}</span></div>
      </div>
      ${entries.map((e, i) => pdfBlockHtml(e, i + 1, answers)).join('')}`;
    return host;
  }

  async function exportMistakesPdf() {
    if (pdfBusy) return;
    const entries = reviewEntries().filter(e => isUsableQuestion(e.q));
    if (!entries.length) { showToast(t('pdfNothing')); return; }

    // lesson order, then the order inside the lesson
    entries.sort((a, b) => {
      if (a.li !== b.li) return a.li - b.li;
      const qs = LESSONS[a.li].questions || [];
      return qs.indexOf(a.q) - qs.indexOf(b.q);
    });

    setPdfBusy(true);
    let host = null;
    try {
      await ensurePdfLibs();

      // Make sure the web fonts (Arabic + Latin) are really loaded before drawing.
      if (document.fonts && document.fonts.load) {
        const sample = 'أبجد هوز Abc àéç 123';
        try {
          await Promise.all(['400', '600', '700', '900'].map(w => document.fonts.load(w + ' 16px "Cairo"', sample)));
          await document.fonts.ready;
        } catch (e) { /* use fallback fonts */ }
      }

      const now = new Date();
      host = pdfBuildHost(entries, now);
      document.body.appendChild(host);
      await new Promise(r => requestAnimationFrame(() => r()));

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
      const PAGE_W = 210, PAGE_H = 297, MX = 10, MY = 12, GAP = 4;
      const cw = PAGE_W - 2 * MX;          // content width (mm)
      const ch = PAGE_H - 2 * MY;          // content height (mm)
      const blocks = $$('.pdf-block', host);
      let y = MY;

      const onclone = clonedDoc => {
        const h = clonedDoc.querySelector('.pdf-host');
        if (h) { h.style.left = '0'; h.style.top = '0'; }
      };

      for (let i = 0; i < blocks.length; i++) {
        const canvas = await window.html2canvas(blocks[i], {
          scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false, onclone: onclone
        });
        const h = (canvas.height * cw) / canvas.width;

        if (h <= ch) {
          if (y + h > PAGE_H - MY && y > MY) { doc.addPage(); y = MY; }
          doc.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', MX, y, cw, h, undefined, 'FAST');
          y += h + GAP;
        } else {
          // a very long card: slice it across pages
          if (y > MY) { doc.addPage(); y = MY; }
          const pxPerPage = Math.floor((ch * canvas.width) / cw);
          let off = 0;
          while (off < canvas.height) {
            const sliceH = Math.min(pxPerPage, canvas.height - off);
            const part = document.createElement('canvas');
            part.width = canvas.width;
            part.height = sliceH;
            part.getContext('2d').drawImage(canvas, 0, off, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
            const hh = (sliceH * cw) / canvas.width;
            if (off > 0) { doc.addPage(); y = MY; }
            doc.addImage(part.toDataURL('image/jpeg', 0.92), 'JPEG', MX, y, cw, hh, undefined, 'FAST');
            y += hh;
            off += sliceH;
          }
          y += GAP;
        }
      }

      // page numbers (plain Latin digits → safe with jsPDF's built-in font)
      const pages = doc.getNumberOfPages();
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(130, 130, 130);
      for (let p = 1; p <= pages; p++) {
        doc.setPage(p);
        doc.text(p + ' / ' + pages, PAGE_W / 2, PAGE_H - 5, { align: 'center' });
      }
      if (doc.setProperties) doc.setProperties({ title: 'My Mistakes Report - Heart Unit', subject: 'Anatomy Question Bank' });

      doc.save('My_Mistakes_Heart_' + pdfFileDate(now) + '.pdf');
      showToast(t('pdfDone'));
    } catch (err) {
      if (window.console) console.error('PDF export failed:', err);
      showToast(t('pdfFail'));
    } finally {
      if (host && host.parentNode) host.parentNode.removeChild(host);
      setPdfBusy(false);
    }
  }

  /* ---------- Modal: "Show me the lesson" ---------- */
  function openLessonModal(triggerEl) {
    if (!quiz) return;
    const q = quiz.items[quiz.pos].q;
    const modal = $('#lessonModal');
    if (!modal) return;

    const hasPage = q.pageNumber !== null && q.pageNumber !== undefined && q.pageNumber !== '';
    const quote = q.lessonQuote ? String(q.lessonQuote).trim() : '';

    $('#modalPage').textContent = hasPage ? String(q.pageNumber) : t('pageUnknown');
    $('#modalQuote').textContent = quote;
    $('#modalQuoteWrap').hidden = !quote;

    lastFocus = triggerEl || document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    const closeBtn = $('#modalClose');
    if (closeBtn) closeBtn.focus();
  }

  function closeModal(silent) {
    const modal = $('#lessonModal');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.style.overflow = '';
    if (!silent && lastFocus && document.body.contains(lastFocus)) {
      try { lastFocus.focus(); } catch (e) { /* ignore */ }
    }
    lastFocus = null;
  }

  function isModalOpen() {
    const modal = $('#lessonModal');
    return !!modal && !modal.hidden;
  }

  /* ---------- Language ---------- */
  function applyLanguage(lang, animate) {
    if (!I18N[lang]) lang = DEFAULT_LANG;
    currentLang = lang;

    const html = document.documentElement;
    html.lang = lang;
    html.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.title = t('pageTitle');

    $$('[data-i18n]').forEach(el => {
      el.textContent = t(el.dataset.i18n);
    });
    $$('[data-i18n-title]').forEach(el => {
      el.title = t(el.dataset.i18nTitle);
      el.setAttribute('aria-label', t(el.dataset.i18nTitle));
    });
    $$('[data-i18n-aria]').forEach(el => {
      el.setAttribute('aria-label', t(el.dataset.i18nAria));
    });

    // Toggle UI
    const toggle = $('.lang-toggle');
    $$('.lang-btn').forEach(btn => {
      const active = btn.dataset.lang === lang;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (toggle) toggle.style.setProperty('--idx', LANG_ORDER.indexOf(lang));

    safeSet(STORAGE_KEY, lang);

    // Dynamic content (Phase 2)
    updateCardTitles();
    if (quiz) {
      renderQuiz();
      if (isModalOpen()) {
        const q = quiz.items[quiz.pos].q;
        const hasPage = q.pageNumber !== null && q.pageNumber !== undefined && q.pageNumber !== '';
        $('#modalPage').textContent = hasPage ? String(q.pageNumber) : t('pageUnknown');
      }
    }

    if (currentView === 'review') renderReview();
    else if (currentView === 'flash') renderFlash();
    else if (currentView === 'challenge') renderChallenge();   // Phase 7
    renderStats();
    updateNavBadge();

    if (animate) {
      const title = $('.title-text');
      if (title && !$('#homeView').hidden) {
        title.animate(
          [{ opacity: 0, transform: 'translateY(-10px)' }, { opacity: 1, transform: 'translateY(0)' }],
          { duration: 450, easing: 'ease-out' }
        );
      }
    }
  }

  function initLanguage() {
    const saved = safeGet(STORAGE_KEY);
    applyLanguage(saved && I18N[saved] ? saved : DEFAULT_LANG, false);

    $$('.lang-btn').forEach(btn => {
      btn.addEventListener('click', () => applyLanguage(btn.dataset.lang, true));
    });
  }

  /* =========================================================
     PWA / OFFLINE  (Phase 6)
     - registers service-worker.js (needs HTTPS or localhost)
     - the service worker precaches the app shell on first visit
     - the navbar button asks it to (re)download EVERYTHING, including the
       CDN files (icons font, Google fonts, PDF libraries), then confirms
     ========================================================= */
  let offlineBusy = false;
  let swPromise = null;

  function swAvailable() {
    if (!('serviceWorker' in navigator)) return false;
    const h = location.hostname;
    return !!window.isSecureContext || h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  }

  function registerServiceWorker() {
    if (!swAvailable()) return Promise.resolve(null);
    if (!swPromise) {
      swPromise = navigator.serviceWorker.register(SW_URL).catch(() => null);
    }
    return swPromise;
  }

  function setOfflineBtn(state) {   // 'idle' | 'busy' | 'ready'
    const btn = $('#btnOffline');
    if (!btn) return;
    btn.classList.toggle('is-busy', state === 'busy');
    btn.classList.toggle('is-ready', state === 'ready');
    btn.setAttribute('aria-busy', state === 'busy' ? 'true' : 'false');
    const icon = $('i', btn);
    if (icon) {
      icon.className = 'fa-solid ' + (state === 'busy' ? 'fa-spinner fa-spin'
        : state === 'ready' ? 'fa-circle-check' : 'fa-download');
    }
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), ms);
      promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
    });
  }

  function askWorker(worker, message, ms) {
    return withTimeout(new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = ev => resolve(ev.data);
      try { worker.postMessage(message, [channel.port2]); } catch (e) { reject(e); }
    }), ms);
  }

  async function downloadForOffline() {
    if (offlineBusy) return;
    if (!swAvailable()) {
      showToast(t('offlineUnsupported'), 5200);
      return;
    }
    offlineBusy = true;
    setOfflineBtn('busy');
    showToast(t('offlineDownloading'), 6000);
    try {
      await registerServiceWorker();
      const reg = await withTimeout(navigator.serviceWorker.ready, 20000);
      const worker = reg.active || reg.waiting || reg.installing;
      if (!worker) throw new Error('no worker');
      const result = await askWorker(worker, { type: 'CACHE_ALL' }, 120000);
      if (!result || !result.ok) throw new Error('incomplete');
      safeSet(OFFLINE_FLAG, '1');
      setOfflineBtn('ready');
      showToast(t('offlineReady'), 3200);
    } catch (e) {
      setOfflineBtn(safeGet(OFFLINE_FLAG) === '1' ? 'ready' : 'idle');
      showToast(t(navigator.onLine === false ? 'offlineNoNet' : 'offlineFail'), 5200);
    } finally {
      offlineBusy = false;
    }
  }

  function initOffline() {
    const btn = $('#btnOffline');
    if (btn) btn.addEventListener('click', downloadForOffline);
    if (safeGet(OFFLINE_FLAG) === '1') setOfflineBtn('ready');

    const go = () => {
      registerServiceWorker().then(reg => {
        // a previous full download is only trusted while the worker controls the page
        if (reg && safeGet(OFFLINE_FLAG) === '1') setOfflineBtn('ready');
      });
    };
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', go, { once: true });
  }

  /* ---------- Particles ---------- */
  function initParticles() {
    const container = $('#particles');
    if (!container) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const isMobile = window.innerWidth < 640;
    const count = isMobile ? 22 : 45;

    for (let i = 0; i < count; i++) {
      const p = document.createElement('span');
      p.className = 'particle' + (Math.random() < 0.18 ? ' gold-p' : '');

      const size = 4 + Math.random() * 12;
      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.left = Math.random() * 100 + '%';
      p.style.animationDuration = 9 + Math.random() * 14 + 's';
      p.style.animationDelay = -Math.random() * 20 + 's';
      p.style.setProperty('--dx', (Math.random() * 80 - 40).toFixed(0) + 'px');
      p.style.setProperty('--op', (0.35 + Math.random() * 0.5).toFixed(2));

      container.appendChild(p);
    }
  }

  /* ---------- Interactions ---------- */
  function initCardInteractions() {
    // Mouse spotlight (delegated)
    document.addEventListener('pointermove', e => {
      const card = e.target.closest && e.target.closest('.card');
      if (!card) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', (e.clientX - rect.left) + 'px');
      card.style.setProperty('--my', (e.clientY - rect.top) + 'px');
    });

    function activate(card) {
      card.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(0.96)' }, { transform: 'scale(1)' }],
        { duration: 260, easing: 'ease-out' }
      );

      if (card.dataset.lesson !== undefined) {
        startLesson(Number(card.dataset.lesson));
      } else if (card.dataset.action === 'all') {
        startAll();
      } else if (card.dataset.action === 'exam') {
        openExamModal(card);
      } else if (card.dataset.action === 'challenge') {
        openChallenge();
      } else {
        showToast(t('soon'));
      }
    }

    document.addEventListener('click', e => {
      const card = e.target.closest && e.target.closest('#homeView .card');
      if (card) activate(card);
    });

    // Navbar buttons (Phase 4)
    const navActions = { btnReview: () => openReview(false), btnWrong: () => openReview(true), btnFlash: openFlashcards };
    Object.keys(navActions).forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', navActions[id]);
    });

    // Logo → home
    const logo = $('#logoLink');
    if (logo) {
      logo.addEventListener('click', e => {
        e.preventDefault();
        goHome();
      });
    }
  }

  function initQuizInteractions() {
    const view = $('#quizView');
    if (view) {
      view.addEventListener('click', e => {
        const option = e.target.closest('.option');
        if (option && annot && annot.editing) return;   // Phase 5: options are plain text while annotating
        if (option && !option.classList.contains('locked')) {
          onAnswer(Number(option.dataset.idx));
          return;
        }
        const actEl = e.target.closest('[data-act]');
        if (!actEl) return;
        switch (actEl.dataset.act) {
          case 'home': goHome(); break;
          case 'next': goNext(); break;
          case 'prev': goPrev(); break;
          case 'retry': restartQuiz(); break;
          case 'goto': examGoto(Number(actEl.dataset.pos)); break;
          case 'lesson': openLessonModal(actEl); break;
          case 'dashboard': openReview(false); break;
          default: break;
        }
      });
    }

    // "Convert to Flashcard" buttons — quiz, exam results and review lists
    document.addEventListener('click', e => {
      const btn = e.target.closest && e.target.closest('.fc-btn[data-act="flash"]');
      if (btn) onFlashButton(btn);
    });

    // Review dashboard
    const reviewView = $('#reviewView');
    if (reviewView) {
      reviewView.addEventListener('click', e => {
        const actEl = e.target.closest('[data-act]');
        if (!actEl || actEl.disabled) return;
        switch (actEl.dataset.act) {
          case 'home': goHome(); break;
          case 'startReview': startReview(true); break;
          case 'practice': startReview(false); break;
          case 'interval': setReviewInterval(Number(actEl.dataset.h)); break;
          case 'exportPdf': exportMistakesPdf(); break;
          default: break;
        }
      });
    }

    // Flashcards page
    const flashView = $('#flashView');
    if (flashView) {
      flashView.addEventListener('click', e => {
        const actEl = e.target.closest('[data-act]');
        if (actEl) {
          if (actEl.disabled) return;
          switch (actEl.dataset.act) {
            case 'home': goHome(); break;
            case 'fprev': flashStep(-1); break;
            case 'fnext': flashStep(1); break;
            case 'fshuffle': flashShuffle(); break;
            case 'fremove': flashRemove(); break;
            default: break;
          }
          return;
        }
        if (e.target.closest('#fcCard')) flipCard();
      });
    }

    // Modal close (backdrop, X button)
    const modal = $('#lessonModal');
    if (modal) {
      modal.addEventListener('click', e => {
        if (e.target.closest('[data-close]')) closeModal();
      });
    }

    // Exam intro modal: close (backdrop / X / Cancel) or start
    const examModal = $('#examModal');
    if (examModal) {
      examModal.addEventListener('click', e => {
        if (e.target.closest('#examStart')) { startExam(); return; }
        if (e.target.closest('[data-close]')) closeExamModal();
      });
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modalOpen('resetModal')) { closeModalEl('resetModal'); return; }   // Phase 7
      if (e.key === 'Escape' && modalOpen('settingsModal')) { closeModalEl('settingsModal'); return; }
      if (e.key === 'Escape' && isExamModalOpen()) {
        closeExamModal();
        return;
      }
      if (e.key === 'Escape' && isModalOpen()) {
        closeModal();
        return;
      }
      if (e.key === 'Escape' && annot && annot.editing) {   // Phase 5
        annCancel();
        return;
      }

      // Phase 5: typing in the note box / colour & thickness inputs must never trigger shortcuts
      const typingTag = e.target && e.target.tagName;
      if (typingTag === 'TEXTAREA' || typingTag === 'INPUT' || typingTag === 'SELECT') return;

      // Enter / Space on cards
      if ((e.key === 'Enter' || e.key === ' ') && $('#homeView') && !$('#homeView').hidden) {
        const card = e.target.closest && e.target.closest('.card');
        if (card) {
          e.preventDefault();
          card.click();
        }
        return;
      }

      // Phase 7 – challenge: 1-9 = choose option, Enter = continue
      if (currentView === 'challenge' && chal && chal.phase === 'play') {
        if (e.ctrlKey || e.metaKey || e.altKey || modalOpen('settingsModal') || modalOpen('resetModal')) return;
        if (/^[1-9]$/.test(e.key)) chalAnswer(Number(e.key) - 1);
        else if (e.key === 'Enter' && chal.answer && !(e.target.closest && e.target.closest('button'))) chalNext();
        return;
      }

      // Flashcards: Space/Enter = flip, ← → = previous / next
      if (currentView === 'flash' && !isModalOpen() && !isExamModalOpen()) {
        handleFlashKey(e);
        return;
      }

      // Quiz shortcuts: 1-9 = choose option, Enter = next (after answering)
      if (!quiz || quiz.done || isModalOpen() || isExamModalOpen() || (annot && annot.editing)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (/^[1-9]$/.test(e.key)) {
        onAnswer(Number(e.key) - 1);
      } else if (e.key === 'Enter') {
        if (e.target.closest && e.target.closest('button')) return; // let the button handle it
        const q = quiz.items[quiz.pos].q;
        if (quiz.answers[q.id]) goNext();
      }
    });
  }

  /* =========================================================
     PHASE 7
     1) Stats dashboard   2) Challenge mode   3) Settings + reset
     ========================================================= */

  /* ---------- 1) Stats dashboard ---------- */
  function computeStats() {
    const p = loadProgress();
    let attempts = 0, right = 0;
    Object.keys(p.answers).forEach(id => {
      const x = p.answers[id] || {};
      attempts += x.attempts || 0;
      right += x.correctCount || 0;
    });
    let best = null;
    loadExams().results.forEach(r => {
      if (!r || !r.total) return;
      const pct = r.score / r.total;
      if (!best || pct > best.pct) best = { pct: pct, score: r.score, total: r.total };
    });
    const wrongLeft = Object.keys(loadReview().items).filter(id => QMAP[id]).length;
    return {
      attempts: attempts,
      accuracy: attempts ? Math.round((right / attempts) * 100) : null,
      best: best,
      cards: deckIds().length,
      wrongLeft: wrongLeft
    };
  }

  function renderStats() {
    const el = $('#statsPanel');
    if (!el) return;
    const s = computeStats();
    const dash = '—';
    const tile = (icon, label, value, extra, act) => `
      <${act ? 'button type="button"' : 'div'} class="hstat${act ? ' hstat--link' : ''}"${act ? ` data-stat="${act}"` : ''}>
        <span class="hstat-icon"><i class="fa-solid ${icon}"></i></span>
        <strong class="hstat-val">${value}</strong>
        <span class="hstat-label">${esc(label)}</span>
        ${extra || ''}
      </${act ? 'button' : 'div'}>`;
    el.innerHTML = `
      <h2 class="stats-title"><i class="fa-solid fa-chart-column"></i> ${esc(t('statsTitle'))}</h2>
      <div class="stats-grid">
        ${tile('fa-list-check', t('statAnswered'), s.attempts)}
        ${tile('fa-bullseye', t('statAccuracy'), s.accuracy === null ? dash : s.accuracy + '%',
          `<span class="hstat-bar"><span style="width:${s.accuracy || 0}%"></span></span>`)}
        ${tile('fa-trophy', t('statBestExam'), s.best ? s.best.score + '/' + s.best.total : dash)}
        ${tile('fa-clone', t('statFlashcards'), s.cards, '', 'flash')}
        ${tile('fa-circle-xmark', t('statWrongLeft'), s.wrongLeft, '', 'wrong')}
      </div>`;
  }

  /* ---------- 2) Challenge mode ---------- */
  function chalPool(sel) {
    const items = [];
    LESSONS.forEach((lesson, li) => {
      if (sel !== 'all' && Number(sel) !== li) return;
      (lesson.questions || []).filter(isUsableQuestion).forEach(q => items.push({ q: q, li: li }));
    });
    return items;
  }

  function openChallenge() {
    if (!leaveCurrent()) return;
    chal = { phase: 'setup' };
    showView('challenge');
    renderChallenge();
  }

  function renderChallenge() {
    if (!chal) return;
    if (chal.phase === 'setup') renderChalSetup();
    else if (chal.phase === 'play') renderChalPlay();
    else renderChalResult();
  }

  function chalHintText() {
    return fmt(t('chalCountHint'), { n: chalPool(chalSetup.lesson).length });
  }

  function renderChalSetup() {
    const view = $('#challengeView');
    if (!view) return;
    const lessonOpts = LESSONS.map((l, i) =>
      `<option value="${i}"${String(chalSetup.lesson) === String(i) ? ' selected' : ''}>${esc(t('lesson') + ' ' + (i + 1) + ' — ' + lessonTitle(l, i))}</option>`).join('');
    view.innerHTML = `
      <div class="quiz-top">
        <button type="button" class="back-btn" data-act="home">
          <i class="fa-solid fa-house"></i><span>${esc(t('backHome'))}</span>
        </button>
      </div>
      <h2 class="quiz-title">⚔️ ${esc(t('chalSetupTitle'))}</h2>
      <article class="quiz-card chal-setup">
        <div class="chal-names">
          <label class="chal-field chal-field--p1">
            <span><i class="fa-solid fa-user"></i> ${esc(t('chalP1Label'))}</span>
            <input type="text" id="chalP1" maxlength="20" dir="auto" autocomplete="off" value="${esc(chalSetup.p1)}" placeholder="${esc(t('chalP1Default'))}" />
          </label>
          <label class="chal-field chal-field--p2">
            <span><i class="fa-solid fa-user"></i> ${esc(t('chalP2Label'))}</span>
            <input type="text" id="chalP2" maxlength="20" dir="auto" autocomplete="off" value="${esc(chalSetup.p2)}" placeholder="${esc(t('chalP2Default'))}" />
          </label>
        </div>
        <label class="chal-field">
          <span><i class="fa-solid fa-book-open"></i> ${esc(t('chalLessonLabel'))}</span>
          <select id="chalLesson">
            <option value="all"${chalSetup.lesson === 'all' ? ' selected' : ''}>${esc(t('chalAllLessons'))}</option>
            ${lessonOpts}
          </select>
        </label>
        <label class="chal-field">
          <span><i class="fa-solid fa-hashtag"></i> ${esc(t('chalCountLabel'))}</span>
          <input type="number" id="chalCount" min="2" max="200" step="2" inputmode="numeric" value="${esc(chalSetup.count)}" />
        </label>
        <p class="chal-hint" id="chalHint">${esc(chalHintText())}</p>
        <div class="result-actions">
          <button type="button" class="nav-step primary" data-act="cstart"><i class="fa-solid fa-play"></i><span>${esc(t('chalStart'))}</span></button>
        </div>
      </article>`;
  }

  function chalStart() {
    const pool = chalPool(chalSetup.lesson);
    if (pool.length < 2) { showToast(t('noQuestions')); return; }
    let n = parseInt(chalSetup.count, 10);
    if (!n || n < 2) n = 10;
    n = Math.min(n, pool.length);
    if (n % 2) n = (n + 1 <= pool.length) ? n + 1 : n - 1;   // equal turns for both players
    chalSetup.count = n;
    const names = [
      (chalSetup.p1 || '').trim() || t('chalP1Default'),
      (chalSetup.p2 || '').trim() || t('chalP2Default')
    ];
    if (names[0] === names[1]) names[1] += ' 2';
    stopConfetti();
    chal = {
      phase: 'play',
      items: shuffle(pool).slice(0, n),
      pos: 0,
      total: n,
      names: names,
      scores: [{ c: 0, w: 0 }, { c: 0, w: 0 }],
      answer: null
    };
    renderChallenge();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function chalScoreBar() {
    const turn = chal.pos % 2;
    const card = i => `
        <div class="chal-player chal-player--p${i + 1}${chal.phase === 'play' && turn === i ? ' active' : ''}">
          <span class="chal-name" dir="auto">${esc(chal.names[i])}</span>
          <strong class="chal-pts">${chal.scores[i].c}</strong>
        </div>`;
    return `<div class="chal-bar" aria-label="${esc(t('chalScoreTitle'))}">${card(0)}<span class="chal-vs">VS</span>${card(1)}</div>`;
  }

  function renderChalPlay() {
    const view = $('#challengeView');
    if (!view) return;
    const item = chal.items[chal.pos];
    const q = item.q;
    const opts = pickList(q, 'options');
    const ans = chal.answer;
    const turn = chal.pos % 2;
    const isLast = chal.pos === chal.total - 1;
    const pct = Math.round(((chal.pos + (ans ? 1 : 0)) / chal.total) * 100);

    const optsHtml = opts.map((text, i) => {
      const st = optionState(i, q, ans);
      const cls = (st.cls ? ' ' + st.cls : '') + (ans ? ' locked' : '') + (ans && (st.cls === 'correct' || st.cls === 'wrong') ? ' anim' : '');
      return `<button type="button" class="option${cls}" data-idx="${i}">
          <span class="opt-letter">${LETTERS[i] || i + 1}</span>
          <span class="opt-text" dir="auto">${esc(text)}</span>
          <span class="opt-icon"><i class="fa-solid ${st.icon || 'fa-check'}"></i></span>
        </button>`;
    }).join('');

    let fb = '';
    if (ans) {
      const explanation = pickText(q, 'explanation');
      fb = `
        <div class="fb-status ${ans.correct ? 'is-right' : 'is-wrong'}">
          <i class="fa-solid ${ans.correct ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
          <span>${esc(t(ans.correct ? 'correctMsg' : 'wrongMsg'))}</span>
        </div>
        ${explanation ? `<div class="fb-block fb-ok">
          <h4><i class="fa-solid fa-lightbulb"></i> ${esc(t('whyCorrect'))}</h4>
          <p class="fb-text" dir="auto">${esc(explanation)}</p>
        </div>` : ''}
        ${isLast ? '' : `<div class="chal-pass"><i class="fa-solid fa-right-left"></i> <span dir="auto">${esc(fmt(t('chalPassTo'), { name: chal.names[(chal.pos + 1) % 2] }))}</span></div>`}`;
    }

    view.innerHTML = `
      <div class="quiz-top">
        <button type="button" class="back-btn" data-act="home">
          <i class="fa-solid fa-house"></i><span>${esc(t('backHome'))}</span>
        </button>
        <div class="quiz-score"><i class="fa-solid fa-khanda"></i><span>${esc(t('question'))} ${chal.pos + 1} / ${chal.total}</span></div>
      </div>
      ${chalScoreBar()}
      <div class="qbar" aria-hidden="true"><span style="width:${pct}%"></span></div>
      <div class="chal-turn chal-turn--p${turn + 1}"><i class="fa-solid fa-hand-point-right no-flip"></i> <span dir="auto">${esc(fmt(t('chalTurn'), { name: chal.names[turn] }))}</span></div>
      <article class="quiz-card" id="quizCard">
        ${qBadge(q)}
        <h3 class="q-text" dir="auto">${esc(pickText(q, 'question'))}</h3>
        <div class="options" role="group">${optsHtml}</div>
        <div class="feedback${ans ? ' reveal' : ''}">${fb}</div>
      </article>
      <div class="quiz-nav">
        <span></span>
        <button type="button" class="nav-step primary${ans ? ' pulse' : ''}" data-act="cnext" ${ans ? '' : 'disabled'}>
          <span>${esc(t(isLast ? 'chalSeeResults' : 'next'))}</span><i class="fa-solid ${isLast ? 'fa-flag-checkered' : 'fa-arrow-right'}"></i>
        </button>
      </div>`;
  }

  function chalAnswer(idx) {
    if (!chal || chal.phase !== 'play' || chal.answer) return;
    const q = chal.items[chal.pos].q;
    const opts = pickList(q, 'options');
    if (idx < 0 || idx >= opts.length) return;
    const correct = idx === q.correctIndex;
    chal.answer = { selected: idx, correct: correct };
    chal.scores[chal.pos % 2][correct ? 'c' : 'w']++;
    renderChalPlay();
    const fb = $('#challengeView .feedback');
    if (fb) setTimeout(() => fb.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 250);
  }

  function chalNext() {
    if (!chal || chal.phase !== 'play' || !chal.answer) return;
    chal.answer = null;
    if (chal.pos >= chal.total - 1) {
      chal.phase = 'result';
      renderChallenge();
      launchConfetti();
    } else {
      chal.pos++;
      renderChallenge();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderChalResult() {
    const view = $('#challengeView');
    if (!view) return;
    const [a, b] = chal.scores;
    const winner = a.c === b.c ? -1 : (a.c > b.c ? 0 : 1);
    const turns = chal.total / 2;
    const col = i => {
      const s = chal.scores[i];
      return `
        <div class="chal-final-col chal-final-col--p${i + 1}${winner === i ? ' is-winner' : ''}">
          ${winner === i ? '<span class="chal-crown">👑</span>' : ''}
          <span class="chal-name" dir="auto">${esc(chal.names[i])}</span>
          <strong class="chal-big">${s.c}<small> / ${turns}</small></strong>
          <div class="chal-mini">
            <span class="ok"><i class="fa-solid fa-check"></i> ${s.c} ${esc(t('correctAnswers'))}</span>
            <span class="bad"><i class="fa-solid fa-xmark"></i> ${s.w} ${esc(t('wrongAnswers'))}</span>
          </div>
        </div>`;
    };
    view.innerHTML = `
      <div class="quiz-top">
        <button type="button" class="back-btn" data-act="home">
          <i class="fa-solid fa-house"></i><span>${esc(t('backHome'))}</span>
        </button>
      </div>
      <article class="quiz-card result chal-result">
        <div class="result-trophy">${winner === -1 ? '<i class="fa-solid fa-handshake"></i>' : '<i class="fa-solid fa-trophy"></i>'}</div>
        <h2 dir="auto">🎉 ${esc(winner === -1 ? t('chalTie') : fmt(t('chalWinner'), { name: chal.names[winner] }))}</h2>
        <div class="chal-final">${col(0)}${col(1)}</div>
        <div class="result-actions">
          <button type="button" class="nav-step" data-act="csetup"><i class="fa-solid fa-sliders"></i><span>${esc(t('chalNewSetup'))}</span></button>
          <button type="button" class="nav-step primary" data-act="cagain"><i class="fa-solid fa-rotate-right"></i><span>${esc(t('chalPlayAgain'))}</span></button>
        </div>
      </article>`;
  }

  /* ---------- Confetti (canvas, ~6 s, skipped for reduced-motion users) ---------- */
  function stopConfetti() {
    if (confettiRaf) cancelAnimationFrame(confettiRaf);
    confettiRaf = null;
    if (confettiCv && confettiCv.parentNode) confettiCv.parentNode.removeChild(confettiCv);
    confettiCv = null;
  }

  function launchConfetti() {
    stopConfetti();
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const cv = document.createElement('canvas');
    cv.className = 'confetti-canvas';
    cv.setAttribute('aria-hidden', 'true');
    document.body.appendChild(cv);
    confettiCv = cv;
    const ctx = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.width = Math.round(window.innerWidth * dpr);
    const H = cv.height = Math.round(window.innerHeight * dpr);
    const colors = ['#FFD700', '#FF4757', '#C41E3A', '#fff1a8', '#ffffff', '#f5c518'];
    const pieces = [];
    for (let i = 0; i < 160; i++) {
      pieces.push({
        x: Math.random() * W, y: -Math.random() * H * 0.7,
        w: (6 + Math.random() * 7) * dpr, h: (10 + Math.random() * 10) * dpr,
        vx: (Math.random() - 0.5) * 3 * dpr, vy: (2 + Math.random() * 4) * dpr,
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3,
        c: colors[i % colors.length]
      });
    }
    const start = performance.now();
    function frame(now) {
      ctx.clearRect(0, 0, W, H);
      let alive = 0;
      pieces.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vy += 0.035 * dpr;
        if (p.y < H + 40 * dpr) alive++;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      if (alive && now - start < 7000) confettiRaf = requestAnimationFrame(frame);
      else stopConfetti();
    }
    confettiRaf = requestAnimationFrame(frame);
  }

  /* ---------- 3) Settings + reset ---------- */
  function modalOpen(id) {
    const m = document.getElementById(id);
    return !!m && !m.hidden;
  }
  function openModalEl(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.hidden = false;
    document.body.style.overflow = 'hidden';
    const f = $('.nav-step:not(.danger), .modal-close', m);
    if (f) f.focus();
  }
  function closeModalEl(id) {
    const m = document.getElementById(id);
    if (!m || m.hidden) return;
    m.hidden = true;
    if (!$$('.modal').some(x => !x.hidden)) document.body.style.overflow = '';
  }

  function resetAllData() {
    annFlush();   // stop any open annotation editor first so it cannot re-save after the wipe
    try {
      const remove = [PROGRESS_KEY, EXAMS_KEY, REVIEW_KEY, FLASH_KEY];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(ANN_PREFIX) === 0) remove.push(k);
      }
      remove.forEach(k => localStorage.removeItem(k));
    } catch (e) { /* ignore */ }

    quiz = null;
    chal = null;
    stopConfetti();
    ['#quizView', '#challengeView'].forEach(sel => { const el = $(sel); if (el) el.innerHTML = ''; });
    closeModalEl('resetModal');
    closeModalEl('settingsModal');
    closeModal(true);
    closeExamModal(true);
    showView('home');
    initReviewStore();     // recreates an empty review store
    updateNavBadge();
    renderStats();
    showToast(t('resetDone'), 3000);
  }

  function initPhase7() {
    renderStats();

    // Stats tiles that open a page
    const sp = $('#statsPanel');
    if (sp) {
      sp.addEventListener('click', e => {
        const tl = e.target.closest('[data-stat]');
        if (!tl) return;
        if (tl.dataset.stat === 'flash') openFlashcards();
        else if (tl.dataset.stat === 'wrong') openReview(true);
      });
    }

    // Challenge screens
    const cv = $('#challengeView');
    if (cv) {
      cv.addEventListener('click', e => {
        const option = e.target.closest('.option');
        if (option && !option.classList.contains('locked')) { chalAnswer(Number(option.dataset.idx)); return; }
        const el = e.target.closest('[data-act]');
        if (!el || el.disabled) return;
        switch (el.dataset.act) {
          case 'home': goHome(); break;
          case 'cstart': case 'cagain': chalStart(); break;
          case 'cnext': chalNext(); break;
          case 'csetup': stopConfetti(); chal = { phase: 'setup' }; renderChallenge(); window.scrollTo({ top: 0, behavior: 'auto' }); break;
          default: break;
        }
      });
      cv.addEventListener('input', e => {
        const id = e.target.id;
        if (id === 'chalP1') chalSetup.p1 = e.target.value;
        else if (id === 'chalP2') chalSetup.p2 = e.target.value;
        else if (id === 'chalCount') chalSetup.count = e.target.value;
      });
      cv.addEventListener('change', e => {
        if (e.target.id === 'chalLesson') {
          chalSetup.lesson = e.target.value;
          const hint = $('#chalHint');
          if (hint) hint.textContent = chalHintText();
        }
      });
    }

    // Settings + reset dialogs
    const bs = $('#btnSettings');
    if (bs) bs.addEventListener('click', () => openModalEl('settingsModal'));
    const br = $('#btnReset');
    if (br) br.addEventListener('click', () => openModalEl('resetModal'));
    const rc = $('#resetConfirm');
    if (rc) rc.addEventListener('click', resetAllData);
    ['settingsModal', 'resetModal'].forEach(id => {
      const m = document.getElementById(id);
      if (m) m.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModalEl(id); });
    });
  }

  /* ---------- Init ---------- */
  function init() {
    initReviewStore();   // Phase 4: migrate earlier wrong answers once
    renderCards();
    initLanguage();      // after cards exist so data-i18n gets filled
    initParticles();
    initCardInteractions();
    initQuizInteractions();
    initAnnotations();   // Phase 5
    initOffline();       // Phase 6: service worker + offline button
    initPhase7();        // Phase 7: stats, challenge, settings
    updateNavBadge();
    setInterval(updateNavBadge, 60000);   // keep the "due" badge fresh while the tab stays open
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
