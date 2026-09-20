/* ============================================================
   МедиаволнApp — админ-панель
   Доступ: VK ID из config/admins.
   Управление расписанием, заданиями, участниками, статистикой.
   Голосование на текущем этапе не реализуется.
   ============================================================ */

let db, auth;
let ADMINS = [];
let usersCache = [];             // все участники для поиска
let allTasks = [];               // все задания
let activeTab = 'schedule';

/* ---------- Тосты ---------- */
function showToast(text, isErr) {
  const wrap = document.getElementById('toasts');
  if (!wrap) return;
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

function confirmDialog(message) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      '<div class="modal">' +
      '<p style="margin-bottom:18px">' + message + '</p>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end">' +
      '<button class="btn btn-ghost" data-a="no" type="button">Отмена</button>' +
      '<button class="btn btn-danger" data-a="yes" type="button">Да, точно</button>' +
      '</div></div>';
    document.body.appendChild(back);
    back.querySelector('[data-a="no"]').addEventListener('click', () => { back.remove(); resolve(false); });
    back.querySelector('[data-a="yes"]').addEventListener('click', () => { back.remove(); resolve(true); });
  });
}

/* ---------- Инициализация ---------- */
async function initAdmin() {
  try {
    const vk = await vkGetUser();

    if (!DEV_MODE) {
      firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.firestore();
      // Long-polling вместо websocket (iOS WKWebView внутри VK).
      db.settings({ experimentalForceLongPolling: true });
      auth = firebase.auth();
      await auth.signInAnonymously();

      // 1. Проверка прав: VK ID в списке админов
      const adminsSnap = await db.collection('config').doc('admins').get();
      ADMINS = adminsSnap.exists && Array.isArray(adminsSnap.data().ids) ? adminsSnap.data().ids.map(String) : [];
      if (!ADMINS.includes(String(vk.id))) {
        showAdmin(false, null);
        return;
      }

      // 2. Регистрация текущего анонимного uid как админа (серверная проверка правил)
      await db.collection('config').doc('admins').collection('adminsLive')
        .doc(auth.currentUser.uid)
        .set({ vkId: String(vk.id) });
    } else {
      console.warn('DEV_MODE: Firebase пропущен, проверка админа не выполняется.');
    }

    showAdmin(true, vk);
    bindTabs();
    await Promise.all([loadUsers(), loadTasks()]);
    loadSchedulePanel();
    renderStats();
    switchTab('schedule');
  } catch (err) {
    console.error(err);
    showToast('Ошибка инициализации: ' + err.message, true);
  }
}

/* ---------- Экран доступа ---------- */
function showAdmin(ok, vk) {
  const gate = document.getElementById('gate');
  const panel = document.getElementById('panel');
  if (ok) {
    gate.style.display = 'none';
    panel.style.display = 'block';
    if (vk) {
      const name = (vk.first_name + ' ' + vk.last_name).trim();
      document.getElementById('admin-name').textContent = name;
    }
  } else {
    gate.style.display = 'flex';
    panel.style.display = 'none';
  }
}

/* ---------- Вкладки ---------- */
function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}
function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab-btn').forEach((b) =>
    b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach((p) =>
    p.style.display = p.dataset.pane === name ? 'block' : 'none');
  if (name === 'stats') { loadUsers().then(renderStats); refreshDbStats(); }
}

/* ============================================================
   РАСПИСАНИЕ — пресеты
   Пресет = ОДИН день: { name, events: [{time, title}] }.
   Утром админ выставляет нужный пресет на сегодня (schedule/current).
   Хранение: schedule/{id} с docType='preset'; активный — schedule/current.
   ============================================================ */
let presetsCache = [];      // [{id, name, events, updatedAt}]
let activePreset = null;    // {presetId, presetName, events} из schedule/current
let editPreset = null;      // копия редактируемого пресета
let editId = null;          // id в Firestore (null = новый пресет)

function loadSchedulePanel() {
  if (DEV_MODE) {
    presetsCache = [{ id: 'dev', name: 'День 1 — Знакомство', events: DEFAULT_SCHEDULE.events }];
    activePreset = null;
    renderSchedulePanel();
    return;
  }
  db.collection('schedule').get()
    .then((snap) => {
      presetsCache = [];
      activePreset = null;
      snap.docs.forEach((d) => {
        const data = d.data();
        if (data.docType === 'preset') {
          presetsCache.push({
            id: d.id,
            name: data.name || 'Пресет',
            events: Array.isArray(data.events) ? data.events : [],
            updatedAt: data.updatedAt,
          });
        } else if (d.id === 'current') {
          activePreset = {
            presetId: data.presetId || '',
            presetName: data.presetName || '',
            events: Array.isArray(data.events) ? data.events : [],
          };
        }
      });
      renderSchedulePanel();
    })
    .catch((err) => showToast('Не удалось загрузить пресеты: ' + err.message, true));
}

function renderSchedulePanel() {
  const status = document.getElementById('sched-status');
  if (status) {
    status.innerHTML = activePreset && activePreset.presetName
      ? '<i data-feather="check-circle"></i> Сегодня выставлен: <b>' + escapeHtml(activePreset.presetName) + '</b>'
      : '<i data-feather="info"></i> На сегодня пока ничего не выставлено';
  }
  const wrap = document.getElementById('sched-list');
  if (!presetsCache.length) {
    wrap.innerHTML = '<div class="empty">Пресетов пока нет — создай первый.</div>';
    if (window.feather) feather.replace();
    return;
  }
  wrap.innerHTML = presetsCache.map((p) =>
    '<div class="row-item" style="flex-wrap:wrap">' +
    '<div class="grow"><b>' + escapeHtml(p.name) + '</b>' +
    '<small>' + p.events.length + ' соб. · ' + fmtPresetTime(p.updatedAt) + '</small></div>' +
    '<div class="row-actions">' +
    '<button class="btn btn-sm" data-use="' + p.id + '" type="button">Выставить на сегодня</button>' +
    '<button class="btn btn-ghost btn-sm" data-edit="' + p.id + '" type="button">Редактировать</button>' +
    '<button class="btn btn-danger btn-sm" data-pdel="' + p.id + '" type="button"><i data-feather="trash-2"></i></button>' +
    '</div></div>'
  ).join('');
  if (window.feather) feather.replace();
}

function fmtPresetTime(ts) {
  if (!ts || typeof ts.toDate !== 'function') return '—';
  return 'обновлён ' + ts.toDate().toLocaleDateString('ru-RU');
}

/* ---------- Конструктор пресета (модал): пресет = один день ---------- */
function newPreset() {
  editPreset = {
    name: '',
    events: [{ time: '10:00', title: 'Событие' }],
  };
  editId = null;
  openPresetEditor();
}

function editPresetById(id) {
  const p = presetsCache.find((x) => x.id === id);
  if (!p) return;
  editPreset = JSON.parse(JSON.stringify({ name: p.name, events: p.events }));
  editId = id;
  openPresetEditor();
}

function openPresetEditor() {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.id = 'edit-modal';
  back.innerHTML =
    '<div class="modal">' +
    '<div class="field"><label>Название дня</label>' +
    '<input id="edit-name" class="input" value="' + escapeHtml(editPreset.name) + '" placeholder="Например: День 2 — Команды"></div>' +
    '<div id="edit-events"></div>' +
    '<button id="edit-add-ev" class="btn btn-ghost btn-block" type="button">+ Добавить событие</button>' +
    '<div class="field" style="margin-top:12px"><label>Быстрый ввод из текста</label>' +
    '<textarea id="edit-import" class="input" rows="4" placeholder="10:00 | Открытие слёта&#10;12:30 | Обед&#10;14:00 | Командная игра"></textarea>' +
    '<button id="edit-import-btn" class="btn btn-ghost btn-sm" type="button">Заполнить список из текста</button>' +
    '</div>' +
    '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">' +
    '<button id="edit-cancel" class="btn btn-ghost" type="button">Отмена</button>' +
    '<button id="edit-save" class="btn" type="button">Сохранить пресет</button>' +
    '</div></div>';
  document.body.appendChild(back);

  back.querySelector('#edit-cancel').addEventListener('click', () => back.remove());
  back.querySelector('#edit-save').addEventListener('click', savePreset);
  back.querySelector('#edit-add-ev').addEventListener('click', () => {
    editPreset.events.push({ time: '12:00', title: 'Новое событие' });
    renderEditEvents();
  });
  back.querySelector('#edit-name').addEventListener('input', (e) => {
    editPreset.name = e.target.value;
  });
  const impBtn = back.querySelector('#edit-import-btn');
  if (impBtn) {
    impBtn.addEventListener('click', () => {
      const t = String(back.querySelector('#edit-import').value || '');
      const rows = t.split('\n')
        .map((l) => l.trim()).filter(Boolean)
        .map((l) => {
          const p = l.split('|').map((s) => s.trim());
          return { time: p[0] || '', title: p[1] || '' };
        })
        .filter((e) => e.time && e.title);
      if (!rows.length) { showToast('Формат строки: 10:00 | Событие', true); return; }
      editPreset.events = rows;
      renderEditEvents();
      showToast('Загружено ' + rows.length + ' событий');
    });
  }
  renderEditEvents();
}

function renderEditEvents() {
  const wrap = document.getElementById('edit-events');
  if (!wrap) return;
  wrap.innerHTML = '';
  editPreset.events.forEach((ev, ei) => {
    const row = document.createElement('div');
    row.className = 'row-item';
    row.style.marginTop = '8px';
    row.innerHTML =
      '<input class="input" data-time="' + ei + '" value="' + escapeHtml(ev.time) + '" style="width:76px" placeholder="10:00">' +
      '<input class="input grow" data-title="' + ei + '" value="' + escapeHtml(ev.title) + '" placeholder="Название">' +
      '<button class="btn btn-ghost btn-sm" data-del="' + ei + '" type="button" title="Удалить"><i data-feather="trash-2"></i></button>';
    wrap.appendChild(row);
  });
  document.querySelectorAll('#edit-events [data-time]').forEach((el) => {
    el.addEventListener('input', () => {
      editPreset.events[Number(el.dataset.time)].time = el.value;
    });
  });
  document.querySelectorAll('#edit-events [data-title]').forEach((el) => {
    el.addEventListener('input', () => {
      editPreset.events[Number(el.dataset.title)].title = el.value;
    });
  });
  document.querySelectorAll('#edit-events [data-del]').forEach((el) => {
    el.addEventListener('click', () => {
      editPreset.events.splice(Number(el.dataset.del), 1);
      renderEditEvents();
    });
  });
  if (window.feather) feather.replace();
}

async function savePreset() {
  const name = (editPreset.name || '').trim();
  const events = editPreset.events
    .map((e) => ({ time: e.time, title: e.title }))
    .filter((e) => e.time && e.time.trim() && e.title && e.title.trim());
  if (!name) { showToast('Введи название дня', true); return; }
  if (!events.length) { showToast('Добавь хотя бы одно событие', true); return; }
  try {
    if (DEV_MODE) {
      presetsCache.push({ id: 'dev-' + Date.now(), name: name, events: events, updatedAt: null });
      renderSchedulePanel();
    } else if (editId) {
      await db.collection('schedule').doc(editId).set({
        docType: 'preset', name: name, events: events,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      await db.collection('schedule').add({
        docType: 'preset', name: name, events: events,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
    const modal = document.getElementById('edit-modal');
    if (modal) modal.remove();
    showToast('Пресет сохранён');
    loadSchedulePanel();
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

async function deletePresetById(id) {
  const ok = await confirmDialog('Удалить пресет?');
  if (!ok) return;
  try {
    if (DEV_MODE) {
      presetsCache = presetsCache.filter((p) => p.id !== id);
      renderSchedulePanel();
      return;
    }
    await db.collection('schedule').doc(id).delete();
    showToast('Пресет удалён');
    loadSchedulePanel();
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

async function activatePreset(id) {
  const p = presetsCache.find((x) => x.id === id);
  if (!p) return;
  try {
    if (DEV_MODE) {
      activePreset = { presetId: id, presetName: p.name, events: p.events };
      renderSchedulePanel();
      showToast('Выставлено: ' + p.name);
      return;
    }
    await db.collection('schedule').doc('current').set({
      docType: 'current',
      presetId: id,
      presetName: p.name,
      events: JSON.parse(JSON.stringify(p.events)),
      setAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    showToast('Выставлено на сегодня: ' + p.name);
    loadSchedulePanel();
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

/* ============================================================
   ЗАДАНИЯ
   ============================================================ */
let taskFilter = 'all';

async function loadTasks() {
  try {
    if (DEV_MODE) { allTasks = []; renderTaskList(); return; }
    const snap = await db.collection('tasks').orderBy('createdAt', 'desc').get();
    allTasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTaskList();
    syncTasksAggregate();
  } catch (err) {
    showToast('Не удалось загрузить задания: ' + err.message, true);
  }
}

/* Публичный «агрегат» заданий: участники подписываются на один документ tasks/current
   (1 чтение на вход), а не на запрос по A документам. Синхронится при каждой загрузке
   заданий — т.е. после любого создания/редактирования/переключения/удаления. */
async function syncTasksAggregate() {
  try {
    await db.doc('tasks/current').set({
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      list: allTasks.map((t) => ({
        id: t.id,
        text: t.text,
        points: t.points,
        active: !!t.active,
        type: t.type === 'repeat' ? 'repeat' : (t.type === 'district' ? 'district' : 'once'),
        limit: Math.max(1, Number(t.limit) || 1),
        day: String(t.day || ''),
        district: String(t.district || ''),
        withPhoto: !!t.withPhoto,
        withVideo: !!t.withVideo,
      })),
    });
  } catch (e) {
    /* не критично для админ-панели */
  }
}

/* Короткое описание типа/лимита/дня задания для списка */
function taskMeta(t) {
  const bits = [];
  if (t.type === 'district') bits.push('Командное · округ «' + escapeHtml(String(t.district || '—')) + '»');
  else if (t.type === 'repeat') bits.push('повтор · до ' + Math.max(1, t.limit || 3) + ' раз');
  if (t.day && String(t.day).trim()) bits.push('день: ' + escapeHtml(t.day));
  if (t.withPhoto) bits.push('📷 фото');
  if (t.withVideo) bits.push('🎥 видео');
  return bits.length ? ' · ' + bits.join(' · ') : '';
}

function renderTaskList() {
  const list = allTasks.filter((t) => {
    if (taskFilter === 'active') return t.active;
    if (taskFilter === 'inactive') return !t.active;
    return true;
  });
  const wrap = document.getElementById('tasks-list');
  if (!list.length) {
    wrap.innerHTML = '<div class="empty">Заданий нет</div>';
    return;
  }
  wrap.innerHTML = list.map((t) =>
    '<div class="row-item">' +
    '<div class="grow"><b>' + escapeHtml(t.text) + '</b>' +
    '<small>+' + t.points + ' баллов' + taskMeta(t) + ' · ' + (t.active ? '<span class="badge badge-on">активно</span>' : '<span class="badge badge-off">выкл</span>') + '</small></div>' +
    '<div class="row-actions">' +
    '<button class="btn btn-ghost btn-sm" data-ed="' + t.id + '" type="button">Изменить</button>' +
    '<button class="btn btn-ghost btn-sm" data-tog="' + t.id + '" type="button">' + (t.active ? 'Выключить' : 'Включить') + '</button>' +
    '<button class="btn btn-danger btn-sm" data-del="' + t.id + '" type="button"><i data-feather="trash-2"></i></button>' +
    '</div></div>'
  ).join('');
  if (window.feather) feather.replace();
}

function bindTaskFilter() {
  document.querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      taskFilter = b.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('on', x === b));
      renderTaskList();
    }));
}

/* Разбор массового ввода: одна строка = одно задание, «текст | N» — свои баллы */
function parseTaskLines(raw, defPoints) {
  return String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const parts = l.split('|').map((s) => s.trim());
    const pts = parts.length > 1 && Number(parts[1]) >= 1 ? Number(parts[1]) : Number(defPoints);
    return { text: parts[0], points: pts };
  });
}

async function createTask(text, points, opts) {
  opts = opts || {};
  const type = opts.type === 'repeat' ? 'repeat' : (opts.type === 'district' ? 'district' : 'once');
  const limit = type === 'repeat' ? Math.max(1, Number(opts.limit) || 1) : 1;
  const day = String(opts.day || '').trim();
  const district = type === 'district' ? String(opts.district || '').trim() : '';
  const withPhoto = !!opts.withPhoto;
  const withVideo = !!opts.withVideo;
  try {
    if (DEV_MODE) {
      allTasks.unshift({ id: 'dev-' + Date.now(), text: text, points: points, active: true, type: type, limit: limit, day: day, district: district, withPhoto: withPhoto, withVideo: withVideo });
      renderTaskList(); showToast('DEV: задание добавлено'); return;
    }
    await db.collection('tasks').add({
      text: text,
      points: points,
      active: true,
      type: type,
      limit: limit,
      day: day,
      district: district,
      withPhoto: withPhoto,
      withVideo: withVideo,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    showToast('Задание создано');
    await loadTasks();
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

/* ---------- Редактирование задания (модал) ---------- */
let editTaskId = null;

function openTaskEditor(id) {
  const t = allTasks.find((x) => x.id === id);
  if (!t) return;
  editTaskId = id;
  const type = t.type === 'repeat' ? 'repeat' : (t.type === 'district' ? 'district' : 'once');
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.id = 'edit-task-modal';
  const distOptions = (typeof DISTRICTS !== 'undefined' ? DISTRICTS : [])
    .map((d) => '<option value="' + escapeHtml(d) + '"' + (t.district === d ? ' selected' : '') + '>' + escapeHtml(d) + '</option>')
    .join('');
  back.innerHTML =
    '<div class="modal">' +
    '<div class="field"><label>Текст задания</label>' +
    '<input id="et-text" class="input" value="' + escapeHtml(t.text) + '"></div>' +
    '<div class="row-actions" style="justify-content:flex-start;gap:8px;margin-bottom:12px">' +
    '<div class="field" style="margin:0;width:100px"><label>Баллы</label>' +
    '<input id="et-points" class="input" type="number" min="1" value="' + Number(t.points) + '"></div>' +
    '<div class="field" style="margin:0;width:170px"><label>Тип</label>' +
    '<select id="et-type" class="input"><option value="once"' + (type === 'once' ? ' selected' : '') + '>Обычное</option>' +
    '<option value="repeat"' + (type === 'repeat' ? ' selected' : '') + '>Повторяемое</option>' +
    '<option value="district"' + (type === 'district' ? ' selected' : '') + '>Командное (округ)</option></select></div>' +
    '<div class="field" id="et-limit-wrap" style="margin:0;width:110px' + (type === 'repeat' ? '' : ';display:none') + '"><label>Лимит раз</label>' +
    '<input id="et-limit" class="input" type="number" min="1" value="' + (t.limit || 3) + '"></div>' +
    '<div class="field" id="et-district-wrap" style="margin:0;width:180px' + (type === 'district' ? '' : ';display:none') + '"><label>Округ команды</label>' +
    '<select id="et-district" class="input"><option value="">— округ —</option>' + distOptions + '</select></div>' +
    '</div>' +
    '<div class="field"><label>День действия (пусто = всегда)</label>' +
    '<input id="et-day" class="input" value="' + escapeHtml(t.day || '') + '" placeholder="Любой день · День 1 · 2026-08-15"></div>' +
    '<label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" id="et-active"' + (t.active ? ' checked' : '') + '> Задание активно</label>' +
    '<label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" id="et-photo"' + (t.withPhoto ? ' checked' : '') + '> Требовать фото от участника (кнопка 📷)</label>' +
    '<label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" id="et-video"' + (t.withVideo ? ' checked' : '') + '> Требовать видео от участника (кнопка 🎥)</label>' +
    '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">' +
    '<button id="et-cancel" class="btn btn-ghost" type="button">Отмена</button>' +
    '<button id="et-save" class="btn" type="button">Сохранить</button>' +
    '</div></div>';
  document.body.appendChild(back);

  back.querySelector('#et-cancel').addEventListener('click', () => back.remove());
  back.querySelector('#et-save').addEventListener('click', saveTaskEdit);
  back.querySelector('#et-type').addEventListener('change', (e) => {
    const v = e.target.value;
    document.getElementById('et-limit-wrap').style.display = v === 'repeat' ? 'block' : 'none';
    document.getElementById('et-district-wrap').style.display = v === 'district' ? 'block' : 'none';
  });
}

async function saveTaskEdit() {
  const text = document.getElementById('et-text').value.trim();
  const points = Number(document.getElementById('et-points').value);
  const type = document.getElementById('et-type').value;
  const limit = type === 'repeat' ? Math.max(1, Number(document.getElementById('et-limit').value) || 1) : 1;
  const district = type === 'district' ? String(document.getElementById('et-district').value || '').trim() : '';
  const day = document.getElementById('et-day').value.trim();
  const active = document.getElementById('et-active').checked;
  const withPhoto = document.getElementById('et-photo').checked;
  const withVideo = document.getElementById('et-video').checked;
  if (!text) { showToast('Введи текст задания', true); return; }
  if (!points || points < 1) { showToast('Баллы ≥ 1', true); return; }
  if (type === 'district' && !district) { showToast('Выбери округ команды', true); return; }
  try {
    if (DEV_MODE) {
      const t = allTasks.find((x) => x.id === editTaskId);
      if (t) Object.assign(t, { text: text, points: points, type: type, limit: limit, day: day, district: district, active: active, withPhoto: withPhoto, withVideo: withVideo });
      renderTaskList();
    } else {
      await db.collection('tasks').doc(editTaskId).update({
        text: text,
        points: points,
        type: type,
        limit: limit,
        day: day,
        district: district,
        active: active,
        withPhoto: withPhoto,
        withVideo: withVideo,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
    const modal = document.getElementById('edit-task-modal');
    if (modal) modal.remove();
    showToast('Задание сохранено');
    loadTasks();
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

async function toggleTask(id) {
  const t = allTasks.find((x) => x.id === id);
  if (!t) return;
  try {
    await db.collection('tasks').doc(id).update({ active: !t.active });
    await loadTasks();
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

async function deleteTask(id) {
  const ok = await confirmDialog('Удалить задание?');
  if (!ok) return;
  try {
    await db.collection('tasks').doc(id).delete();
    await loadTasks();
    showToast('Задание удалено');
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

/* ============================================================
   УЧАСТНИКИ
   ============================================================ */
async function loadUsers() {
  try {
    if (DEV_MODE) { usersCache = []; renderUsers(); return; }
    const snap = await db.collection('users').limit(500).get();
    usersCache = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    renderUsers();
  } catch (err) {
    showToast('Не удалось загрузить участников: ' + err.message, true);
  }
}

let userQuery = '';

function renderUsers() {
  const q = userQuery.trim().toLowerCase();
  const list = usersCache.filter((u) =>
    !q ||
    String(u.name || '').toLowerCase().includes(q) ||
    String(u.vkId || '').includes(q)
  );
  const wrap = document.getElementById('users-list');
  if (!list.length) {
    wrap.innerHTML = '<div class="empty">Участники не найдены</div>';
    return;
  }
  wrap.innerHTML = list.map((u) =>
    '<div class="row-item">' +
    '<div class="grow"><b>' + escapeHtml(u.name || 'Без имени') +
    (u.role === 'organizer' ? ' <span class="badge badge-admin">организатор</span>' : '') + '</b>' +
    '<small>VK ID: ' + escapeHtml(String(u.vkId || '—')) + ' · баллов: ' + (u.score || 0) +
    (u.district ? ' · ' + escapeHtml(u.district) : '') + '</small></div>' +
    '<div class="row-actions">' +
    '<button class="btn btn-ghost btn-sm" data-pm="' + u.uid + '" type="button">−1</button>' +
    '<button class="btn btn-ghost btn-sm" data-pp="' + u.uid + '" type="button">+1</button>' +
    '<button class="btn btn-ghost btn-sm" data-toggle-hide="' + u.uid + '" type="button">' + (u.showInRating === false ? 'Вернуть' : 'Скрыть') + '</button>' +
    '<button class="btn btn-ghost btn-sm" data-set="' + u.uid + '" type="button">Установить</button>' +
    '</div></div>'
  ).join('');
  if (window.feather) feather.replace();
}

async function changeUserScore(uid, delta) {
  try {
    await db.collection('users').doc(uid).update({
      score: firebase.firestore.FieldValue.increment(delta),
    });
    await loadUsers();
    syncDistrictsAggregate();
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

async function setUserScore(uid) {
  const u = usersCache.find((x) => x.uid === uid);
  // iOS Safari не поддерживает window.prompt — вместо него своя модалка.
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML =
    '<div class="modal">' +
    '<div class="field"><label>Установить баллы для «' + escapeHtml((u && u.name) || '') + '»</label>' +
    '<input id="ss-input" class="input" type="number" min="0" value="' + escapeHtml(String((u && u.score) || 0)) + '" placeholder="Баллы числом"></div>' +
    '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:12px">' +
    '<button id="ss-cancel" class="btn btn-ghost" type="button">Отмена</button>' +
    '<button id="ss-ok" class="btn" type="button">Установить</button>' +
    '</div></div>';
  document.body.appendChild(back);
  const inp = back.querySelector('#ss-input');
  back.querySelector('#ss-cancel').addEventListener('click', () => back.remove());
  back.querySelector('#ss-ok').addEventListener('click', async () => {
    const value = Number(inp.value);
    if (!isFinite(value) || value < 0) { showToast('Введи число баллов', true); return; }
    back.remove();
    try {
      await db.collection('users').doc(uid).update({ score: value });
      await loadUsers();
      syncDistrictsAggregate();
    } catch (err) {
      showToast('Ошибка: ' + err.message, true);
    }
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') back.querySelector('#ss-ok').click(); });
  inp.focus();
}

async function addToAll() {
  const ok = await confirmDialog('Начислить +5 баллов ВСЕМ участникам?');
  if (!ok) return;
  try {
    const batch = db.batch();
    usersCache.forEach((u) => {
      const ref = db.collection('users').doc(u.uid);
      batch.update(ref, { score: firebase.firestore.FieldValue.increment(5) });
    });
    await batch.commit();
    await loadUsers();
    syncDistrictsAggregate();
    renderStats();
    showToast('Всем начислено +5');
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

/* Начислить баллы ВСЕЙ команде округа (например, за общее видео).
   Округа берём из списка участников + DISTRICTS из Кабинета. */
function addToDistrict() {
  const existing = [...new Set(usersCache.map((u) => String(u.district || '').trim()).filter(Boolean).filter((d) => d !== 'Организатор'))];
  const all = Array.from(new Set([...existing, ...(typeof DISTRICTS !== 'undefined' ? DISTRICTS : [])]));
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML =
    '<div class="modal">' +
    '<div class="field"><label>Округ (команда)</label>' +
    '<select id="dd-district" class="input">' +
    all.map((d) => '<option value="' + escapeHtml(d) + '">' + escapeHtml(d) + '</option>').join('') +
    '</select></div>' +
    '<div class="field"><label>Баллы каждому участнику команды</label>' +
    '<input id="dd-points" class="input" type="number" min="0" value="10" placeholder="Баллы числом"></div>' +
    '<p class="hint" id="dd-hint" style="margin:6px 0 0">Начисляются всем участникам выбранного округа.</p>' +
    '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">' +
    '<button id="dd-cancel" class="btn btn-ghost" type="button">Отмена</button>' +
    '<button id="dd-ok" class="btn" type="button">Начислить</button>' +
    '</div></div>';
  document.body.appendChild(back);
  const sel = back.querySelector('#dd-district');
  const inp = back.querySelector('#dd-points');
  const hint = back.querySelector('#dd-hint');
  const updateHint = () => {
    const d = sel.value;
    const cnt = usersCache.filter((u) => String(u.district || '').trim() === d).length;
    hint.textContent = cnt ? 'Будет начислено ' + cnt + ' участникам команды «' + d + '».' : 'Пока нет участников с округом «' + d + '» — баллы уйдут после выбора округа в приложении.';
  };
  sel.addEventListener('change', updateHint);
  updateHint();
  back.querySelector('#dd-cancel').addEventListener('click', () => back.remove());
  back.querySelector('#dd-ok').addEventListener('click', async () => {
    const d = sel.value;
    const pts = Number(inp.value);
    if (!d) { showToast('Выбери округ', true); return; }
    if (!isFinite(pts) || pts < 0) { showToast('Введи число баллов', true); return; }
    const targets = usersCache.filter((u) => String(u.district || '').trim() === d);
    if (!targets.length) { showToast('Нет участников с округом «' + d + '»', true); return; }
    const ok = await confirmDialog('Начислить +' + pts + ' баллов ' + targets.length + ' участникам команды «' + d + '»?');
    if (!ok) return;
    back.remove();
    try {
      const batch = db.batch();
      targets.forEach((u) => {
        batch.update(db.collection('users').doc(u.uid), { score: firebase.firestore.FieldValue.increment(pts) });
      });
      await batch.commit();
      await loadUsers();
      syncDistrictsAggregate();
      renderStats();
      showToast('Команде «' + d + '» начислено +' + pts);
    } catch (err) {
      showToast('Ошибка: ' + err.message, true);
    }
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') back.querySelector('#dd-ok').click(); });
}

async function resetAllScores() {
  const ok = await confirmDialog('СБРОСИТЬ баллы всех участников в 0? Действие необратимо.');
  if (!ok) return;
  try {
    const batch = db.batch();
    usersCache.forEach((u) => {
      batch.update(db.collection('users').doc(u.uid), { score: 0 });
    });
    await batch.commit();
    await loadUsers();
    syncDistrictsAggregate();
    renderStats();
    showToast('Все баллы сброшены');
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

/* ============================================================
   СТАТИСТИКА
   ============================================================ */
function renderStats() {
  const total = usersCache.length;
  const sum = usersCache.reduce((a, u) => a + (Number(u.score) || 0), 0);
  const top3 = [...usersCache].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)).slice(0, 3);
  const activeTasks = allTasks.filter((t) => t.active).length;

  document.getElementById('stat-users').textContent = total;
  document.getElementById('stat-sum').textContent = sum;
  document.getElementById('stat-tasks').textContent = activeTasks;
  document.getElementById('stat-top3').innerHTML = top3.length
    ? top3.map((u, i) => '<div>' + (i + 1) + '. ' + escapeHtml(u.name || '—') + ' — ' + (u.score || 0) + '</div>').join('')
    : '—';
  renderDistrictStats();
}

/* Сумма баллов по округам (команда = округ) для вкладки «Статистика». */
function districtStats() {
  const agg = {};
  usersCache.forEach((u) => {
    const d = String(u.district || '').trim();
    if (!d || d === 'Организатор') return;
    agg[d] = (agg[d] || 0) + (Number(u.score) || 0);
  });
  return Object.keys(agg)
    .map((name) => ({ district: name, score: agg[name] }))
    .sort((a, b) => b.score - a.score);
}

/* Пересчёт агрегата «rating/districts» — единственный документ, который
   участники читают для рейтинга округов (1 чтение вместо ~150). Вызывается
   после каждой админ-операции, меняющей баллы; usersCache уже обновлён. */
async function syncDistrictsAggregate() {
  if (DEV_MODE) return;
  if (!db) return;
  const rows = districtStats();
  try {
    await db.doc('rating/districts').set({
      list: rows,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    /* молча — следующий пересчёт или ручная кнопка всё поправит */
  }
}

function renderDistrictStats() {
  const wrap = document.getElementById('stat-district');
  if (!wrap) return;
  const rows = districtStats();
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty">У участников пока нет округов</div>';
    return;
  }
  wrap.innerHTML = rows.map((r, i) =>
    '<div class="rate-row">' +
    '<div class="rate-rank">' + (i + 1) + '</div>' +
    '<div class="rate-name"><span class="rate-name-text">' + escapeHtml(r.district) + '</span></div>' +
    '<div class="rate-pts">' + r.score + '</div>' +
    '</div>'
  ).join('');
}

/* ============================================================
   Привязка событий
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  const toApp = document.getElementById('btn-to-app');
  if (toApp) {
    toApp.addEventListener('click', () => { location.href = 'index.html' + location.search; });
  }
  document.getElementById('btn-new-preset').addEventListener('click', newPreset);
  document.getElementById('btn-add-task').addEventListener('click', () => {
    const raw = document.getElementById('task-text').value;
    const defPoints = Number(document.getElementById('task-points').value);
    const type = document.getElementById('task-type').value;
    const limit = Number(document.getElementById('task-limit').value);
    const district = document.getElementById('task-district').value;
    const day = document.getElementById('task-day').value;
    const withPhoto = document.getElementById('task-photo').checked;
    const withVideo = document.getElementById('task-video').checked;
    const rows = parseTaskLines(raw, defPoints);
    if (!rows.length) { showToast('Введи текст задания', true); return; }
    if (rows.some((r) => !r.points || r.points < 1)) {
      showToast('Баллы ≥ 1: задай поле «Баллы» или «| N» в строке', true);
      return;
    }
    if (type === 'district' && !district) { showToast('Выбери округ команды', true); return; }
    rows.forEach((r) => createTask(r.text, r.points, { type: type, limit: limit, day: day, district: district, withPhoto: withPhoto, withVideo: withVideo }));
    document.getElementById('task-text').value = '';
    document.getElementById('task-day').value = '';
  });
  const taskTypeEl = document.getElementById('task-type');
  const taskLimitWrap = document.getElementById('task-limit-wrap');
  const taskDistrictWrap = document.getElementById('task-district-wrap');
  if (taskTypeEl && taskLimitWrap) {
    const toggleLimit = () => {
      const v = taskTypeEl.value;
      taskLimitWrap.style.display = v === 'repeat' ? 'block' : 'none';
      if (taskDistrictWrap) taskDistrictWrap.style.display = v === 'district' ? 'block' : 'none';
    };
    taskTypeEl.addEventListener('change', toggleLimit);
    toggleLimit();
  }
  const taskDistSel = document.getElementById('task-district');
  if (taskDistSel && typeof DISTRICTS !== 'undefined') {
    DISTRICTS.forEach((d) => {
      const o = document.createElement('option');
      o.value = d;
      o.textContent = d;
      taskDistSel.appendChild(o);
    });
  }
  bindTaskFilter();

  document.getElementById('btn-add-all').addEventListener('click', addToAll);
  document.getElementById('btn-add-district').addEventListener('click', addToDistrict);
  document.getElementById('btn-reset-all').addEventListener('click', resetAllScores);
  document.getElementById('btn-export-csv').addEventListener('click', exportUsersCSV);
  document.getElementById('btn-clean-archive').addEventListener('click', clearArchivedSubmissions);
  document.getElementById('btn-refresh-districts').addEventListener('click', () => {
    loadUsers().then(() => syncDistrictsAggregate().then(() => showToast('Рейтинг округов обновлён')));
  });
  document.getElementById('btn-destroy-all').addEventListener('click', openDestroyAllWizard);
  document.getElementById('btn-db-refresh').addEventListener('click', refreshDbStats);

  document.getElementById('users-search').addEventListener('input', (e) => {
    userQuery = e.target.value;
    renderUsers();
  });

  document.addEventListener('click', async (e) => {
    const use = e.target.closest('[data-use]');
    if (use) { activatePreset(use.dataset.use); return; }
    const pedit = e.target.closest('[data-edit]');
    if (pedit) { editPresetById(pedit.dataset.edit); return; }
    const pdel = e.target.closest('[data-pdel]');
    if (pdel) { deletePresetById(pdel.dataset.pdel); return; }
    const del = e.target.closest('[data-del]');
    if (del && del.dataset.del) { deleteTask(del.dataset.del); return; }
    const ed = e.target.closest('[data-ed]');
    if (ed) { openTaskEditor(ed.dataset.ed); return; }
    const tog = e.target.closest('[data-tog]');
    if (tog) { toggleTask(tog.dataset.tog); return; }
    const pm = e.target.closest('[data-pm]');
    if (pm) { changeUserScore(pm.dataset.pm, -1); return; }
    const pp = e.target.closest('[data-pp]');
    if (pp) { changeUserScore(pp.dataset.pp, 1); return; }
    const set = e.target.closest('[data-set]');
    if (set) { setUserScore(set.dataset.set); return; }
    const th = e.target.closest('[data-toggle-hide]');
    if (th) { toggleUserHide(th.dataset.toggleHide); return; }
  });

  initAdmin();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function toggleUserHide(uid) {
  const u = usersCache.find(x => x.uid === uid);
  if (!u) return;
  const newVal = u.showInRating === false ? true : false;
  try {
    await db.collection('users').doc(uid).update({ showInRating: newVal });
    await loadUsers();
    syncDistrictsAggregate();
    renderStats();
  } catch(e) {
    showToast('Ошибка', true);
  }
}

/* ============================================================
   ПОЛЕЗНЫЕ ДЕЙСТВИЯ
   ============================================================ */

/* Пакетная отправка удалений (Firestore: batch ≤ 500 операций) */
async function batchDeleteRefs(refs) {
  for (let i = 0; i < refs.length; i += 450) {
    const b = db.batch();
    refs.slice(i, i + 450).forEach((r) => b.delete(r));
    await b.commit();
  }
}

/* Экспорт участников в CSV (UTF-8 BOM, чтобы Excel понимал кириллицу).
   Одна строка = участник; без приватных данных: только имя, VK ID, округ, баллы, видимость. */
function exportUsersCSV() {
  const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const rows = [
    ['Имя', 'VK ID', 'Профиль', 'Округ', 'Баллы', 'В рейтинге'].map(esc).join(';'),
    ...usersCache.map((u) => [
      u.name || '',
      String(u.vkId || ''),
      'https://vk.com/id' + (u.vkId || ''),
      String(u.district || ''),
      Number(u.score) || 0,
      u.showInRating === false ? 'скрыт' : 'да',
    ].map(esc).join(';')),
  ];
  const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mediavolnapp_users_' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  showToast('CSV скачан (' + usersCache.length + ' уч.)');
}

/* Очистить архив заявок на модерацию: всё, что уже обработано (state ≠ pending),
   вместе с чанками видео. Ожидание модератора остаётся нетронутым. */
async function clearArchivedSubmissions() {
  const ok = await confirmDialog('Удалить обработанные заявки на модерацию (архив)? Находящиеся на модерации не тронем.');
  if (!ok) return;
  try {
    const snap = await db.collection('submissions').get();
    const refs = [];
    for (const d of snap.docs) {
      const data = d.data() || {};
      if (data.state && data.state !== 'pending') {
        const cs = await db.collection('submissions').doc(d.id).collection('chunks').get();
        cs.docs.forEach((c) => refs.push(c.ref));
        refs.push(d.ref);
      }
    }
    await batchDeleteRefs(refs);
    showToast('Архив очищен: удалено ' + refs.length + ' документов');
  } catch (err) {
    showToast('Ошибка: ' + err.message, true);
  }
}

/* ============================================================
   ОПАСНАЯ ЗОНА — сброс АБСОЛЮТНО всех данных слёта
   Удаляются: schedule/* (пресеты + current), tasks/* (+ tasks/current),
   users/*, submissions/* и подколлекции chunks.
   config/admins НЕ удаляется — иначе текущий админ потеряет доступ.
   Подтверждение: ровно 10 вопросов подряд. Необратимо.
   ============================================================ */
const DESTROY_STEPS = [
  'Вы уверены, что хотите сбросить АБСОЛЮТНО все данные слёта?',
  'Вы точно уверены? Обратной дороги не будет.',
  'Расписание и все пресеты будут удалены безвозвратно.',
  'Все задания и выдача участникам — тоже удалятся.',
  'Все участники, их баллы и прогресс сотрутся начисто.',
  'Все фото и видео-заявки на модерацию пропадут.',
  'Участники начнут с чистого листа и снова выберут округа.',
  'Это самая опасная кнопка во всём приложении.',
  'Осталось два шага. Уверены на 100%?',
  'Последний раз спрашиваю: вы ТОЧНО уверены?'
];

function openDestroyAllWizard() {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.id = 'destroy-wizard';

  const progress = DESTROY_STEPS.map(() => '<div class="dz-dot"></div>').join('');
  back.innerHTML =
    '<div class="modal">' +
    '<div class="dz-head"><i data-feather="alert-triangle"></i><div class="grow"><b>Сброс всех данных</b></div></div>' +
    '<p class="dz-q" id="dz-q">' + DESTROY_STEPS[0] + '</p>' +
    '<div class="dz-list">' +
    '<span>Расписание и пресеты</span>' +
    '<span>Задания и tasks/current</span>' +
    '<span>Участники, баллы, выполнение</span>' +
    '<span>Фото/видео-заявки на модерацию</span>' +
    '</div>' +
    '<div class="dz-progress" id="dz-progress">' + progress + '</div>' +
    '<p class="dz-note">Список организаторов (config/admins) сохранён — иначе вы потеряете доступ к панели.</p>' +
    '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">' +
    '<button class="btn btn-ghost" id="dz-cancel" type="button">Нет, хватит</button>' +
    '<button class="btn btn-block" id="dz-ok" type="button">Дальше (1/10)</button>' +
    '</div></div>';
  document.body.appendChild(back);

  let step = 0;
  const q = back.querySelector('#dz-q');
  const dots = back.querySelector('#dz-progress').children;
  const okBtn = back.querySelector('#dz-ok');

  back.querySelector('#dz-cancel').addEventListener('click', () => back.remove());

  okBtn.addEventListener('click', async () => {
    if (step < DESTROY_STEPS.length) {
      step++;
      q.textContent = 'Вы' + (step < DESTROY_STEPS.length
        ? '' : ' прошли все проверки. Последний шаг — всё будет удалено безвозвратно.');
      if (step < DESTROY_STEPS.length) q.textContent = DESTROY_STEPS[step];
      for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i < step);
      if (step < DESTROY_STEPS.length) {
        okBtn.textContent = 'Дальше (' + (step + 1) + '/' + DESTROY_STEPS.length + ')';
      } else {
        okBtn.textContent = 'СБРОСИТЬ ВСЕ ДАННЫЕ';
        okBtn.classList.add('btn-danger');
        okBtn.classList.add('dz-big');
      }
      return;
    }
    const risk = await confirmDialog('Финальное подтверждение: удалить ВСЕ данные слёта без возможности восстановления?');
    if (!risk) return;
    okBtn.disabled = true;
    okBtn.textContent = 'Удаляю…';
    try {
      await destroyAllData();
      back.remove();
      showToast('Все данные слёта сброшены');
      setTimeout(() => location.reload(), 1500);
    } catch (err) {
      okBtn.disabled = false;
      okBtn.textContent = 'СБРОСИТЬ ВСЕ ДАННЫЕ';
      showToast('Не удалось сбросить: ' + err.message, true);
    }
  });
}

async function destroyAllData() {
  const deleteCollection = async (name, sub) => {
    const snap = await db.collection(name).get();
    if (sub && name === 'submissions') {
      const extra = [];
      for (const d of snap.docs) {
        const cs = await db.collection(name + '/' + d.id + '/' + sub).get();
        cs.docs.forEach((cDoc) => extra.push(cDoc.ref));
      }
      await batchDeleteRefs(extra);
    }
    await batchDeleteRefs(snap.docs.map((d) => d.ref));
  };
  await deleteCollection('schedule');
  await deleteCollection('tasks');
  await deleteCollection('users');
  await deleteCollection('submissions', 'chunks');
  await db.doc('rating/districts').delete().catch(() => {});
}

/* ============================================================
   СТАТИСТИКА БАЗЫ ДАННЫХ
   Считает документы в коллекциях + примерный размер (байты).
   Лимиты бесплатного Firestore (Spark) выводит для ориентира:
   хранилище 1 ГБ, чтений 50К/день, записей 20К/день, удалений 20К/день.
   ============================================================ */
const DB_LIMITS_STORAGE = 1024 * 1024 * 1024;   // 1 GiB
const DB_LIMITS_READ = 50000;
const DB_LIMITS_WRITE = 20000;

async function refreshDbStats() {
  const wrap = document.getElementById('db-stats');
  if (!wrap) return;
  try {
    wrap.innerHTML = '<div class="empty">Подсчёт…</div>';
    const rows = [];
    let totalBytes = 0;
    let totalDocs = 0;
    for (const name of ['schedule', 'tasks', 'users', 'submissions']) {
      const snap = await db.collection(name).get();
      let bytes = 0;
      snap.docs.forEach((d) => {
        try { bytes += JSON.stringify(d.data() || {}).length; } catch (e) {}
      });
      totalBytes += bytes;
      totalDocs += snap.size;
      rows.push({ name, docs: snap.size, bytes });
    }
    // config — правила разрешают только точечное чтение config/admins
    try {
      const adminsDoc = await db.doc('config/admins').get();
      if (adminsDoc.exists) {
        const bytes = JSON.stringify(adminsDoc.data() || {}).length;
        totalBytes += bytes;
        totalDocs += 1;
        rows.push({ name: 'config/admins', docs: 1, bytes });
      }
    } catch (e) {}
    // подколлекция chunk'ов (медиа-заявки)
    const subs = await db.collection('submissions').get();
    let chunkBytes = 0;
    let chunkDocs = 0;
    for (const d of subs.docs) {
      const cs = await db.collection('submissions/' + d.id + '/chunks').get();
      cs.docs.forEach((c) => {
        chunkDocs++;
        try { chunkBytes += JSON.stringify(c.data() || {}).length; } catch (e) {}
      });
    }
    if (chunkDocs) {
      totalBytes += chunkBytes;
      totalDocs += chunkDocs;
      rows.push({ name: 'chunks', docs: chunkDocs, bytes: chunkBytes });
    }
    const fmtB = (b) => b >= 1048576 ? (b / 1048576).toFixed(2) + ' МБ' : b >= 1024 ? (b / 1024).toFixed(1) + ' КБ' : b + ' Б';
    const pct = Math.min(100, Math.round((totalBytes / DB_LIMITS_STORAGE) * 1000) / 10);
    wrap.innerHTML = rows.length
      ? '<table class="db-table"><tbody>' +
        rows.map((r) =>
          '<tr><td>' + escapeHtml(r.name) + '</td><td class="db-num">' + r.docs + ' док.</td><td class="db-num">' + fmtB(r.bytes) + '</td></tr>'
        ).join('') +
        '<tr class="db-total"><td>Итого</td><td class="db-num">' + totalDocs + ' док.</td><td class="db-num">' + fmtB(totalBytes) + '</td></tr>' +
        '</tbody></table>'
      : '<div class="empty">База пуста</div>';
    document.getElementById('db-storage-fill').style.width = pct + '%';
    document.getElementById('db-storage-fill').classList.toggle('hot', pct >= 50);
    const cap = document.getElementById('db-caption');
    cap.textContent = 'Хранилище ~' + fmtB(totalBytes) + ' из 1 ГБ (' + pct + '%) · лимиты Spark: чтений 50К/день, записей 20К/день, удалений 20К/день';
  } catch (err) {
    wrap.innerHTML = '<div class="empty">Не удалось подсчитать: ' + escapeHtml(err.message) + '</div>';
  }
}
