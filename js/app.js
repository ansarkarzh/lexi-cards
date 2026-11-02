(function () {
  'use strict';

  const C = window.Core;
  const Cloud = window.LexiCloud || { enabled: false };
  const STORAGE_KEY = 'lexi.v1';
  const DEFAULT_SETTINGS = { direction: 'en-ru', autoSpeak: false, onlyUnlearned: false, voice: '' };
  const CAN_SPEAK = 'speechSynthesis' in window;
  const MATCH_SIZE = 6;
  const SYNC_DELAY_MS = 1500;
  const SYNC_RETRY_MS = 15000;
  const REFRESHABLE_VIEWS = ['', 'set', 'account'];

  const MODES = [
    { id: 'cards', icon: '🃏', title: 'Карточки', desc: 'Переворачивайте и отмечайте, что знаете' },
    { id: 'learn', icon: '🎯', title: 'Заучивание', desc: 'Сначала выбор, затем написание' },
    { id: 'choice', icon: '☑️', title: 'Выбор ответа', desc: 'Один из четырёх вариантов' },
    { id: 'write', icon: '⌨️', title: 'Написание', desc: 'Введите перевод сами' },
    { id: 'tf', icon: '⚖️', title: 'Верно / неверно', desc: 'Правильная ли это пара?' },
    { id: 'match', icon: '🧩', title: 'Подбор', desc: 'Соедините пары на время' },
  ];

  const DIRECTIONS = [
    ['en-ru', 'EN → RU'],
    ['ru-en', 'RU → EN'],
    ['mix', 'Вперемешку'],
  ];

  const app = document.getElementById('app');
  const footer = document.getElementById('footer');
  const store = load();
  let keyHandler = null;
  let timers = [];
  let voices = [];
  let user = null;
  let syncTimer = null;
  let syncing = false;
  let syncAgain = false;
  let syncStatus = 'idle';

  function load() {
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (e) {
      data = null;
    }

    if (!data || !Array.isArray(data.sets)) {
      data = { sets: [] };
    }
    data.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    data.owner = data.owner || null;
    data.dirty = data.dirty || {};
    data.deleted = data.deleted || [];
    return data;
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }

  function touch(set) {
    store.dirty[set.id] = (store.dirty[set.id] || 0) + 1;
    save();
    scheduleSync(SYNC_DELAY_MS);
  }

  function removeSet(set) {
    store.sets = store.sets.filter(other => other !== set);
    delete store.dirty[set.id];
    if (store.owner) {
      store.deleted.push(set.id);
    }
    save();
    scheduleSync(SYNC_DELAY_MS);
  }

  function clearLocalSets() {
    store.sets = [];
    store.dirty = {};
    store.deleted = [];
    store.owner = null;
    save();
  }

  function setSyncStatus(status) {
    syncStatus = status;
    renderFooter();
  }

  function scheduleSync(delay) {
    if (!user) {
      return;
    }
    clearTimeout(syncTimer);
    syncTimer = setTimeout(flush, delay);
  }

  async function flush() {
    clearTimeout(syncTimer);
    if (!user) {
      return;
    }
    if (syncing) {
      syncAgain = true;
      return;
    }

    const dirty = { ...store.dirty };
    const deleted = store.deleted.slice();
    const changed = store.sets.filter(set => dirty[set.id]);
    if (!changed.length && !deleted.length) {
      return;
    }

    syncing = true;
    setSyncStatus('syncing');
    try {
      if (changed.length) {
        await Cloud.upsertSets(changed);
      }
      if (deleted.length) {
        await Cloud.deleteSets(deleted);
      }

      Object.keys(dirty).forEach(id => {
        if (store.dirty[id] === dirty[id]) {
          delete store.dirty[id];
        }
      });
      store.deleted = store.deleted.filter(id => !deleted.includes(id));
      save();
      setSyncStatus('ok');
    } catch (e) {
      console.error('Sync failed', e);
      setSyncStatus('error');
      scheduleSync(SYNC_RETRY_MS);
    } finally {
      syncing = false;
    }

    if (syncAgain) {
      syncAgain = false;
      await flush();
    }
  }

  async function pull() {
    try {
      const remote = await Cloud.fetchSets();
      const local = new Map(store.sets.map(set => [set.id, set]));
      const remoteIds = new Set(remote.map(set => set.id));

      const merged = remote
        .filter(set => !store.deleted.includes(set.id))
        .map(set => (store.dirty[set.id] && local.get(set.id)) || set);
      const unsynced = store.sets.filter(set => store.dirty[set.id] && !remoteIds.has(set.id));

      store.sets = merged.concat(unsynced);
      save();
      if (syncStatus !== 'error') {
        setSyncStatus('ok');
      }
    } catch (e) {
      console.error('Pull failed', e);
      setSyncStatus('error');
    }
  }

  async function handleUser(next) {
    const previous = user;
    user = next;

    if (!user) {
      if (store.owner) {
        clearLocalSets();
      }
      setSyncStatus('idle');
      if (previous) {
        location.hash = '#/';
      }
      refreshView();
      return;
    }

    if (previous && previous.id === user.id) {
      return;
    }

    if (store.owner !== user.id) {
      if (store.owner) {
        clearLocalSets();
      }
      store.sets.forEach(set => {
        store.dirty[set.id] = 1;
      });
      store.owner = user.id;
      save();
    }

    if (location.hash.startsWith('#/login')) {
      location.hash = '#/';
    }

    setSyncStatus('syncing');
    await flush();
    await pull();
    refreshView();
  }

  function refreshView() {
    const view = location.hash.replace(/^#\/?/, '').split('/')[0];
    if (REFRESHABLE_VIEWS.includes(view)) {
      route();
    }
  }

  function renderFooter() {
    if (!Cloud.enabled) {
      footer.textContent = 'Наборы и прогресс хранятся только в этом браузере';
      return;
    }
    if (!user) {
      footer.innerHTML = 'Наборы хранятся в этом браузере. <a href="#/login">Войдите</a>, чтобы синхронизировать их между устройствами';
      return;
    }

    const texts = {
      idle: '☁ Синхронизация включена',
      syncing: '☁ Синхронизация…',
      ok: '☁ Всё сохранено в облаке',
      error: '⚠ Нет связи с сервером — изменения сохранены в браузере и отправятся позже',
    };
    footer.textContent = texts[syncStatus];
  }

  function makeSet(title, pairs) {
    return { id: C.uid(), title, cards: C.mergeCards([], pairs) };
  }

  function findSet(id) {
    return store.sets.find(set => set.id === id);
  }

  function $(selector) {
    return app.querySelector(selector);
  }

  function bind(selector, handler) {
    const element = $(selector);
    if (element) {
      element.onclick = handler;
    }
  }

  function later(fn, ms) {
    timers.push(setTimeout(fn, ms));
  }

  function clearTimers() {
    timers.forEach(id => {
      clearTimeout(id);
      clearInterval(id);
    });
    timers = [];
  }

  function esc(value) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value).replace(/[&<>"']/g, ch => map[ch]);
  }

  function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) {
      return one;
    }
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
      return few;
    }
    return many;
  }

  function wordsCount(n) {
    return `${n} ${plural(n, 'слово', 'слова', 'слов')}`;
  }

  function percent(part, total) {
    return total ? Math.round((part / total) * 100) : 0;
  }

  function toast(text) {
    const element = document.createElement('div');
    element.className = 'toast';
    element.textContent = text;
    document.body.appendChild(element);
    setTimeout(() => element.remove(), 2200);
  }

  function speak(text, lang) {
    if (!CAN_SPEAK) {
      return;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang === 'ru' ? 'ru-RU' : 'en-US';
    utterance.rate = 0.9;

    const voice = lang === 'ru' ? null : currentVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    speechSynthesis.speak(utterance);
  }

  function loadVoices() {
    voices = C.rankVoices(speechSynthesis.getVoices());
    const select = $('#opt-voice');
    if (select) {
      select.innerHTML = voiceOptionsHtml();
    }
  }

  function currentVoice() {
    return voices.find(voice => voice.voiceURI === store.settings.voice) || voices[0] || null;
  }

  function voiceOptionsHtml() {
    if (!voices.length) {
      return '<option value="">Голос по умолчанию</option>';
    }
    const selected = currentVoice();
    return voices.map(voice =>
      `<option value="${esc(voice.voiceURI)}"${voice === selected ? ' selected' : ''}>${esc(voice.name)} (${esc(voice.lang)})</option>`).join('');
  }

  function speakButton(text, lang) {
    if (!CAN_SPEAK || lang !== 'en') {
      return '';
    }
    return `<button class="speak" type="button" data-speak="${esc(text)}" data-lang="${lang}" title="Озвучить">🔊</button>`;
  }

  function termHtml(text, lang) {
    return `<span>${esc(text)}</span>${speakButton(text, lang)}`;
  }

  function levelDots(card) {
    const level = card.level || 0;
    return `<span class="dots" title="Уровень ${level} из ${C.MAX_LEVEL}">${'●'.repeat(level)}<span class="off">${'●'.repeat(C.MAX_LEVEL - level)}</span></span>`;
  }

  function wordRow(card) {
    return `
      <li>
        <span class="w-en">${termHtml(card.en, 'en')}</span>
        <span class="w-ru">${esc(card.ru)}</span>
        ${levelDots(card)}
      </li>`;
  }

  function isContinueKey(event) {
    return event.key === 'Enter' || event.key === ' ';
  }

  function encodeShare(set) {
    const text = `${set.title}\n${C.serializeCards(set.cards)}`;
    let binary = '';
    new TextEncoder().encode(text).forEach(byte => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeShare(data) {
    const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    const text = new TextDecoder().decode(Uint8Array.from(binary, ch => ch.charCodeAt(0)));
    const [title, ...lines] = text.split('\n');
    return { title: title.trim(), cards: C.parseCards(lines.join('\n')).cards };
  }

  async function share(set) {
    const url = `${location.origin}${location.pathname}#/import/${encodeShare(set)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Ссылка на набор скопирована');
    } catch (e) {
      prompt('Скопируйте ссылку на набор:', url);
    }
  }

  function route() {
    clearTimers();
    keyHandler = null;
    if (CAN_SPEAK) {
      speechSynthesis.cancel();
    }

    const [view, id, mode] = location.hash.replace(/^#\/?/, '').split('/');
    const set = id ? findSet(id) : null;

    if (view === 'new') {
      renderEdit(null);
    } else if (view === 'edit' && set) {
      renderEdit(set);
    } else if (view === 'set' && set) {
      renderSet(set);
    } else if (view === 'study' && set) {
      renderStudy(set, mode);
    } else if (view === 'import' && id) {
      renderImport(id);
    } else if (view === 'login' && Cloud.enabled && !user) {
      renderLogin();
    } else if (view === 'account' && user) {
      renderAccount();
    } else {
      renderHome();
    }

    window.scrollTo(0, 0);
  }

  function renderHome() {
    const tiles = store.sets.map(set => {
      const learned = set.cards.filter(C.isLearned).length;
      const pct = percent(learned, set.cards.length);
      return `
        <a class="set-tile" href="#/set/${set.id}">
          <div class="set-title">${esc(set.title)}</div>
          <div class="muted">${wordsCount(set.cards.length)} · выучено ${pct}%</div>
          <div class="bar"><div style="width:${pct}%"></div></div>
        </a>`;
    }).join('');

    const empty = `
      <div class="empty">
        <p>Здесь будут ваши наборы слов.</p>
        <p>Создайте набор, добавьте английские слова с переводом и учите их в разных режимах.</p>
        <a class="btn primary" href="#/new">Создать первый набор</a>
      </div>`;

    let account = '';
    if (user) {
      account = `<a class="btn" href="#/account" title="${esc(Cloud.loginOf(user))}">☁ ${esc(Cloud.loginOf(user))}</a>`;
    } else if (Cloud.enabled) {
      account = '<a class="btn" href="#/login">Войти</a>';
    }

    app.innerHTML = `
      <header class="top">
        <h1>🃏 Lexi</h1>
        <div class="top-actions">
          ${account}
          <a class="btn primary" href="#/new">+ Новый набор</a>
        </div>
      </header>
      ${tiles ? `<div class="grid">${tiles}</div>` : empty}`;
  }

  function authErrorText(error) {
    const texts = {
      invalid_credentials: 'Неверный логин или пароль',
      user_already_exists: 'Такой логин уже занят',
      weak_password: 'Слишком простой пароль: нужно минимум 6 символов',
      over_request_rate_limit: 'Слишком много попыток, подождите минуту',
      signup_disabled: 'Регистрация новых аккаунтов выключена в настройках Supabase',
      email_not_confirmed: 'В Supabase включено подтверждение email — выключите его',
      confirmation_required: 'В Supabase включено подтверждение email — выключите его',
    };
    return texts[error.code] || texts[error.message] || `Ошибка: ${error.message || error}`;
  }

  function renderLogin() {
    app.innerHTML = `
      <header class="top"><a class="back" href="#/">← Назад</a></header>
      <h2>Вход</h2>
      <p class="muted">Впервые здесь — придумайте логин и пароль и нажмите «Создать аккаунт». Наборы из этого браузера сохранятся в аккаунт. Восстановить забытый пароль нельзя.</p>
      <form id="login-form" class="edit">
        <input id="login-name" required autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="Логин"
          pattern="[A-Za-z0-9._\-]{3,32}" title="От 3 до 32 латинских букв, цифр и символов . _ -">
        <input id="login-password" type="password" required minlength="6" autocomplete="current-password" placeholder="Пароль (минимум 6 символов)">
        <div class="actions">
          <button class="btn primary" value="in">Войти</button>
          <button class="btn" value="up">Создать аккаунт</button>
        </div>
        <div id="login-info"></div>
      </form>`;

    const info = $('#login-info');
    $('#login-name').focus();

    $('#login-form').onsubmit = async event => {
      event.preventDefault();
      const buttons = [...app.querySelectorAll('#login-form button')];
      const login = $('#login-name').value.trim();
      const password = $('#login-password').value;
      const isSignUp = event.submitter && event.submitter.value === 'up';

      buttons.forEach(button => { button.disabled = true; });
      info.className = 'muted';
      info.textContent = isSignUp ? 'Создаём аккаунт…' : 'Входим…';
      try {
        await (isSignUp ? Cloud.signUp(login, password) : Cloud.signIn(login, password));
      } catch (e) {
        info.className = 'bad-text';
        info.textContent = authErrorText(e);
        buttons.forEach(button => { button.disabled = false; });
      }
    };
  }

  function renderAccount() {
    app.innerHTML = `
      <header class="top"><a class="back" href="#/">← Все наборы</a></header>
      <h2>Аккаунт</h2>
      <p>Логин: <b>${esc(Cloud.loginOf(user))}</b></p>
      <p class="muted">${esc(footer.textContent)}</p>
      <div class="actions">
        <button class="btn" id="sync-now">↻ Синхронизировать сейчас</button>
        <button class="btn danger" id="logout">Выйти</button>
      </div>
      <p class="hint left">После выхода наборы удалятся из этого браузера, но останутся в аккаунте.</p>`;

    bind('#sync-now', async () => {
      await flush();
      await pull();
      route();
    });
    bind('#logout', async () => {
      await flush();
      const unsynced = Object.keys(store.dirty).length || store.deleted.length;
      if (unsynced && !confirm('Часть изменений ещё не отправлена в облако и пропадёт. Всё равно выйти?')) {
        return;
      }
      await Cloud.signOut();
    });
  }

  function renderSet(set) {
    const settings = store.settings;
    const total = set.cards.length;
    const learned = set.cards.filter(C.isLearned).length;
    const record = set.bestMatch ? ` · рекорд подбора ${set.bestMatch.toFixed(1)} с` : '';

    const modes = MODES.map(mode => `
      <a class="mode" href="#/study/${set.id}/${mode.id}">
        <span class="mode-icon">${mode.icon}</span>
        <span><b>${mode.title}</b><span class="muted">${mode.desc}</span></span>
      </a>`).join('');

    const directionOptions = DIRECTIONS.map(([value, title]) =>
      `<option value="${value}"${settings.direction === value ? ' selected' : ''}>${title}</option>`).join('');

    const study = `
      <div class="modes">${modes}</div>
      <div class="options-row">
        <label>Направление <select id="opt-dir">${directionOptions}</select></label>
        <label><input type="checkbox" id="opt-only"${settings.onlyUnlearned ? ' checked' : ''}> Только невыученные</label>
        ${CAN_SPEAK ? `<label><input type="checkbox" id="opt-speak"${settings.autoSpeak ? ' checked' : ''}> Озвучивать английский</label>` : ''}
      </div>
      ${CAN_SPEAK ? `
      <div class="options-row">
        <label>Голос <select id="opt-voice">${voiceOptionsHtml()}</select></label>
        <button class="btn small" type="button" id="voice-test">▶ Прослушать</button>
      </div>` : ''}`;

    app.innerHTML = `
      <header class="top"><a class="back" href="#/">← Все наборы</a></header>
      <section>
        <h2>${esc(set.title)}</h2>
        <div class="muted">${wordsCount(total)} · выучено ${learned} из ${total}${record}</div>
        <div class="bar"><div style="width:${percent(learned, total)}%"></div></div>
      </section>
      ${total ? study : '<p class="empty">В наборе пока нет слов — добавьте их в редакторе.</p>'}
      <div class="actions">
        <a class="btn" href="#/edit/${set.id}">✏️ Редактировать</a>
        ${total ? '<button class="btn" id="share">🔗 Поделиться</button>' : ''}
        ${total ? '<button class="btn" id="reset">↺ Сбросить прогресс</button>' : ''}
        <button class="btn danger" id="delete">Удалить</button>
      </div>
      ${total ? `<h3>Слова</h3><ul class="words">${set.cards.map(wordRow).join('')}</ul>` : ''}`;

    const onChange = (selector, apply) => {
      const element = $(selector);
      if (element) {
        element.onchange = () => {
          apply(element);
          save();
        };
      }
    };
    onChange('#opt-dir', el => { settings.direction = el.value; });
    onChange('#opt-only', el => { settings.onlyUnlearned = el.checked; });
    onChange('#opt-speak', el => { settings.autoSpeak = el.checked; });
    onChange('#opt-voice', el => {
      settings.voice = el.value;
      speak(set.cards[0].en, 'en');
    });
    bind('#voice-test', () => speak(set.cards[0].en, 'en'));

    bind('#share', () => share(set));
    bind('#reset', () => {
      if (!confirm('Сбросить прогресс по всем словам набора?')) {
        return;
      }
      set.cards.forEach(card => { card.level = 0; });
      delete set.bestMatch;
      touch(set);
      renderSet(set);
    });
    bind('#delete', () => {
      if (!confirm(`Удалить набор «${set.title}»?`)) {
        return;
      }
      removeSet(set);
      location.hash = '#/';
    });
  }

  function renderEdit(set) {
    app.innerHTML = `
      <header class="top"><a class="back" href="${set ? `#/set/${set.id}` : '#/'}">← Назад</a></header>
      <h2>${set ? 'Редактирование набора' : 'Новый набор'}</h2>
      <form id="edit-form" class="edit">
        <input id="edit-title" placeholder="Название набора, например «Еда»" value="${set ? esc(set.title) : ''}">
        <textarea id="edit-words" rows="14" placeholder="apple — яблоко&#10;to run — бежать, бегать&#10;beautiful = красивый">${set ? esc(C.serializeCards(set.cards)) : ''}</textarea>
        <p class="hint left">
          По одной паре на строку: английское слово или фраза, затем перевод через тире, «=» или табуляцию.
          Можно вставить две колонки из Excel или Google Таблиц.
          Несколько вариантов перевода пишите через запятую — в режиме «Написание» засчитается любой.
        </p>
        <div id="edit-info" class="muted"></div>
        <div><button class="btn primary">Сохранить</button></div>
      </form>`;

    const textarea = $('#edit-words');
    const info = $('#edit-info');
    const refresh = () => {
      const { cards, errors } = C.parseCards(textarea.value);
      const problems = errors.length
        ? `<div class="bad-text">Не найден перевод в ${plural(errors.length, 'строке', 'строках', 'строках')}: ${errors.map(e => e.line).join(', ')}</div>`
        : '';
      info.innerHTML = `Распознано пар: <b>${cards.length}</b>${problems}`;
    };
    textarea.oninput = refresh;
    refresh();

    if (!set) {
      $('#edit-title').focus();
    }

    $('#edit-form').onsubmit = event => {
      event.preventDefault();
      const { cards, errors } = C.parseCards(textarea.value);
      if (errors.length && !confirm(`Строки без перевода (${errors.length}) будут пропущены. Сохранить?`)) {
        return;
      }

      const title = $('#edit-title').value.trim() || 'Без названия';
      let target = set;
      if (target) {
        target.title = title;
        target.cards = C.mergeCards(target.cards, cards);
      } else {
        target = makeSet(title, cards);
        store.sets.push(target);
      }
      touch(target);
      location.hash = `#/set/${target.id}`;
    };
  }

  function renderImport(data) {
    let shared = null;
    try {
      shared = decodeShare(data);
    } catch (e) {
      shared = null;
    }

    const header = '<header class="top"><a class="back" href="#/">← Все наборы</a></header>';
    if (!shared || !shared.cards.length) {
      app.innerHTML = `${header}<p class="empty">Ссылка на набор повреждена.</p>`;
      return;
    }

    app.innerHTML = `
      ${header}
      <h2>${esc(shared.title || 'Без названия')}</h2>
      <p class="muted">С вами поделились набором: ${wordsCount(shared.cards.length)}</p>
      <div class="actions">
        <button class="btn primary" id="add">Добавить в мои наборы</button>
        <a class="btn" href="#/">Отмена</a>
      </div>
      <ul class="words">${shared.cards.map(wordRow).join('')}</ul>`;

    bind('#add', () => {
      const set = makeSet(shared.title || 'Без названия', shared.cards);
      store.sets.push(set);
      touch(set);
      location.hash = `#/set/${set.id}`;
    });
  }

  function renderStudy(set, modeId) {
    const mode = MODES.find(m => m.id === modeId);
    if (!mode || !set.cards.length) {
      location.hash = `#/set/${set.id}`;
      return;
    }

    let cards = set.cards;
    if (store.settings.onlyUnlearned) {
      const unlearned = cards.filter(card => !C.isLearned(card));
      if (unlearned.length) {
        cards = unlearned;
      } else {
        toast('Все слова выучены — повторяем весь набор');
      }
    }

    app.innerHTML = `
      <header class="top study-top">
        <a class="back" href="#/set/${set.id}" title="Выйти">✕</a>
        <div class="study-title">${mode.icon} ${mode.title}<span class="muted"> · ${esc(set.title)}</span></div>
        <div class="counter" id="counter"></div>
      </header>
      <div class="progress"><div id="pbar"></div></div>
      <main id="stage"></main>`;

    const ui = { stage: $('#stage'), counter: $('#counter'), pbar: $('#pbar') };
    if (mode.id === 'cards') {
      runCards(set, cards, ui);
    } else if (mode.id === 'match') {
      runMatch(set, cards, ui);
    } else {
      runQuiz(set, cards, mode.id, ui);
    }
  }

  function setProgress(ui, done, total, fraction) {
    ui.counter.textContent = `${done} / ${total}`;
    ui.pbar.style.width = `${Math.round((fraction ?? done / total) * 100)}%`;
  }

  function runCards(set, cards, ui) {
    clearTimers();
    keyHandler = null;

    const deck = C.shuffle(cards);
    const known = [];
    const learning = [];
    let index = 0;

    function show() {
      setProgress(ui, index, deck.length);
      if (index >= deck.length) {
        finish();
        return;
      }

      const card = deck[index];
      const sides = C.sides(card, store.settings.direction);
      let flipped = false;

      ui.stage.innerHTML = `
        <div class="flip" id="flip">
          <div class="flip-inner">
            <div class="face front">${termHtml(sides.prompt, sides.promptLang)}</div>
            <div class="face back">${termHtml(sides.answer, sides.answerLang)}</div>
          </div>
        </div>
        <div class="row">
          <button class="btn bad" id="no">← Ещё учу</button>
          <button class="btn good" id="yes">Знаю →</button>
        </div>
        <p class="hint">Пробел или клик — перевернуть, стрелки ← / → — оценить</p>`;

      const flip = $('#flip');
      const toggle = () => {
        flipped = !flipped;
        flip.classList.toggle('flipped', flipped);
        if (flipped && store.settings.autoSpeak && sides.answerLang === 'en') {
          speak(sides.answer, 'en');
        }
      };
      const mark = ok => {
        C.grade(card, ok);
        touch(set);
        (ok ? known : learning).push(card);
        index++;
        show();
      };

      flip.addEventListener('click', event => {
        if (!event.target.closest('[data-speak]')) {
          toggle();
        }
      });
      bind('#no', () => mark(false));
      bind('#yes', () => mark(true));

      keyHandler = event => {
        if (event.key === ' ' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          toggle();
        } else if (event.key === 'ArrowLeft' || event.key === '1') {
          mark(false);
        } else if (event.key === 'ArrowRight' || event.key === '2') {
          mark(true);
        }
      };

      if (store.settings.autoSpeak && sides.promptLang === 'en') {
        speak(sides.prompt, 'en');
      }
    }

    function finish() {
      keyHandler = null;
      ui.stage.innerHTML = `
        <div class="result">
          <h2>Карточки пройдены!</h2>
          <div class="score">
            <span class="good-text">Знаю: ${known.length}</span>
            <span class="bad-text">Ещё учу: ${learning.length}</span>
          </div>
          <div class="row">
            ${learning.length ? '<button class="btn primary" id="again-hard">Повторить «ещё учу»</button>' : ''}
            <button class="btn" id="again">Начать заново</button>
            <a class="btn" href="#/set/${set.id}">К набору</a>
          </div>
        </div>`;
      bind('#again-hard', () => runCards(set, learning, ui));
      bind('#again', () => runCards(set, cards, ui));
    }

    show();
  }

  function runQuiz(set, cards, mode, ui) {
    clearTimers();
    keyHandler = null;

    const session = C.createSession(cards, mode);
    let locked = false;

    function next() {
      clearTimers();
      setProgress(ui, session.finished, session.total, C.sessionProgress(session));
      if (!session.queue.length) {
        finish();
        return;
      }

      locked = false;
      keyHandler = null;
      const question = C.buildQuestion(session.queue[0].card, C.currentType(session), set.cards, store.settings.direction);
      const label = question.type === 'tf'
        ? 'Верный ли это перевод?'
        : `Переведите на ${question.answerLang === 'ru' ? 'русский' : 'английский'}`;

      ui.stage.innerHTML = `
        <div class="prompt">
          <div class="muted">${label}</div>
          <div class="term">${termHtml(question.prompt, question.promptLang)}</div>
        </div>
        <div id="answer"></div>
        <div id="feedback" class="feedback"></div>`;

      if (question.type === 'choice') {
        askChoice(question);
      } else if (question.type === 'write') {
        askWrite(question);
      } else {
        askTrueFalse(question);
      }

      if (store.settings.autoSpeak && question.promptLang === 'en') {
        speak(question.prompt, 'en');
      }
    }

    function commit(question, ok) {
      C.grade(question.card, ok);
      touch(set);
      C.submit(session, ok);
    }

    function resolve(question, ok, extra = {}) {
      locked = true;

      if (ok && !extra.typo) {
        commit(question, true);
        $('#feedback').innerHTML = '<div class="good-text">✓ Верно!</div>';
        keyHandler = event => {
          if (isContinueKey(event)) {
            event.preventDefault();
            next();
          }
        };
        later(next, 800);
        return;
      }

      const title = ok ? '✓ Засчитано, но с опечаткой' : '✗ Неверно';
      $('#feedback').innerHTML = `
        <div class="panel ${ok ? 'good' : 'bad'}">
          <div class="${ok ? 'good-text' : 'bad-text'}">${title}</div>
          ${extra.yours ? `<div>Ваш ответ: <s>${esc(extra.yours)}</s></div>` : ''}
          <div>Правильно: <b>${esc(question.prompt)} — ${esc(question.answer)}</b></div>
          <div class="row">
            ${extra.canOverride ? '<button class="btn" id="override">Мой ответ верный</button>' : ''}
            <button class="btn primary" id="continue">Продолжить ↵</button>
          </div>
        </div>`;

      const proceed = result => {
        commit(question, result);
        next();
      };
      bind('#continue', () => proceed(ok));
      bind('#override', () => proceed(true));
      keyHandler = event => {
        if (isContinueKey(event)) {
          event.preventDefault();
          proceed(ok);
        }
      };
    }

    function askChoice(question) {
      const box = $('#answer');
      box.className = 'options';
      box.innerHTML = question.options.map((option, i) =>
        `<button class="option" type="button"><span class="key">${i + 1}</span><span>${esc(option)}</span></button>`).join('');

      const buttons = [...box.children];
      const pick = picked => {
        if (locked) {
          return;
        }
        buttons.forEach((button, i) => {
          button.disabled = true;
          if (question.options[i] === question.answer) {
            button.classList.add('correct');
          } else if (i === picked) {
            button.classList.add('wrong');
          }
        });
        resolve(question, question.options[picked] === question.answer);
      };

      buttons.forEach((button, i) => {
        button.onclick = () => pick(i);
      });
      keyHandler = event => {
        const number = Number(event.key);
        if (number >= 1 && number <= question.options.length) {
          pick(number - 1);
        }
      };
    }

    function askWrite(question) {
      const box = $('#answer');
      box.innerHTML = `
        <form class="write" id="write-form">
          <input id="write-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
            placeholder="Ответ на ${question.answerLang === 'en' ? 'английском' : 'русском'}">
          <button class="btn primary">Ответить</button>
        </form>
        <button class="link" type="button" id="idk">Не знаю</button>`;

      const input = $('#write-input');
      input.focus();

      $('#write-form').onsubmit = event => {
        event.preventDefault();
        const value = input.value.trim();
        if (locked || !value) {
          return;
        }

        input.disabled = true;
        const result = C.checkAnswer(value, question.answer);
        if (result === 'wrong') {
          resolve(question, false, { yours: value, canOverride: true });
        } else {
          resolve(question, true, { typo: result === 'typo' });
        }
      };

      bind('#idk', () => {
        if (!locked) {
          input.disabled = true;
          resolve(question, false);
        }
      });
    }

    function askTrueFalse(question) {
      $('.prompt').insertAdjacentHTML('beforeend', `<div class="tf-shown">${termHtml(question.shown, question.answerLang)}</div>`);
      $('#answer').innerHTML = `
        <div class="row">
          <button class="btn bad" type="button" id="tf-no">← Неверно</button>
          <button class="btn good" type="button" id="tf-yes">Верно →</button>
        </div>`;

      const pick = said => {
        if (!locked) {
          resolve(question, said === question.isTrue);
        }
      };
      bind('#tf-no', () => pick(false));
      bind('#tf-yes', () => pick(true));
      keyHandler = event => {
        if (event.key === 'ArrowLeft' || event.key === '1') {
          pick(false);
        } else if (event.key === 'ArrowRight' || event.key === '2') {
          pick(true);
        }
      };
    }

    function finish() {
      keyHandler = null;
      const missed = session.items.filter(item => item.misses > 0).map(item => item.card);
      const clean = session.total - missed.length;

      ui.stage.innerHTML = `
        <div class="result">
          <h2>${missed.length ? 'Готово!' : 'Без единой ошибки! 🎉'}</h2>
          <p class="score">С первого раза: <b>${clean}</b> из ${session.total}</p>
          ${missed.length ? `<h3>Были ошибки</h3><ul class="words">${missed.map(wordRow).join('')}</ul>` : ''}
          <div class="row">
            ${missed.length ? '<button class="btn primary" id="again-missed">Повторить ошибки</button>' : ''}
            <button class="btn" id="again">Ещё раз</button>
            <a class="btn" href="#/set/${set.id}">К набору</a>
          </div>
        </div>`;
      bind('#again-missed', () => runQuiz(set, missed, mode, ui));
      bind('#again', () => runQuiz(set, cards, mode, ui));
    }

    next();
  }

  function runMatch(set, cards, ui) {
    clearTimers();
    keyHandler = null;

    const source = cards.length >= 2 ? cards : set.cards;
    const picked = C.shuffle(source).slice(0, MATCH_SIZE);
    if (picked.length < 2) {
      ui.stage.innerHTML = '<p class="empty">Для подбора нужно хотя бы 2 слова.</p>';
      return;
    }

    const tiles = C.shuffle(picked.flatMap(card => [{ id: card.id, text: card.en }, { id: card.id, text: card.ru }]));
    const start = Date.now();
    let penalty = 0;
    let left = picked.length;
    let selected = null;

    ui.stage.innerHTML = `
      <p class="hint">Нажмите на слово, а затем на его перевод. Ошибка — плюс секунда.</p>
      <div class="match-grid">${tiles.map(tile => `<button class="tile" type="button">${esc(tile.text)}</button>`).join('')}</div>`;

    const buttons = [...ui.stage.querySelectorAll('.tile')];
    const elapsed = () => (Date.now() - start + penalty) / 1000;
    const tick = () => {
      ui.counter.textContent = `${elapsed().toFixed(1)} с`;
    };
    ui.pbar.style.width = '0%';
    tick();
    timers.push(setInterval(tick, 100));

    buttons.forEach((button, i) => {
      button.onclick = () => {
        if (selected === null) {
          selected = i;
          button.classList.add('selected');
          return;
        }

        const first = buttons[selected];
        first.classList.remove('selected');
        if (selected === i) {
          selected = null;
          return;
        }

        if (tiles[selected].id === tiles[i].id) {
          [first, button].forEach(el => {
            el.classList.add('matched');
            el.disabled = true;
          });
          left--;
          ui.pbar.style.width = `${percent(picked.length - left, picked.length)}%`;
        } else {
          penalty += 1000;
          [first, button].forEach(el => {
            el.classList.add('miss');
            later(() => el.classList.remove('miss'), 400);
          });
        }
        selected = null;

        if (!left) {
          finish();
        }
      };
    });

    function finish() {
      clearTimers();
      const time = Math.round(elapsed() * 10) / 10;
      const best = set.bestMatch;
      const isRecord = !best || time < best;
      if (isRecord) {
        set.bestMatch = time;
        touch(set);
      }

      ui.counter.textContent = `${time.toFixed(1)} с`;
      ui.stage.innerHTML = `
        <div class="result">
          <h2>${isRecord ? 'Новый рекорд! 🏆' : 'Готово!'}</h2>
          <p class="score">Время: <b>${time.toFixed(1)} с</b>${isRecord ? '' : ` · рекорд ${best.toFixed(1)} с`}</p>
          <div class="row">
            <button class="btn primary" id="again">Ещё раз</button>
            <a class="btn" href="#/set/${set.id}">К набору</a>
          </div>
        </div>`;
      bind('#again', () => runMatch(set, cards, ui));
    }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-speak]');
    if (button) {
      event.preventDefault();
      speak(button.dataset.speak, button.dataset.lang);
    }
  });

  document.addEventListener('keydown', event => {
    if (keyHandler && !event.metaKey && !event.ctrlKey && !event.altKey) {
      keyHandler(event);
    }
  });

  document.addEventListener('visibilitychange', async () => {
    if (!user) {
      return;
    }
    await flush();
    if (document.visibilityState === 'visible') {
      await pull();
      refreshView();
    }
  });

  window.addEventListener('online', () => flush());
  window.addEventListener('hashchange', route);

  if (CAN_SPEAK) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  }

  renderFooter();
  route();

  if (Cloud.enabled) {
    Cloud.onAuthChange(handleUser);
  }
})();
