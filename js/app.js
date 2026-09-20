/* ============================================================
   МедиаволнApp — приложение участника
   Авторизация ВК + Firebase (аноним), рейтинг, задания, расписание.
   Голосование на текущем этапе не реализуется.
   ============================================================ */

const SELF_DOC_CACHE = 'mw_self_v1';   // кэш «я выполнял задания»
const doneCache = JSON.parse(localStorage.getItem(SELF_DOC_CACHE) || '{}');

let db, auth;
let myUid = '';    // users/<uid> текущего участника
let myVkId = '';   // VK ID участника (общий для всех устройств)
let myName = '';   // «Имя Фамилия» — подпись под фото
let myScore = 0;   // текущие баллы
let myAvatar = ''; // VK_ID фото для «твоего блока» в рейтинге
let myDistrict = '';    // округ участника
let myRole = 'student';          // 'student' | 'organizer' (роль из пикера округа)
let myShowInRating = true;
let myGlowAnim = true;       // участник: всегда true; организатор: по умолчанию false
let myIsAdmin = false;  // админ панели (VK ID в config/admins) — отдельно от роли в рейтинге

const ROLE_ORGANIZER = 'organizer';
const ROLE_STUDENT = 'student';
let mediaSubmitting = false;  // защита от двойной отправки медиа

/* ---------- Тосты ---------- */
function showToast(text, isErr) {
  const wrap = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  const icon = isErr ? 'alert-circle' : 'check-circle';
  t.innerHTML = '<i data-feather="' + icon + '"></i><span></span>';
  t.querySelector('span').textContent = text;
  wrap.appendChild(t);
  if (window.feather) feather.replace();
  setTimeout(() => {
    t.classList.add('leave');
    setTimeout(() => t.remove(), 320);
  }, 3200);
}

/* ---------- Инициализация ---------- */
async function init() {
  try {
    // 1. Авторизация ВК
    const vk = await vkGetUser();

    // 2. Firebase: анонимный вход (бесплатный, без пароля)
    if (!DEV_MODE) {
      firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.firestore();
      // Long-polling вместо websocket — в iOS WKWebView (VK на iPhone)
      // websocket-соединение Firestore зависает и realtime не приходит.
      db.settings({ experimentalForceLongPolling: true });
      auth = firebase.auth();
      await auth.signInAnonymously();
    } else {
      console.warn('DEV_MODE: Firebase пропущен, используется локальное хранилище.');
    }

    // 3. Документ участника привязан к VK ID, а не к uid устройства:
    //    один аккаунт ВК = один профиль (баллы, выполненные задания) на всех устройствах.
    myUid = DEV_MODE ? 'dev-user' : 'vk_' + String(vk.id);
    myVkId = DEV_MODE ? '' : String(vk.id);
    myName = DEV_MODE ? 'DEV-пользователь' : (vk.first_name + ' ' + vk.last_name).trim();
    myAvatar = DEV_MODE ? '' : (vk.photo_100 || '');

    // 4. Рендер + подписки
    renderHeader(vk);
    try { myDistrict = localStorage.getItem(DISTRICT_KEY) || ''; } catch (e) {}
    updateHeaderSub();
    renderDistrictVal();
    renderSchedule();
    renderTasks(DEFAULT_TASKS_EMPTY);
    initDock();

    // Админство нужно ЗАРАНЕЕ: пикер округа при первом входе (из subscribeScore)
    // показывает опцию «Организатор» только админам из config/admins.
    await maybeShowAdminBtn(vk);

    if (DEV_MODE) {
      seedDevData(myUid, vk);
    } else {
      subscribeScore(myUid, vk);
      subscribeTasks(myUid);
      subscribeSchedule();
      subscribeMaintenance();
    }
  } catch (err) {
    console.error(err);
    showToast('Не удалось загрузить приложение: ' + err.message, true);
  }
}

const DEFAULT_TASKS_EMPTY = [];

/* ---------- Шапка: аватар + имя + баллы ---------- */
function renderHeader(vk) {
  const avatar = document.getElementById('hdr-avatar');
  const name = document.getElementById('hdr-name');
  if (vk.photo_100) {
    avatar.innerHTML = '<img src="' + escapeHtml(vk.photo_100) + '" alt="">';
  } else {
    avatar.textContent = (vk.first_name || '?')[0] + (vk.last_name || '')[0] || '?';
  }
  name.innerHTML = '<span>' + escapeHtml(vk.first_name + ' ' + vk.last_name) + '</span><small>участник слёта</small>';
  if (window.feather) feather.replace();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* Кнопка «Админ» в настройках: показываем только организаторам (VK ID из config/admins).
   Заодно ставим титул «Админ» в шапке вместо «участник слёта».
   Проверку кешируем в localStorage — не читаем config/admins при каждом запуске. */
const ADMIN_CACHE_KEY = 'mw_admin_v1';

async function maybeShowAdminBtn(vk) {
  const entry = document.getElementById('admin-entry');
  const isAdmin = await isAdminUser(vk);
  if (isAdmin) {
    if (entry) entry.style.display = 'block';
    myIsAdmin = true;
  }
  updateHeaderSub();
}

/* Подпись под именем в шапке: «участник слёта · Округ», «организатор · Округ» или «админ · Округ» */
function updateHeaderSub() {
  const sub = document.querySelector('#hdr-name small');
  if (!sub) return;
  const roleLabel = myIsAdmin ? 'админ' : (myRole === ROLE_ORGANIZER ? 'организатор' : 'участник слёта');
  const parts = [roleLabel];
  if (myDistrict) parts.push(myDistrict);
  sub.textContent = parts.join(' · ');
}

async function isAdminUser(vk) {
  if (DEV_MODE) return true;
  try {
    let cached = null;
    try { cached = localStorage.getItem(ADMIN_CACHE_KEY); } catch (e) {}
    if (cached === '1') return true;
    if (cached !== '0') {
      const snap = await db.collection('config').doc('admins').get();
      const ids = snap.exists && Array.isArray(snap.data().ids)
        ? snap.data().ids.map(String)
        : [];
      const ok = ids.includes(String(vk.id));
      try { localStorage.setItem(ADMIN_CACHE_KEY, ok ? '1' : '0'); } catch (e) {}
      return ok;
    }
  } catch (err) { /* молчим */ }
  return false;
}

/* ---------- Realtime с фолбэком ----------
   onSnapshot — основной источник, но если за firstMs он ничего не прислал
   (напр. iOS WKWebView глушит long-polling-канал), догружаем get().
   Поллинг — с экспоненциальным откатом (15с → 30с → 1м → 2м → 4м) и стопом
   после POLL_MAX попыток: если канал мёртв, вечный опрос выжжет дневной
   лимит чтений Firestore (150 устройств × 30 документов × 4 раза/мин).
   Первый доставленный снапшот (любым путём) гасит поллинг полностью. */
const POLL_MAX = 5;

function listenWithFallback(ref, onSnap, onErr, firstMs) {
  let got = false;
  let timer = null;
  let polls = 0;
  let delay = 15000;
  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const deliver = (snap) => {
    if (got) return;
    got = true;
    stop();
    onSnap(snap);
  };
  const poll = () => ref.get().then(deliver).catch(() => {});
  ref.onSnapshot(deliver, onErr);
  setTimeout(() => { if (!got) poll(); }, firstMs || 6000);
  const schedule = () => {
    if (got || polls >= POLL_MAX) return;
    timer = setTimeout(() => {
      poll();
      polls++;
      if (polls < POLL_MAX) { delay = Math.min(delay * 2, 120000); schedule(); }
    }, delay);
  };
  schedule();
}

/* ---------- Баллы + выполненные задания в реальном времени ----------
   Подписка на свой документ заодно проверяет существование: при первом входе
   создаёт профиль (1 запись), при смене имени/аватара обновляет их (редко).
   Отдельный get() больше не нужен — экономит 1 чтение на каждый вход. */
function subscribeScore(uid, vk) {
  const name = (vk.first_name + ' ' + vk.last_name).trim();
  const avatar = vk.photo_100 || '';
  const ref = db.collection('users').doc(uid);
  listenWithFallback(
    ref,
    (snap) => {
      if (!snap.exists) {
        ref.set({ vkId: String(vk.id), name: name, avatar: avatar, score: 0, done: {}, role: ROLE_STUDENT, showInRating: true })
          .catch(() => {});
        ensureDistrict({});
        return;
      }
      const d = snap.data();
      if (d.name !== name || d.avatar !== avatar) {
        ref.set({ vkId: String(vk.id), name: name, avatar: avatar }, { merge: true })
          .catch(() => {});
      }
      myScore = d.score || 0;
      document.getElementById('score-num').textContent = myScore;
      // Роль организатора привязана к админству (VK ID в config/admins):
      // админ всегда организатор, независимо от того участник он или нет.
      // Округ такой организатор выбирает сам в настройках (не принудительно при входе).
      myRole = myIsAdmin ? ROLE_ORGANIZER : ROLE_STUDENT;
      // Админ с округом — участник от своего округа и виден в рейтинге (пока не выключил);
      // админ без округа скрыт по умолчанию (тумблер в настройках).
      myShowInRating = myRole === ROLE_ORGANIZER
        ? (d.district ? d.showInRating !== false : false)
        : true;
      ensureDistrict(d);
      renderRatingToggle();
      renderMyRatingBlock();
      // Синхронизируем «выполненные задания» с других устройств.
      // done может быть как map'ом {id: счётчик}, так и старым массивом id.
      let changed = false;
      const sync = (id, count) => {
        if ((doneCache[id] || 0) < count) { doneCache[id] = count; changed = true; }
      };
      if (Array.isArray(d.done)) {
        d.done.forEach((id) => sync(id, 1));
      } else if (d.done && typeof d.done === 'object') {
        Object.keys(d.done).forEach((id) => sync(id, Number(d.done[id]) || 1));
      }
      if (changed) {
        localStorage.setItem(SELF_DOC_CACHE, JSON.stringify(doneCache));
        if (lastTasks.length) renderTasks(lastTasks);
      }
    },
    () => showToast('Не удаётся обновить счёт', true)
  );
}

function setScore(n) {
  myScore = n;
  document.getElementById('score-num').textContent = n;
}

/* ---------- Округ участника ----------
   Команды приезжают из разных округов Тюменской области (список из
   «Кабинета шеф-редактора»). При первом входе показываем выбор округа,
   сохраняем в профиль users/{uid}.district и показываем в шапке/админке. */
const DISTRICT_KEY = 'mw_district_v1';
const DISTRICT_ASKED_KEY = 'mw_district_asked_v1';
let districtPickerOpen = false;

function renderDistrictVal() {
  const el = document.getElementById('set-district-val');
  if (el) el.textContent = myDistrict || 'не выбран';
}

function ensureDistrict(d) {
  const district = d && d.district && String(d.district).trim();
  if (district) {
    myDistrict = district;
    myRole = myIsAdmin ? ROLE_ORGANIZER : ROLE_STUDENT;
    myShowInRating = myRole === ROLE_ORGANIZER
      ? (d ? d.showInRating !== false : myShowInRating)
      : true;
    myGlowAnim = d && d.glowAnim !== undefined ? d.glowAnim : true;
    try { localStorage.setItem(DISTRICT_KEY, myDistrict); } catch (e) {}
  } else {
    // Нет округа в профиле — значит округ ещё не выбран.
    // Стираем устаревший кеш и ОБЯЗАТЕЛЬНО показываем окно выбора
    // на первом входе — в том числе админам (у них в пикере есть
    // отдельная опция «Организатор»).
    myDistrict = '';
    myRole = myIsAdmin ? ROLE_ORGANIZER : ROLE_STUDENT;
    myShowInRating = false;
    myGlowAnim = true;
    try { localStorage.removeItem(DISTRICT_KEY); } catch (e) {}
    showDistrictPicker();
  }
  updateHeaderSub();
  renderDistrictVal();
}

function showDistrictPicker() {
  if (districtPickerOpen || !(typeof DISTRICTS !== 'undefined' && DISTRICTS.length)) return;
  districtPickerOpen = true;
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.id = 'district-modal';
  const orgOpt = myIsAdmin
    ? '<div class="district-opt-sep" aria-hidden="true"></div>' +
      '<button class="district-opt opt-org" data-d="Организатор" data-org="1" type="button">' +
      '<span>🎓 Организатор</span><small>не участвует в рейтинге (можно включить в настройках)</small></button>'
    : '';
  back.innerHTML =
    '<div class="modal">' +
    '<div class="field"><label>Откуда ты приехал?</label>' +
    '<p class="hint" style="margin:0 0 10px">Выбери свой округ — он появится в профиле и в админке.</p></div>' +
    '<div class="district-list">' +
    DISTRICTS.map((d) => '<button class="district-opt" data-d="' + escapeHtml(d) + '" type="button">' + escapeHtml(d) + '</button>').join('') +
    orgOpt +
    '</div></div>';
  document.body.appendChild(back);
  back.querySelectorAll('.district-opt').forEach((b) => {
    b.addEventListener('click', async () => {
      const name = b.dataset.d;
      closeDistrictPicker();
      await saveDistrict(name);
    });
  });
}

function closeDistrictPicker() {
  districtPickerOpen = false;
  const m = document.getElementById('district-modal');
  if (m) m.remove();
}

async function saveDistrict(name) {
  const isOrg = name === 'Организатор';
  // Роль «Организатор» доступна только админам (VK ID в config/admins) —
  // обычные участники не видят опцию и не могут её выставить.
  if (isOrg && !myIsAdmin) {
    showToast('Опция доступна только организаторам', true);
    return;
  }
  // Админ всегда организатор; выбрав округ, он участвует в рейтинге от своего округа.
  const role = myIsAdmin ? ROLE_ORGANIZER : ROLE_STUDENT;
  const showInRating = !isOrg;   // «Организатор» скрыт; округ — участник рейтинга
  if (DEV_MODE) {
    myDistrict = name;
    myRole = role;
    myShowInRating = showInRating;
  myGlowAnim = true;
    updateHeaderSub();
    renderDistrictVal();
    renderRatingToggle();
    showToast('Округ: ' + name);
    return;
  }
  try { localStorage.setItem(DISTRICT_ASKED_KEY, '1'); localStorage.setItem(DISTRICT_KEY, name); } catch (e) {}
  myDistrict = name;
  myRole = role;
  myShowInRating = showInRating;
  myGlowAnim = true;
  updateHeaderSub();
  renderDistrictVal();
  renderRatingToggle();
  try {
    // score/vkId передаём явно — правило users требует их в update
    await db.collection('users').doc(myUid).update({
      district: name, role: role, showInRating: showInRating, score: myScore, vkId: String(myVkId),
    });
    showToast('Округ сохранён: ' + name);
  } catch (err) {
    showToast('Округ не сохранился: ' + err.message, true);
  }
}

/* ---------- Расписание ---------- */
function renderSchedule() {
  const wrap = document.getElementById('schedule');
  const cached = localStorage.getItem(SCHEDULE_CACHE_KEY);
  const raw = cached ? JSON.parse(cached) : DEFAULT_SCHEDULE;
  const days = Array.isArray(raw) ? raw : [raw];

  if (!days.length || !Array.isArray(days[0].events)) {
    wrap.innerHTML = '<div class="empty">Нет событий</div>';
    return;
  }

  const now = new Date();
  const curMins = now.getHours() * 60 + now.getMinutes();

  function parseTime(tStr) {
    const m = String(tStr).match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  function getEventState(e, nextE) {
    const start = parseTime(e.time);
    if (start === null) return '';
    let end = null;
    const parts = String(e.time).split('-');
    if (parts.length > 1) {
      end = parseTime(parts[1]);
    } else if (nextE) {
      end = parseTime(nextE.time);
    }
    if (end === null || end < start) end = start + 60;

    if (curMins >= start && curMins < end) return ' ev-now';
    if (start > curMins && (start - curMins) <= 45) return ' ev-soon';
    if (curMins >= end) return ' ev-past';
    return '';
  }

  function renderDay(d, isSingle) {
    let html = '';
    d.events.forEach((e, i) => {
      const nextE = d.events[i + 1];
      const stateClass = getEventState(e, nextE);
      
      let badge = '';
      if (stateClass === ' ev-now') badge = '<div class="ev-badge badge-now">Идёт сейчас</div>';
      else if (stateClass === ' ev-soon') badge = '<div class="ev-badge badge-soon">Скоро</div>';

      html += '<div class="ev' + stateClass + '">' +
        '<div class="ev-time-col"><span class="ev-time">' + escapeHtml(e.time) + '</span></div>' +
        '<div class="ev-info"><span class="ev-title">' + escapeHtml(e.title) + '</span>' + badge + '</div>' +
        '</div>';
    });
    return html;
  }

  if (days.length === 1) {
    const d = days[0];
    wrap.innerHTML =
      '<div class="acc open">' +
      '<div class="acc-head" style="cursor:default"><span>' + escapeHtml(d.day || 'План') + '</span></div>' +
      '<div class="acc-body" style="display:block">' + renderDay(d, true) + '</div></div>';
    return;
  }

  wrap.innerHTML = '';
  days.forEach((day, di) => {
    const item = document.createElement('div');
    item.className = 'acc' + (di === 0 ? ' open' : '');
    
    item.innerHTML =
      '<button class="acc-head" type="button"><span>' + escapeHtml(day.day || 'День ' + (di + 1)) + '</span><i data-feather="chevron-down"></i></button>' +
      '<div class="acc-body">' + renderDay(day, false) + '</div>';
    wrap.appendChild(item);
  });
  if (typeof feather !== 'undefined') feather.replace();
}

function applySchedule(data, showMsg) {
  if (!data) return false;
  const name = data.presetName || data.day || 'Расписание на сегодня';
  if (Array.isArray(data.events)) {
    localStorage.setItem(SCHEDULE_CACHE_KEY, JSON.stringify({ day: name, events: data.events }));
    renderSchedule();
    if (showMsg) showToast('Обновлено: ' + name);
    return true;
  }
  if (Array.isArray(data.days)) {
    localStorage.setItem(SCHEDULE_CACHE_KEY, JSON.stringify(data.days));
    renderSchedule();
    if (showMsg) showToast(name ? 'Обновлено: ' + name : 'Расписание обновлено');
    return true;
  }
  return false;
}

/* Живое расписание: 1 документ schedule/current. Новый пресет появляется
   у участников сразу после выставления (1 чтение на клиента при изменении). */
function subscribeSchedule() {
  listenWithFallback(
    db.collection('schedule').doc('current'),
    (snap) => {
      if (snap.exists) applySchedule(snap.data(), false);
    },
    () => { /* молчим — останется кэш + кнопка «Обновить» */ }
  );
}

/* Технический перерыв: единственный документ config/maintenance (пишет админ).
   Живая подписка — оверлей появляется/исчезает у участников мгновенно,
   без перезагрузки. 1 чтение на клиента при установке списка + при изменении. */
function subscribeMaintenance() {
  listenWithFallback(
    db.doc('config/maintenance'),
    (snap) => {
      const d = (snap.exists && snap.data()) || {};
      setMaintenanceOverlay(d.active === true, d.text || '');
    },
    () => { /* молчим — при недоступности оверлей не показываем */ }
  );
}

function setMaintenanceOverlay(on, text) {
  const el = document.getElementById('maint-overlay');
  if (!el) return;
  if (on) {
    const t = document.getElementById('maint-text');
    if (t && text) t.textContent = text;
    el.style.display = 'flex';
  } else {
    el.style.display = 'none';
  }
}

/* Кнопка «Обновить» — ручной фолбэк к живой подписке */
async function refreshSchedule() {
  if (DEV_MODE) { showToast('DEV_MODE: расписание из кода'); return; }
  if (!db) { showToast('Приложение ещё не готово, обнови страницу', true); return; }
  try {
    const snap = await db.collection('schedule').doc('current').get();
    if (!snap.exists || !applySchedule(snap.exists ? snap.data() : null, true)) {
      showToast('Актуальное расписание ещё не загружено', true);
    }
  } catch (err) {
    showToast('Расписание сейчас недоступно: ' + err.message, true);
  }
}

/* ---------- Рейтинг топ-10 ----------
   БЕЗ live-подписки: живой топ-10 при 150 участниках множил бы чтения
   (каждая запись балла топ-игрока → снапшот всем). Топ-10 приходит из
   ОДНОГО документа-агрегата rating/top10 (пишет админка после начислений) —
   1 чтение вместо 10. Повторные открытия вкладки/тыки по «Обновить» отдаём
   из кэша RATING_TTL — спам-тапами дневной лимит чтений не пробить. */
const RATING_CACHE_KEY = 'mw_rating_cache_v1';
const RATING_TTL = 10 * 60 * 1000;
// Рейтинг округов приходит из ОДНОГО документа-агрегата rating/districts,
// который админка пересчитывает после начислений. 1 чтение вместо ~150.
const DISTRICT_RATING_CACHE_KEY = 'mw_district_rating_v1';
const DISTRICT_RATING_TTL = 10 * 60 * 1000;
let ratingTop = [];        // топ-10 (последний ответ)
let ratingLoading = false;

function districtRatingCached() {
  try {
    const c = JSON.parse(localStorage.getItem(DISTRICT_RATING_CACHE_KEY) || 'null');
    return (c && Array.isArray(c.list) && Date.now() - c.ts < DISTRICT_RATING_TTL) ? c.list : null;
  } catch (e) { return null; }
}

/* Время последней успешной загрузки топ-10 в шапке рейтинга. Берём ts из
   кэша — честно показывает, когда данные реально получены с Firestore. */
function renderRatingFresh() {
  const el = document.getElementById('rating-fresh');
  if (!el) return;
  let ts = 0;
  try { const c = JSON.parse(localStorage.getItem(RATING_CACHE_KEY) || 'null'); if (c) ts = c.ts || 0; } catch (e) {}
  if (!ts) { el.textContent = '–:–'; return; }
  const d = new Date(ts);
  el.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* Организаторы (роль из пикера) скрыты из рейтинга по умолчанию; тумблер
   «Показываться в рейтинге» в настройках доступен только им. Обычные ученики
   не имеют поля showInRating / всегда true — пропускаем только явное false. */
function ratingVisible(u) {
  return u.showInRating !== false;
}

async function loadRating() {
  if (DEV_MODE || ratingLoading) return;
  if (!db) { showToast('Приложение ещё не готово, обнови страницу', true); return; }
  const wrap = document.getElementById('rating');
  try {
    const cached = JSON.parse(localStorage.getItem(RATING_CACHE_KEY) || 'null');
    if (cached && Array.isArray(cached.list) && Date.now() - cached.ts < RATING_TTL) {
      ratingTop = cached.list.filter(ratingVisible);
      renderRating();
      return;
    }
  } catch (e) {}
  ratingLoading = true;
  if (wrap && !wrap.innerHTML.trim()) {
    wrap.innerHTML = '<div class="skel h18"></div><div class="skel h18"></div><div class="skel h18"></div>';
  }
  try {
    // Топ-10 — из агрегата rating/top10 (пишет админка после начислений):
    // 1 документ вместо 10 чтений users. При отсутствии/битом агрегате
    // читаем напрямую (fallback, редкий путь при старом пресете админки).
    const snap = await db.doc('rating/top10').get();
    if (snap.exists && Array.isArray(snap.data().list) && snap.data().list.length) {
      ratingTop = snap.data().list.filter(ratingVisible);
    } else {
      const fallback = await db.collection('users').orderBy('score', 'desc').limit(10).get();
      ratingTop = fallback.docs.map((d) => ({ uid: d.id, ...d.data() })).filter(ratingVisible);
    }
    try { localStorage.setItem(RATING_CACHE_KEY, JSON.stringify({ ts: Date.now(), list: ratingTop })); } catch (e) {}
    renderRating();
  } catch (err) {
    showToast('Рейтинг недоступен', true);
  } finally {
    ratingLoading = false;
  }
}

/* ---------- Рейтинг округов ----------
   Сумма баллов по округам (команда = округ). Приходит из ОДНОГО документа
   rating/districts (агрегат), который админка пересчитывает после начислений —
   так участникам не читать все ~150 документов ради одной цифры. */
async function loadRatingDistricts(force) {
  if (DEV_MODE) return;
  if (!db) return;
  const cached = districtRatingCached();
  if (!force && cached) { renderDistrictRating(); return; }
  try {
    const snap = await db.doc('rating/districts').get();
    const list = snap.exists && Array.isArray(snap.data().list) ? snap.data().list : [];
    try { localStorage.setItem(DISTRICT_RATING_CACHE_KEY, JSON.stringify({ ts: Date.now(), list })); } catch (e) {}
    renderDistrictRating();
  } catch (err) {
    /* молчим — округа останутся «загружаются» */
  }
}

function renderDistrictRating() {
  const wrap = document.getElementById('district-rating');
  if (!wrap) return;
  const rows = districtRatingCached();
  if (!rows) {
    wrap.innerHTML = '<div class="hint">Рейтинг округов загружается…</div>';
    return;
  }
  if (!rows.length) {
    wrap.innerHTML = '<div class="hint">По округам пока нет данных</div>';
    return;
  }
  wrap.innerHTML =
    '<div class="sec-sub" style="margin:18px 0 8px">Рейтинг округов · сумма баллов команды</div>' +
    rows.map((r, i) =>
      '<div class="rate-row">' +
      '<div class="rate-rank">' + (i + 1) + '</div>' +
      '<div class="rate-name"><span class="rate-name-text">' + escapeHtml(r.district) + '</span></div>' +
      '<div class="rate-pts">' + r.score + '</div>' +
      '</div>'
    ).join('');
}

/* ---------- Задания ---------- */
const SEEN_TASKS_KEY = 'mw_seen_tasks_v1';
const TASKS_CACHE_KEY = 'mw_tasks_cache_v1';
let seenTasks = new Set();
let lastTasks = [];
let tasksSubscribed = false;   // не больше одного живого слушателя заданий на устройство

function tasksCache() {
  try { return JSON.parse(localStorage.getItem(TASKS_CACHE_KEY) || 'null'); } catch (e) { return null; }
}

function subscribeTasks(uid) {
  try { seenTasks = new Set(JSON.parse(localStorage.getItem(SEEN_TASKS_KEY) || '[]')); } catch (e) {}
  const cached = tasksCache();
  if (cached && Array.isArray(cached.list) && cached.list.length) renderTasks(cached.list);
  if (tasksSubscribed) return;   // слушатель уже есть — не плодим вторые
  tasksSubscribed = true;
  // Агрегат в tasks/current пишет админ (см. admin.js): 1 документ вместо A документов —
  // это 1 чтение на вход при протухшем кэше, а не ~A.
  // Живая подписка ВСЕГДА активна: кэш служит только для мгновенного рендера,
  // иначе свежий кэш (15 мин) задерживал бы новые задания участникам до протухания.
  listenWithFallback(
    db.doc('tasks/current'),
    (snap) => {
      const data = snap.data() || {};
      const fresh = Array.isArray(data.list) ? data.list.filter((t) => t && t.active) : [];
      try { localStorage.setItem(TASKS_CACHE_KEY, JSON.stringify({ ts: Date.now(), list: fresh })); } catch (e) {}
      // Уведомление о новом задании — один раз за всё время, и не для сделанных
      fresh.forEach((t) => {
        if (taskDone(t)) return;
        if (!seenTasks.has(t.id)) {
          seenTasks.add(t.id);
          try { localStorage.setItem(SEEN_TASKS_KEY, JSON.stringify([...seenTasks])); } catch (e) {}
          showToast('Новое задание: ' + t.text);
        }
      });
      renderTasks(fresh);
    },
    () => showToast('Задания недоступны', true)
  );
}

/* ---------- Помощники заданий: типы, лимит повторов, день ---------- */
function taskLimit(t) {
  return t.type === 'repeat' ? Math.max(1, Number(t.limit) || 3) : 1;
}
function taskCount(t) {
  const c = doneCache[t.id];
  if (typeof c === 'number') return c;
  return c ? 1 : 0;                      // старый кэш {id: true}
}
function taskDone(t) {
  return taskCount(t) >= taskLimit(t);
}

/* Видимость по дню: пусто = всегда; иначе дата (2026-08-15), день недели или
   метка текущего выставленного пресета (напр. «День 1» при «День 1 — Команды»). */
function taskDayVisible(t) {
  if (!t.day || !String(t.day).trim()) return true;
  const want = String(t.day).trim().toLowerCase();
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const ymd = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  if (want === ymd) return true;
  const wd = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'][now.getDay()];
  if (want === wd || want === wd.slice(0, 2)) return true;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(SCHEDULE_CACHE_KEY) || 'null'); } catch (e) {}
  if (cached) {
    const days = Array.isArray(cached) ? cached : [cached];
    const labels = days.map((d) => String((d && d.day) || '').toLowerCase()).filter(Boolean);
    if (labels.some((l) => l.indexOf(want) >= 0 || want.indexOf(l) >= 0)) return true;
  }
  return false;
}

function taskDistrictVisible(t) {
  // Командные задания видны только своей команде (округу).
  if (t.type !== 'district') return true;
  if (!myDistrict || !t.district) return false;
  return String(myDistrict).trim().toLowerCase() === String(t.district).trim().toLowerCase();
}

function renderTasks(list) {
  lastTasks = list;
  const wrap = document.getElementById('tasks');
  const visible = list.filter((t) => taskDayVisible(t) && taskDistrictVisible(t));
  const undone = visible.filter((t) => !taskDone(t));
  const doneCount = visible.length - undone.length;

  if (!undone.length && !doneCount) {
    wrap.innerHTML = '<div class="empty">Заданий пока нет. Отдыхай!</div>';
    return;
  }
  wrap.innerHTML = undone.map((t) => {
    const cnt = taskCount(t);
    const lim = taskLimit(t);
    const isDistrictTask = t.type === 'district';
    const progress = t.type === 'repeat' ? ' <span class="badge badge-on">' + cnt + '/' + lim + '</span>' : '';
    const dayChip = t.day && String(t.day).trim() ? ' <span class="badge badge-off">' + escapeHtml(t.day) + '</span>' : '';
    const teamChip = isDistrictTask ? ' <span class="team-chip">⚑ командное · округ «' + escapeHtml(t.district || '') + '»</span>' : '';
    const isMedia = !!(t.withPhoto || t.withVideo);
    const mediaIcon = isMedia ? '<i data-feather="' + (t.withVideo ? 'video' : 'camera') + '"></i>' : '';
    const mediaLabel = t.withPhoto && t.withVideo ? 'Прикрепить файлы' : (t.withVideo ? 'Прикрепить видео' : 'Прикрепить фото');
    const btnLabel = isDistrictTask ? (cnt > 0 ? 'Отмечено ✓' : (isMedia ? mediaLabel : 'Отметить участие'))
      : (isMedia ? (cnt > 0 ? 'Ещё раз' : mediaLabel) : (cnt > 0 ? 'Ещё раз' : 'Выполнить'));
    return (
      '<div class="card task rise" data-id="' + t.id + '">' +
      '<span class="task-text">' + escapeHtml(t.text) + dayChip + teamChip + '</span>' +
      '<span class="task-pts">+' + t.points + progress + '</span>' +
      '<button class="btn btn-sm' + (isMedia ? ' btn-photo' : '') + '" data-act="do">' + mediaIcon + btnLabel + '</button>' +
      '</div>'
    );
  }).join('') +
  (doneCount
    ? '<div class="hint" style="text-align:center">Выполнено заданий: ' + doneCount + '</div>'
    : '');

  wrap.querySelectorAll('[data-act="do"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.task');
      const id = card.dataset.id;
      const task = list.find((t) => t.id === id);
      btn.disabled = true;
      try {
        if (task.type === 'district' && !(task.withPhoto || task.withVideo)) {
          await signDistrictTask(task);
        } else if (task.withPhoto || task.withVideo) {
          if (mediaSubmitting) return;
          mediaSubmitting = true;
          vkFeedback('click');
          try { await pickTaskMedia(task); } finally { mediaSubmitting = false; }
        } else {
          await doTask(task);
        }
      } finally {
        renderTasks(lastTasks);   // кнопки пересоздаются — никогда не остаются «погасшими»
      }
    });
  });
  if (window.feather) feather.replace();
}

async function doTask(task) {
  const lim = taskLimit(task);
  const next = taskCount(task) + 1;
  if (next > lim) { showToast('Лимит выполнений исчерпан', true); vkFeedback('error'); return; }
  try {
    if (DEV_MODE) {
      const cur = Number(localStorage.getItem('mw_dev_score') || 0) + task.points;
      localStorage.setItem('mw_dev_score', String(cur));
      setScore(cur);
    } else {
      const myUid = 'vk_' + myVkId;
      await db.collection('users').doc(myUid).update({
        score: firebase.firestore.FieldValue.increment(task.points),
        ['done.' + task.id]: firebase.firestore.FieldValue.increment(1),
      });
    }
    doneCache[task.id] = next;
    localStorage.setItem(SELF_DOC_CACHE, JSON.stringify(doneCache));
    renderTasks(lastTasks);                  // обновить счётчик/скрыть сразу
    vkToast('+' + task.points + ' баллов!');
    vkFeedback('success');
    showToast('Задание выполнено: +' + task.points + ' баллов' + (next < lim ? ' (' + next + '/' + lim + ')' : ''));
  } catch (err) {
    showToast('Не удалось выполнить: ' + err.message, true);
  }
}

/* Отметка участия в командном задании (тип district).
   Баллы НЕ начисляются автоматически никому: отметка фиксирует участие
   на устройстве, а организатор начисляет баллы ВСЕЙ команде через
   админку (кнопка «Баллы команде округа»). Лимит — один раз. */
async function signDistrictTask(task) {
  if (!myDistrict) { showToast('Сначала выбери округ', true); return; }
  if (String(myDistrict).trim().toLowerCase() !== String(task.district || '').trim().toLowerCase()) {
    showToast('Задание для команды «' + task.district + '»', true);
    return;
  }
  if (taskDone(task)) { showToast('Участие уже отмечено', true); return; }
  vkFeedback('success');
  doneCache[task.id] = 1;
  try { localStorage.setItem(SELF_DOC_CACHE, JSON.stringify(doneCache)); } catch (e) {}
  renderTasks(lastTasks);
  vkToast('Участие отмечено!');
  showToast('Отмечено. Баллы всей команде начислит организатор');
}

/* ---------- Медиа-отправка заданий ----------
   Фото: камера/галерея → сжатие на клиенте (~1280px JPEG, ~200КБ) →
   base64 в документ заявки submissions/{id} (Storage не включён,
   лимит Firestore 1МБ на документ).
   Видео: тоже base64, но большие ролики режутся на чанки в подколлекции
   submissions/{id}/chunks (каждый документ < 1МБ), бот собирает обратно.
   Бот публикует медиа модератору в VK (см. bot.js). */
const PHOTO_MAX_W = 1280;
const PHOTO_QUALITY = 0.8;
const PHOTO_B64_MAX = 800000;      // ~600КБ фото → лимит документа с запасом
const VIDEO_MAX_BYTES = 15 * 1024 * 1024;  // видео ≤ 15 МБ (чанки ниже)
const CHUNK_B64_MAX = 850000;      // ~850КБ base64 на документ-чанк

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(new Error('не удалось закодировать файл'));
    fr.readAsDataURL(blob);
  });
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(new Error('не удалось прочитать файл'));
    fr.readAsDataURL(file);
  });
}

function chunkB64(b64, maxLen) {
  const out = [];
  for (let i = 0; i < b64.length; i += maxLen) out.push(b64.slice(i, i + maxLen));
  return out;
}

/* Открыть системный пикер. Возвращает Promise: резолвится когда пользователь
   выбрал файлы И отправка завершилась, либо когда отменил пикер (возврат
   фокуса/вкладки без выбора). Нужно, чтобы кнопка не оставалась «погасшей»
   (disabled) после сабмита или отмены — раньше это чинилось только перезагрузкой. */
function pickTaskMedia(task) {
  return new Promise((resolve) => {
    const accept = task.withVideo ? (task.withPhoto ? 'image/*,video/*' : 'video/*') : 'image/*';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    let picked = false;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onVis);
      input.remove();
      resolve();
    };
    const onBack = () => setTimeout(() => { if (!picked) settle(); }, 800);
    const onVis = () => { if (document.visibilityState === 'visible') onBack(); };
    input.addEventListener('change', async () => {
      picked = true;
      const files = input.files ? Array.from(input.files) : [];
      if (files.length) await submitTaskMedia(task, files);
      settle();
    });
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onVis);
    document.body.appendChild(input);
    input.click();
  });
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, PHOTO_MAX_W / (img.width || 1));
      const w = Math.max(1, Math.round((img.width || 1) * scale));
      const h = Math.max(1, Math.round((img.height || 1) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('сжатие не удалось'))), 'image/jpeg', PHOTO_QUALITY);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('не удалось прочитать фото')); };
    img.src = url;
  });
}

async function submitTaskMedia(task, files) {
  if (DEV_MODE) { showToast('DEV: медиа-отправка', false); await doTask(task); return; }
  try {
    showToast('Готовлю файлы…');
    const photos = [];
    const videos = [];
    for (const file of files) {
      if (String(file.type || '').indexOf('video/') === 0) videos.push(file);
      else photos.push(file);
    }
    const photoB64s = [];
    for (const file of photos) {
      const blob = await compressImage(file);
      const photoB64 = await blobToBase64(blob);
      if (photoB64.length > PHOTO_B64_MAX) {
        showToast('Одно из фото слишком тяжёлое, выбери другое', true);
        vkFeedback('error');
        return;
      }
      photoB64s.push(photoB64);
    }
    let videoChunkList = [];
    let videoName = '';
    let videoType = '';
    if (videos.length) {
      const file = videos[0];   // на задание прикрепляется одно видео
      if (file.size > VIDEO_MAX_BYTES) {
        showToast('Видео больше 15 МБ. Сними короткий ролик', true);
        vkFeedback('error');
        return;
      }
      const b64 = await readFileBase64(file);
      videoChunkList = chunkB64(b64, CHUNK_B64_MAX);
      videoName = file.name || 'video.mp4';
      videoType = file.type || 'video/mp4';
    }
    if (!photoB64s.length && !videoChunkList.length) throw new Error('нет файлов');
    const mediaType = videoChunkList.length ? (photoB64s.length ? 'mixed' : 'video') : 'photo';
    const doc = {
      uid: myUid,
      vkId: myVkId,
      name: myName,
      taskId: task.id,
      taskText: task.text,
      points: task.points,
      mediaType: mediaType,
      sent: false,
      state: 'pending',
      ts: firebase.firestore.FieldValue.serverTimestamp(),
    };
    // Командное с медиа: заявка = доказательство участия. Баллы ВСЕЙ команде
    // начислит организатор (noAward — бот не зачисляет их лично участнику).
    if (task.type === 'district') {
      doc.noAward = true;
      doc.district = myDistrict || '';
    }
    // Одно фото живёт в документе, как раньше (бюджетный случай).
    // Несколько фото — в подколлекции chunks (kind:'photo'), чтобы не пробить
    // лимит Firestore 1МБ на документ; их собирает и шлёт бот.
    if (photoB64s.length === 1) doc.photoB64 = photoB64s[0];
    else if (photoB64s.length > 1) doc.photoCount = photoB64s.length;
    if (videoChunkList.length) {
      doc.videoChunks = videoChunkList.length;
      doc.videoName = videoName;
      doc.videoType = videoType;
      if (videoChunkList.length === 1) doc.videoB64 = videoChunkList[0];
    }
    const ref = await db.collection('submissions').add(doc);
    const writeChunks = (arr, kind, prefix) => {
      if (!arr.length) return;
      const batch = db.batch();
      const chunksCol = db.collection('submissions').doc(ref.id).collection('chunks');
      arr.forEach((b64, i) => {
        batch.set(chunksCol.doc(prefix + i), { n: i, kind: kind, uid: myUid, vkId: myVkId, b64: b64 });
      });
      return batch.commit();
    };
    const videoBatch = videoChunkList.length > 1 ? writeChunks(videoChunkList, 'video', 'v') : null;
    const photoBatch = photoB64s.length > 1 ? writeChunks(photoB64s, 'photo', 'p') : null;
    if (videoBatch) await videoBatch;
    if (photoBatch) await photoBatch;

    // «Накопительное с медиа» (повторяемое): каждая успешная заявка = +1 к
    // прогрессу (до лимита N). «Командное с медиа»: заявка = отметка участия.
    // Баллы — по решению модератора (bot.js), не мгновенно.
    if (task.type === 'repeat' || task.type === 'district') {
      doneCache[task.id] = task.type === 'repeat' ? taskCount(task) + 1 : 1;
      try { localStorage.setItem(SELF_DOC_CACHE, JSON.stringify(doneCache)); } catch (e) {}
      if (!DEV_MODE) {
        db.collection('users').doc(myUid).update({
          ['done.' + task.id]: firebase.firestore.FieldValue.increment(1),
        }).catch(() => {});
      }
      renderTasks(lastTasks);
    }

    let doneMsg = mediaType === 'video' ? 'Видео ушло на модерацию!'
      : mediaType === 'mixed' ? 'Фото и видео ушли на модерацию!'
      : 'Фото ушло на модерацию!';
    if (task.type === 'district') {
      doneMsg += ' Участие отмечено — баллы команде начислит организатор.';
    } else if (task.type === 'repeat') {
      doneMsg += ' Заявка учтена (' + taskCount(task) + '/' + taskLimit(task) + ')';
    }
    showToast(doneMsg);
  } catch (err) {
    showToast('Не удалось отправить: ' + err.message, true);
  }
}

/* ---------- Переключение вкладок докбара ---------- */
function initDock() {
  document.querySelectorAll('.dock-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      vkFeedback('click');
      document.querySelectorAll('.dock-item').forEach((b) => b.classList.toggle('on', b === btn));
      document.querySelectorAll('.app-pane').forEach((p) => p.classList.toggle('active', p.dataset.tab === tab));
      if (tab === 'rating') { loadRating(); loadRatingDistricts(); }
    });
  });
}

/* ---------- Настройки (локально, без БД) ---------- */
const SETTINGS_KEY = 'mw_settings_v1';
const DEFAULT_SETTINGS = { vibe: true, sound: true };

function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
  } catch (e) { /* ignore */ }
  return Object.assign({}, DEFAULT_SETTINGS);
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
}

/* Тактильный отклик + звук с учётом настроек. Вне ВК работает только звук. */
function vkFeedback(kind) {
  const s = getSettings();
  if (kind === 'click') {
    if (s.vibe) vkTapticImpact('light');
    if (s.sound) vkSound('click');
    return;
  }
  if (s.vibe) vkTaptic(kind);
  if (s.sound) vkSound(kind);
}

function renderSettings() {
  const s = getSettings();
  document.querySelectorAll('[data-set]').forEach((el) => {
    el.classList.toggle('on', !!s[el.dataset.set]);
  });
  renderRatingToggle();
}

/* Тумблер «Показываться в рейтинге»: виден только организаторам (роль доступна
   исключительно админам из config/admins). Ученики всегда в рейтинге — для них
   строки нет вообще (showInRating всегда true). */
function renderRatingToggle() {
  const row = document.getElementById('set-rating-row');
  const animRow = document.getElementById('set-anim-row');
  if (!row) return;
  const isOrg = myIsAdmin && myRole === ROLE_ORGANIZER;
  row.style.display = isOrg ? 'flex' : 'none';
  row.classList.toggle('on', isOrg && myShowInRating);
  
  if (animRow) {
    animRow.style.display = (isOrg && myShowInRating) ? 'flex' : 'none';
    animRow.classList.toggle('on', myGlowAnim !== false);
  }
}

/* Клик по тумблеру рейтинга (организатор): пишем флаг в профиль, а не в локальные
   настройки — он живёт в БД и виден всем устройствам. */
function bindRatingToggle() {
  const row = document.getElementById('set-rating-row');
  if (!row) return;
  row.addEventListener('click', async () => {
    if (!(myIsAdmin && myRole === ROLE_ORGANIZER)) return;
    vkFeedback('click');
    myShowInRating = !myShowInRating;
    renderRatingToggle();
    if (DEV_MODE) return;
    try {
      await db.collection('users').doc(myUid).update({
        showInRating: myShowInRating, score: myScore, vkId: String(myVkId),
      });
    } catch (err) {
      showToast('Не сохранилось: ' + err.message, true);
      renderRatingToggle();
    }
  });
}

/* Тумблер «Анимация карточки» (организатор): флаг glowAnim живёт в профиле (БД),
   поэтому отключение/включение видно на всех устройствах и сразу. */
function bindAnimToggle() {
  const animRow = document.getElementById('set-anim-row');
  if (!animRow) return;
  animRow.addEventListener('click', async () => {
    if (!(myIsAdmin && myRole === ROLE_ORGANIZER && myShowInRating)) return;
    vkFeedback('click');
    myGlowAnim = (myGlowAnim !== false) ? false : true;
    renderRatingToggle();
    if (DEV_MODE) return;
    try {
      await db.collection('users').doc(myUid).update({
        glowAnim: myGlowAnim !== false, score: myScore, vkId: String(myVkId),
      });
    } catch (err) {
      showToast('Не сохранилось: ' + err.message, true);
      renderRatingToggle();
    }
  });
}

function bindSettings() {
  document.querySelectorAll('[data-set]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.dataset.set;
      const s = getSettings();
      s[key] = !s[key];
      saveSettings(s);
      renderSettings();
      vkFeedback('success');
    });
  });
}

/* ---------- DEV-заглушка данных ---------- */
function seedDevData(uid, vk) {
  const score = Number(localStorage.getItem('mw_dev_score') || 0);
  setScore(score);
  renderRating([{ name: vk.first_name + ' ' + vk.last_name, score: score, avatar: vk.photo_100 || '' }]);
  renderTasks([
    { id: 'dev-1', text: 'Сделай фото заката и покажи соседу', points: 5 },
    { id: 'dev-2', text: 'Найди участника из другого города', points: 10 },
  ]);
}

function renderRating(listOverride) {
  const wrap = document.getElementById('rating');
  const list = listOverride || ratingTop;
  if (!list.length) {
    wrap.innerHTML = '<div class="empty">Пока никого нет — стань первым!</div>';
    return;
  }
  const rows = list.map((u, i) => {
    const rankCls = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : '';
    const me = myVkId && String(u.vkId) === myVkId ? ' rate-me' : '';
    const adminCls = u.role === 'organizer' && u.glowAnim !== false ? ' rate-admin-glow' : '';
    const avatarInner = u.avatar
      ? '<img class="rate-avatar" src="' + escapeHtml(u.avatar) + '" alt="">'
      : '<div class="rate-avatar">' + escapeHtml((u.name || '?')[0]) + '</div>';
    const avatar = '<a href="https://vk.com/id' + u.vkId + '" target="_blank" style="text-decoration:none;display:flex">' + avatarInner + '</a>';
    return (
      '<div class="rate-row' + me + adminCls + '">' +
      '<div class="rate-rank ' + rankCls + '">' + (i + 1) + '</div>' +
      avatar +
      '<div class="rate-name">' +
      '<span class="rate-name-text">' + escapeHtml(u.name || 'Без имени') + '</span>' +
      '</div>' +
      '<div class="rate-pts">' + (u.score || 0) + '</div>' +
      '</div>'
    );
  }).join('');
  wrap.innerHTML = rows;
  renderRatingFresh();
  renderMyRatingBlock();
  renderDistrictRating();
}

/* «Твой блок» под топ-10: место в десятке ИЛИ отставание до неё. Ничего не
   читает из БД — считается из уже загруженного топ-10 и профиля (0 чтений). */
function renderMyRatingBlock() {
  const wrap = document.getElementById('my-rating-block');
  if (!wrap) return;
  if (!myUid) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  if (myShowInRating === false) {
    wrap.innerHTML =
      '<div class="rate-mine"><div class="grow">' +
      '<b>Ты скрыт из рейтинга</b>' +
      '<small>Включи «Показываться в рейтинге» в настройках, и твой блок появится.</small>' +
      '</div></div>';
    return;
  }
  const score = Number(myScore) || 0;
  const idx = ratingTop.findIndex((u) => u.uid === myUid);
  const avatarInner = myAvatar
    ? '<img class="rate-avatar" src="' + escapeHtml(myAvatar) + '" alt="">'
    : '<div class="rate-avatar">' + escapeHtml((myName || '?')[0]) + '</div>';
  let body;
  if (idx >= 0) {
    body = '<b>Ты — на ' + (idx + 1) + '-м месте!</b><small>Баллов: ' + score + '</small>';
  } else {
    const tenth = ratingTop.length ? (Number(ratingTop[ratingTop.length - 1].score) || 0) : 0;
    const need = Math.max(0, tenth - score + 1);
    const dist = myDistrict ? ' · команда «' + escapeHtml(myDistrict) + '»' : '';
    body = '<b>Ты вне топ-10</b><small>До десятки не хватает ' + need + ' баллов' + dist + '</small>';
  }
  wrap.innerHTML = '<div class="rate-mine">' + avatarInner + '<div class="grow">' + body + '</div></div>';
}

/* ---------- Запуск ---------- */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('sched-refresh').addEventListener('click', () => {
    vkFeedback('click');
    refreshSchedule();
  });
  const ratingRefresh = document.getElementById('rating-refresh');
  if (ratingRefresh) {
    ratingRefresh.addEventListener('click', () => {
      vkFeedback('click');
      localStorage.removeItem(RATING_CACHE_KEY);
      loadRating();
      loadRatingDistricts(true);
      renderMyRatingBlock();
    });
  }
  const adminBtn = document.getElementById('btn-admin-open');
  if (adminBtn) {
    adminBtn.addEventListener('click', () => { location.href = 'admin.html' + location.search; });
  }
  const districtRow = document.getElementById('set-district-row');
  if (districtRow) {
    districtRow.addEventListener('click', () => {
      vkFeedback('click');
      showDistrictPicker();
    });
  }
  init();
  renderSettings();
  bindSettings();
  bindRatingToggle();
  bindAnimToggle();
});
