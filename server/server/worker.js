/**
 * «Лудка» — сервер (Cloudflare Worker + база D1).
 *
 * Что делает:
 *  - хранит баланс и прогресс игроков, решает исход каждого раунда (подделать результат с телефона нельзя);
 *  - продаёт бемки, оформление и VIP за Telegram Stars, следит за лимитами покупок, делает возвраты;
 *  - общий джекпот слотов, рейтинги, друзья, приглашения, подарки, звания недели.
 *
 * Настройки (Settings → Variables and Secrets в Cloudflare):
 *  BOT_TOKEN       — токен бота из @BotFather (секрет)
 *  WEBHOOK_SECRET  — любая длинная случайная строка (секрет)
 *  APP_URL         — адрес игры на GitHub Pages, например https://login.github.io/ludka/
 *  GAME_URL        — ссылка на бота, например https://t.me/LudkaCasinoGame_Bot
 *  ALLOWED_ORIGIN  — откуда открывается игра, например https://login.github.io
 *  ADMIN_ID        — ваш числовой Telegram ID (для /refund и /stats)
 *  SUPPORT_CONTACT — куда писать по оплате, например @bemizaru
 * Привязка базы (Bindings → D1 database): имя переменной DB.
 * Расписание (Triggers → Cron): 5 21 * * SUN — звания недели (понедельник 00:05 по Москве).
 */

/* ENGINE:BEGIN */
/* ================= Движок Лудки: правила, экономика, исходы =================
 * Один и тот же код работает на сервере (Cloudflare Worker) и в браузере (демо без сервера).
 * Всё, что меняет баланс, решается здесь. Экран только показывает результат.
 * E.act(P, действие, параметры, ctx) → { r: результат, ev: события }
 */
const E = (() => {
  "use strict";
  let R = n => Math.floor(Math.random() * n), NOW = Date.now(), CTX = {};
  const rand = n => R(n);
  const fail = (msg, code = 400) => { const e = new Error(msg); e.user = true; e.code = code; throw e; };

  /* ---------- время (Москва) ---------- */
  const TZ = 3 * 3600e3;
  const dayOf = t => new Date(t + TZ).toISOString().slice(0, 10);
  const today = () => dayOf(NOW), month = () => today().slice(0, 7), yesterday = () => dayOf(NOW - 864e5);
  function isoWeek(t = NOW) {
    const d = new Date(t + TZ), x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - day);
    const y = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
    return x.getUTCFullYear() + "-W" + String(Math.ceil(((x - y) / 864e5 + 1) / 7)).padStart(2, "0");
  }
  function weekEnd(t = NOW) { const d = new Date(t + TZ), day = d.getUTCDay() || 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 8) - TZ; }

  /* ---------- настройки ---------- */
  const START_CHIPS = 5000, MIN_BET = 10, MAX_BET = 10000, MAX_TABLE = 100000;
  const PACKS = [{ id: "c5k", chips: 5000, stars: 25 }, { id: "c25k", chips: 25000, stars: 100 }, { id: "c50k", chips: 50000, stars: 200 }];
  const DAY_LIMIT_STARS = 200, MONTH_LIMIT_STARS = 1000;
  const RG_DAY = [200, 100, 50, 0], RG_MONTH = [1000, 500, 200, 0], RG_REMIND = [0, 30, 60, 120], H24 = 864e5;
  const GAME_NAMES = { slots: "Neon 777", reef: "Сокровища рифа", roul: "Рулетка", bj: "Таверна «21»", wheel: "Колесо удачи", crash: "Самолётик", mines: "Минное поле", plinko: "Звездопад", road: "Через дорогу", tower: "Ледяная башня", scratch: "Золотой билет" };
  const STATEFUL = ["bj", "crash", "road", "mines", "tower", "reef", "wheel"];

  /* ---------- уровни, задания, бонусы ---------- */
  const xpNeed = l => 150 + (l - 1) * 75;
  const xpFor = bet => Math.max(5, Math.min(35, Math.round(10 * (1 + Math.log10(Math.max(1, bet) / 10)))));
  const levelReward = l => Math.min(5000, 300 * l);
  const levelTitle = l => l >= 30 ? "Амбассадор микрозаймов" : l >= 20 ? "Игрок" : l >= 10 ? "Лудоман" : l >= 5 ? "Лудик" : "Недолудик";
  const Q_A = [{ id: "rounds20", t: "Сыграйте 20 раундов", goal: 20, k: "rounds", r: 500 }, { id: "rounds50", t: "Сыграйте 50 раундов", goal: 50, k: "rounds", r: 1000 },
    { id: "games3", t: "Сыграйте в 3 разные игры", goal: 3, k: "games", r: 600 }, { id: "games5", t: "Сыграйте в 5 разных игр", goal: 5, k: "games", r: 1000 }];
  const Q_B = [{ id: "wins5", t: "Выиграйте 5 раз", goal: 5, k: "wins", r: 500 }, { id: "wins15", t: "Выиграйте 15 раз", goal: 15, k: "wins", r: 1000 },
    { id: "mult5", t: "Выиграйте с множителем ×5 или выше", goal: 5, k: "mult", r: 800 }, { id: "mult20", t: "Выиграйте с множителем ×20 или выше", goal: 20, k: "mult", r: 1500 },
    { id: "profit2k", t: "Выиграйте в сумме 2 000 бемок", goal: 2000, k: "profit", r: 700 }];
  const Q_ALL_BONUS = 1000;
  function qDef(id) {
    if (id.startsWith("g:")) return { id, t: `Сыграйте 10 раундов в «${GAME_NAMES[id.slice(2)]}»`, goal: 10, k: id, r: 500 };
    return [...Q_A, ...Q_B].find(q => q.id === id);
  }
  const qProgress = (P, id) => { const d = qDef(id), v = P.q.c[d.k]; return Array.isArray(v) ? v.length : Math.floor(v || 0); };
  const qAllDone = P => P.q.list.every(id => P.q.done.includes(id));
  const STREAK = [1000, 1200, 1500, 1800, 2200, 2600, 3000];
  const FW = [[500, 30], [1000, 25], [1500, 18], [2000, 12], [3000, 8], [5000, 4.5], [10000, 2], [25000, 0.5]];

  /* ---------- достижения ---------- */
  const ACH = [
    { g: "Начало", id: "first_round", i: "🎲", t: "Первый шаг", d: "Сыграйте первый раунд", r: 100 },
    { g: "Начало", id: "first_win", i: "🎉", t: "Первая победа", d: "Выиграйте в первый раз", r: 200 },
    { g: "Начало", id: "explorer", i: "🧭", t: "Турист", d: "Сыграйте во все 11 игр", r: 2000, p: P => [P.ach.c.games.length, 11] },
    { g: "Начало", id: "rounds100", i: "💯", t: "Сотка", d: "Сыграйте 100 раундов", r: 500, p: P => [P.ach.c.rounds, 100] },
    { g: "Начало", id: "rounds1000", i: "🎰", t: "Тысячник", d: "Сыграйте 1 000 раундов", r: 2000, p: P => [P.ach.c.rounds, 1000] },
    { g: "Начало", id: "rounds10000", i: "🏛️", t: "Старожил", d: "Сыграйте 10 000 раундов", r: 10000, p: P => [P.ach.c.rounds, 10000] },
    { g: "Начало", id: "wins100", i: "✌️", t: "Везунчик", d: "Выиграйте 100 раз", r: 1000, p: P => [P.ach.c.wins, 100] },
    { g: "Выигрыши", id: "mult10", i: "🔟", t: "Десятка", d: "Выиграйте с множителем ×10", r: 300 },
    { g: "Выигрыши", id: "mult50", i: "🔥", t: "Полтинник", d: "Выиграйте с множителем ×50", r: 1000 },
    { g: "Выигрыши", id: "mult100", i: "💥", t: "Сотня иксов", d: "Выиграйте с множителем ×100", r: 2500 },
    { g: "Выигрыши", id: "mult1000", i: "🌌", t: "Тысячный икс", d: "Выиграйте с множителем ×1000", r: 10000 },
    { g: "Выигрыши", id: "win10k", i: "💰", t: "Куш", d: "Выиграйте 10 000 за один раунд", r: 1000 },
    { g: "Выигрыши", id: "win100k", i: "🏦", t: "Большой куш", d: "Выиграйте 100 000 за один раунд", r: 5000 },
    { g: "Выигрыши", id: "jackpot", i: "👑", t: "Джекпот!", d: "Сорвите джекпот слотов", r: 5000 },
    { g: "Игры", id: "slots_777", i: "7️⃣", t: "Три семёрки", d: "Выбейте 777 в Neon 777", r: 2000 },
    { g: "Игры", id: "reef_bonus", i: "🔱", t: "Нырок", d: "Запустите бонус в «Сокровищах рифа»", r: 1000 },
    { g: "Игры", id: "roul_number", i: "🎯", t: "Снайпер", d: "Выиграйте ставкой на число в рулетке", r: 1000 },
    { g: "Игры", id: "roul_zero", i: "🟢", t: "Зеро", d: "Выиграйте ставкой на зеро", r: 3000 },
    { g: "Игры", id: "bj_blackjack", i: "🃏", t: "Блэкджек!", d: "Соберите блэкджек с раздачи", r: 500 },
    { g: "Игры", id: "bj_double", i: "✖️", t: "Удвоение", d: "Выиграйте после удвоения ставки", r: 500 },
    { g: "Игры", id: "crash_10", i: "✈️", t: "Высокий полёт", d: "Заберите ×10 и выше в «Самолётике»", r: 1000 },
    { g: "Игры", id: "road_finish", i: "🐔", t: "Перебежчица", d: "Доведите курочку до конца дороги", r: 2000 },
    { g: "Игры", id: "mines_clear", i: "💎", t: "Сапёр", d: "Откройте все кристаллы на минном поле", r: 3000 },
    { g: "Игры", id: "plinko_edge", i: "☄️", t: "На краю", d: "Попадите в крайнюю ячейку «Звездопада»", r: 2000 },
    { g: "Игры", id: "tower_top", i: "🏔️", t: "Покоритель", d: "Поднимитесь на вершину «Ледяной башни»", r: 2000 },
    { g: "Игры", id: "scratch_100", i: "🎟️", t: "Золотая жила", d: "Выиграйте ×100 и больше на «Золотом билете»", r: 3000 },
    { g: "Игры", id: "wheel_super", i: "⭐", t: "Супер!", d: "Попадите в «Супер» с поставленной на него ставкой", r: 2000 },
    { g: "Рост", id: "lvl5", i: "🥉", t: "Лудик", d: "Достигните 5 уровня", r: 500, p: P => [P.prog.lvl, 5] },
    { g: "Рост", id: "lvl10", i: "🥈", t: "Лудоман", d: "Достигните 10 уровня", r: 1500, p: P => [P.prog.lvl, 10] },
    { g: "Рост", id: "lvl20", i: "🥇", t: "Игрок", d: "Достигните 20 уровня", r: 4000, p: P => [P.prog.lvl, 20] },
    { g: "Рост", id: "lvl30", i: "💎", t: "Амбассадор", d: "Достигните 30 уровня", r: 8000, p: P => [P.prog.lvl, 30] },
    { g: "Рост", id: "streak7", i: "📅", t: "Неделя подряд", d: "Заходите 7 дней подряд", r: 1000, p: P => [P.streak.n || 0, 7] },
    { g: "Рост", id: "streak30", i: "🗓️", t: "Месяц подряд", d: "Заходите 30 дней подряд", r: 5000, p: P => [P.streak.n || 0, 30] },
    { g: "Рост", id: "quests_all", i: "📜", t: "Отличник", d: "Выполните все задания за день", r: 500 },
    { g: "Рост", id: "quests30", i: "🛠️", t: "Трудяга", d: "Выполните 30 заданий", r: 2000, p: P => [P.ach.c.quests, 30] },
    { g: "Забота", id: "rg_limit", i: "🛡️", t: "Под контролем", d: "Установите себе личный лимит покупок", r: 300 },
    { g: "Забота", id: "rg_break", i: "☕", t: "Перерыв", d: "Сделайте перерыв по напоминанию", r: 300 },
    { g: "Забота", id: "idea", i: "💡", t: "Идейный", d: "Предложите идею для игры", r: 300 },
    { g: "Забота", id: "donate", i: "❤️", t: "Добрая душа", d: "Загляните на сайт благотворительного фонда", r: 5000 }
  ];
  const ACH_CLIENT = ["rg_break", "idea", "donate"]; // эти отмечает сам экран (нечем проверить на сервере)

  /* ---------- косметика ---------- */
  const COS = [
    { id: "plane_rocket", cat: "games", slot: "plane", g: "Самолётик", t: "Ракета", price: 40 },
    { id: "plane_gold", cat: "games", slot: "plane", g: "Самолётик", t: "Золотой самолёт", price: 50 },
    { id: "plane_dragon", cat: "games", slot: "plane", g: "Самолётик", t: "Дракон", price: 75 },
    { id: "chick_peng", cat: "games", slot: "chicken", g: "Через дорогу", t: "Пингвин", price: 30 },
    { id: "chick_cat", cat: "games", slot: "chicken", g: "Через дорогу", t: "Кот", price: 30 },
    { id: "chick_king", cat: "games", slot: "chicken", g: "Через дорогу", t: "Курица в короне", price: 60 },
    { id: "comet_fire", cat: "games", slot: "comet", g: "Звездопад", t: "Огненный шар", price: 35 },
    { id: "comet_diamond", cat: "games", slot: "comet", g: "Звездопад", t: "Алмаз", price: 50, free: { t: "Достижение «Сотня иксов»", ok: P => !!P.ach.got.mult100 } },
    { id: "comet_planet", cat: "games", slot: "comet", g: "Звездопад", t: "Планета", price: 60 },
    { id: "cards_royal", cat: "games", slot: "cards", g: "Блэкджек", t: "Королевская синяя рубашка", price: 30 },
    { id: "cards_noir", cat: "games", slot: "cards", g: "Блэкджек", t: "Чёрное золото", price: 45 },
    { id: "felt_blue", cat: "games", slot: "felt", g: "Рулетка", t: "Синее сукно", price: 30 },
    { id: "felt_bordo", cat: "games", slot: "felt", g: "Рулетка", t: "Бордовое сукно", price: 30 },
    { id: "slots_silver", cat: "games", slot: "slotframe", g: "Neon 777", t: "Серебряная рама", price: 25 },
    { id: "slots_rose", cat: "games", slot: "slotframe", g: "Neon 777", t: "Розовое золото", price: 40 },
    { id: "frame_gold", cat: "profile", slot: "frame", g: "Рамка аватара", t: "Двойное золото", price: null, free: { t: "Уровень 5", ok: P => P.prog.lvl >= 5 } },
    { id: "frame_neon", cat: "profile", slot: "frame", g: "Рамка аватара", t: "Неон", price: 60 },
    { id: "frame_anim", cat: "profile", slot: "frame", g: "Рамка аватара", t: "Сияющая (анимация)", price: 100 },
    { id: "name_gold", cat: "profile", slot: "name", g: "Цвет имени", t: "Золото", price: null, free: { t: "Уровень 10", ok: P => P.prog.lvl >= 10 } },
    { id: "name_teal", cat: "profile", slot: "name", g: "Цвет имени", t: "Бирюза", price: 30 },
    { id: "name_grad", cat: "profile", slot: "name", g: "Цвет имени", t: "Перелив BeMizaru", price: 60 },
    { id: "title_night", cat: "profile", slot: "title", g: "Звание", t: "Король ночи", price: 50 },
    { id: "title_high", cat: "profile", slot: "title", g: "Звание", t: "Хайроллер", price: 80 },
    { id: "title_patron", cat: "profile", slot: "title", g: "Звание", t: "Меценат", price: null, free: { t: "Достижение «Добрая душа»", ok: P => !!P.ach.got.donate } },
    { id: "frame_soul", cat: "profile", slot: "frame", g: "Рамка аватара", t: "Душа компании", price: null, free: { t: "Пригласите 3 друзей", ok: P => (P.refs || 0) >= 3 } },
    { id: "frame_tamada", cat: "profile", slot: "frame", g: "Рамка аватара", t: "Тамада (анимация)", price: null, free: { t: "Пригласите 10 друзей", ok: P => (P.refs || 0) >= 10 } },
    { id: "title_tamada", cat: "profile", slot: "title", g: "Звание", t: "Тамада", price: null, free: { t: "Пригласите 10 друзей", ok: P => (P.refs || 0) >= 10 } },
    { id: "chick_party", cat: "games", slot: "chicken", g: "Через дорогу", t: "Курица-тусовщица", price: null, free: { t: "Пригласите 5 друзей", ok: P => (P.refs || 0) >= 5 } },
    { id: "frame_owner", cat: "profile", slot: "frame", g: "Рамка аватара", t: "Владелец казино", price: null, free: { t: "Откройте новое заведение в «Моём казино»", ok: P => (P.idle?.pr || 0) >= 1 } },
    { id: "title_owner", cat: "profile", slot: "title", g: "Звание", t: "Владелец казино", price: null, free: { t: "Откройте новое заведение в «Моём казино»", ok: P => (P.idle?.pr || 0) >= 1 } },
    { id: "sound_retro", cat: "fx", slot: "sound", g: "Набор звуков", t: "Ретро-аркада", price: 40 },
    { id: "sound_live", cat: "fx", slot: "sound", g: "Набор звуков", t: "Живое казино", price: 40 },
    { id: "fx_fireworks", cat: "fx", slot: "fx", g: "Эффект выигрыша", t: "Фейерверк", price: 50 },
    { id: "fx_diamonds", cat: "fx", slot: "fx", g: "Эффект выигрыша", t: "Дождь из бриллиантов", price: 60 }
  ];
  const BUNDLES = [
    { id: "pack_pilot", t: "Набор пилота", d: "Все 3 скина «Самолётика»", items: ["plane_rocket", "plane_gold", "plane_dragon"], price: 120 },
    { id: "pack_comet", t: "Набор звездочёта", d: "Огненный шар и Планета", items: ["comet_fire", "comet_planet"], price: 75 },
    { id: "pack_table", t: "Набор крупье", d: "Обе рубашки и оба сукна", items: ["cards_royal", "cards_noir", "felt_blue", "felt_bordo"], price: 100 }
  ];
  const VIP_PRICE = 150, VIP_DAYS = 30;
  const cosItem = id => COS.find(x => x.id === id);
  const vipOn = P => (P.cos.vip || 0) > NOW;
  const owns = (P, id) => P.cos.owned.includes(id) || !!cosItem(id)?.free?.ok?.(P);
  const eqd = (P, slot) => { const id = P.cos.eq[slot]; return id && owns(P, id) ? id : ""; };
  const WEEK_TITLES = [
    { t: "Император бемок", i: "👑", tier: "gold" }, { t: "Граф Джекпотский", i: "🥈", tier: "silver" }, { t: "Барон Фортуны", i: "🥉", tier: "bronze" },
    { t: "Олигарх района", i: "💼", tier: "top" }, { t: "Акула стола", i: "🦈", tier: "top" }, { t: "Местный миллионер", i: "💰", tier: "top" },
    { t: "Любимчик крупье", i: "🎩", tier: "top" }, { t: "Почти миллионер", i: "📈", tier: "top" }, { t: "Подающий надежды", i: "🌱", tier: "top" },
    { t: "Счастливчик на подхвате", i: "🍀", tier: "top" }
  ];
  const weekTitle = P => { const w = P.cos.wt; return w && w.until > NOW && WEEK_TITLES[w.place - 1] ? { ...WEEK_TITLES[w.place - 1], place: w.place } : null; };
  const FRIEND_BONUS = 5000;

  /* ---------- «Моё казино» ---------- */
  const IDLE_B = [
    { k: "slot", t: "Игровой автомат", cost: 500, inc: 30 }, { k: "bar", t: "Барная стойка", cost: 5000, inc: 150 },
    { k: "poker", t: "Покерный стол", cost: 50000, inc: 700 }, { k: "roul", t: "Рулеточный зал", cost: 500000, inc: 3500 },
    { k: "vip", t: "VIP-ложа", cost: 5000000, inc: 18000 }, { k: "hotel", t: "Отель-казино", cost: 50000000, inc: 90000 }
  ];
  const IDLE_MS = [25, 50, 100], IDLE_SOFT = 1000;
  const SAFE = [{ h: 2, cost: 0 }, { h: 4, cost: 5000 }, { h: 8, cost: 60000 }, { h: 12, cost: 600000 }];
  const GLOVE_COST = l => Math.round(300 * Math.pow(2.2, l));
  const PRESTIGE_AT = 10e6, TAPS_PER_SEC = 8, HR_WINDOW = 12000;
  const idleS = P => P.idle || (P.idle = { last: NOW, bank: 0, b: {}, glove: 0, safe: 0, rep: 0, total: 0, pr: 0, tapT: 0, hrAt: 0 });
  const bLevel = (P, k) => idleS(P).b[k] || 0;
  const bCost = (P, b, l = bLevel(P, b.k)) => Math.round(b.cost * Math.pow(1.2, l));
  const bMult = l => Math.pow(2, IDLE_MS.filter(m => l >= m).length);
  const bRate = (P, b, l = bLevel(P, b.k)) => b.inc * l * bMult(l);
  const idleRaw = P => IDLE_B.reduce((a, b) => a + bRate(P, b), 0);
  const softCap = R => R <= IDLE_SOFT ? R : IDLE_SOFT * (1 + Math.log(R / IDLE_SOFT));
  const idleBoost = P => (1 + .1 * idleS(P).rep) * (vipOn(P) ? 1.25 : 1);
  const idleRate = P => softCap(idleRaw(P)) * idleBoost(P);
  function idleGain(P, b) { const l = bLevel(P, b.k), raw = idleRaw(P); return (softCap(raw - bRate(P, b, l) + bRate(P, b, l + 1)) - softCap(raw)) * idleBoost(P); }
  const safeCap = P => idleRate(P) * SAFE[idleS(P).safe].h;
  const tapValue = P => Math.max(1, Math.round((1 + idleS(P).glove * 2) + idleRate(P) / 600));
  function idleAccrue(P) { const I = idleS(P), dt = Math.max(0, Math.min(NOW - I.last, 30 * 864e5)); I.bank = Math.min(safeCap(P), I.bank + idleRate(P) * dt / 3600e3); I.last = NOW; }
  const hrNext = () => NOW + (150 + rand(240)) * 1000;

  /* ---------- игры: таблицы ---------- */
  const SYMS = [{ s: "🍒", w: 30, p: 10 }, { s: "🍋", w: 25, p: 8 }, { s: "🔔", w: 20, p: 12 }, { s: "⭐", w: 12, p: 30 }, { s: "💎", w: 8, p: 60 }, { s: "7", w: 5, p: 200 }];
  const W_TOTAL = SYMS.reduce((a, b) => a + b.w, 0);
  const pickSymI = () => { let r = rand(W_TOTAL); for (let i = 0; i < SYMS.length; i++) { if ((r -= SYMS[i].w) < 0) return i; } return 0; };
  const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const colorOf = n => n === 0 ? "green" : REDS.has(n) ? "red" : "black";
  const OUT = [
    { k: "1-12", t: "1–12", pay: 2, f: n => n >= 1 && n <= 12 }, { k: "13-24", t: "13–24", pay: 2, f: n => n >= 13 && n <= 24 }, { k: "25-36", t: "25–36", pay: 2, f: n => n >= 25 },
    { k: "low", t: "1–18", pay: 1, f: n => n >= 1 && n <= 18 }, { k: "even", t: "Чёт", pay: 1, f: n => n && n % 2 === 0 }, { k: "red", t: "Красное", pay: 1, f: n => colorOf(n) === "red", cls: "red" },
    { k: "black", t: "Чёрное", pay: 1, f: n => colorOf(n) === "black", cls: "black" }, { k: "odd", t: "Нечет", pay: 1, f: n => n % 2 === 1 }, { k: "high", t: "19–36", pay: 1, f: n => n >= 19 }
  ];
  const SUITS = ["♠", "♥", "♦", "♣"], RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const card = () => ({ r: RANKS[rand(13)], s: SUITS[rand(4)] });
  function score(h) { let t = 0, a = 0; for (const c of h) { if (c.r === "A") { a++; t += 11; } else t += ["J", "Q", "K"].includes(c.r) ? 10 : +c.r; } while (t > 21 && a) { t -= 10; a--; } return t; }
  const CRASH_RTP = 0.90, CRASH_SPEED = 0.09, CRASH_GRACE = 400, AUTOS = [0, 1.5, 2, 3, 5, 10];
  const crashPoint = () => { const r = rand(1e6) / 1e6; return Math.max(1, Math.floor(CRASH_RTP / (1 - r) * 100) / 100); };
  const crashT = g => g.t0 + Math.log(g.point) / CRASH_SPEED * 1000;
  const ROAD = { easy: { t: "Лёгкий", p: 0.92, n: 20 }, mid: { t: "Средний", p: 0.84, n: 16 }, hard: { t: "Сложный", p: 0.72, n: 12 }, hell: { t: "Безумный", p: 0.55, n: 9 } };
  const ROAD_RTP = 0.90;
  const roadMult = (lv, k) => Math.floor(ROAD_RTP * Math.pow(1 / ROAD[lv].p, k) * 100) / 100;
  const MINES_RTP = 0.90, MINE_OPTS = [3, 5, 10, 20];
  function minesMult(count, k) { let m = MINES_RTP; for (let i = 0; i < k; i++) m *= (25 - i) / (25 - count - i); return Math.floor(m * 100) / 100; }
  const P_ROWS = 12;
  const P_RISK = {
    low: { t: "Низкий", m: [10, 3, 1.6, 1.4, 1.05, 0.8, 0.5, 0.8, 1.05, 1.4, 1.6, 3, 10] },
    mid: { t: "Средний", m: [33, 10, 4, 1.8, 1, 0.5, 0.3, 0.5, 1, 1.8, 4, 10, 33] },
    high: { t: "Высокий", m: [150, 22, 7.4, 1.8, 0.6, 0.2, 0.2, 0.2, 0.6, 1.8, 7.4, 22, 150] }
  };
  const RF_COLS = 6, RF_ROWS = 5;
  const RF_SYMS = [
    { s: "🐙", w: 6, pay: [10, 25, 50] }, { s: "🦑", w: 8, pay: [2.5, 10, 25] }, { s: "🐡", w: 10, pay: [2, 5, 15] }, { s: "🦀", w: 12, pay: [1.5, 2, 12] },
    { s: "🐠", w: 15, pay: [1, 1.5, 10] }, { s: "🐢", w: 16, pay: [0.8, 1.2, 8] }, { s: "🦐", w: 18, pay: [0.5, 1, 5] }, { s: "🐚", w: 20, pay: [0.4, 0.9, 4] }
  ];
  const RF_SCAT = "🔱", RF_SCAT_PAY = { 4: 3, 5: 5, 6: 100 };
  const RF_PAY_SCALE = 1.065, RF_SCAT_CH = 15, RF_MULT_CH = 18;
  const RF_MULTS = [[2, 30], [3, 22], [4, 15], [5, 12], [6, 8], [8, 5], [10, 4], [12, 2], [15, 1.5], [20, 1], [25, 0.6], [50, 0.25], [100, 0.1]];
  const RF_W = RF_SYMS.reduce((a, b) => a + b.w, 0), RF_MW = RF_MULTS.reduce((a, b) => a + b[1], 0);
  let rfId = 0;
  function rfNew(free) {
    const id = ++rfId;
    if (free && rand(1000) < RF_MULT_CH) { let r = rand(Math.round(RF_MW * 100)) / 100; for (const [m, w] of RF_MULTS) { if ((r -= w) < 0) return { id, s: "x", m }; } return { id, s: "x", m: 2 }; }
    if (rand(1000) < RF_SCAT_CH) return { id, s: RF_SCAT };
    let r = rand(RF_W); for (const x of RF_SYMS) { if ((r -= x.w) < 0) return { id, s: x.s }; }
    return { id, s: RF_SYMS[0].s };
  }
  const rfIdx = (c, r) => c * RF_ROWS + r;
  function rfWins(grid) {
    const by = {};
    grid.forEach((x, i) => { if (x.s !== RF_SCAT && x.s !== "x") (by[x.s] = by[x.s] || []).push(i); });
    const wins = [];
    for (const sym of RF_SYMS) {
      const cells = by[sym.s]; if (!cells || cells.length < 8) continue;
      const tier = cells.length >= 12 ? 2 : cells.length >= 10 ? 1 : 0;
      wins.push({ s: sym.s, cells, n: cells.length, pay: Math.round(sym.pay[tier] * RF_PAY_SCALE * 100) / 100 });
    }
    return wins;
  }
  function rfPlay(free) {
    rfId = 0;
    let grid = Array.from({ length: RF_COLS * RF_ROWS }, () => rfNew(free));
    const steps = [{ grid: grid.slice(), wins: [], fresh: grid.map(x => x.id) }];
    let win = 0;
    for (;;) {
      const wins = rfWins(grid);
      if (!wins.length) break;
      steps[steps.length - 1].wins = wins;
      win += wins.reduce((a, w) => a + w.pay, 0);
      const gone = new Set(wins.flatMap(w => w.cells));
      const next = [], fresh = [];
      for (let c = 0; c < RF_COLS; c++) {
        const keep = [];
        for (let r = 0; r < RF_ROWS; r++) if (!gone.has(rfIdx(c, r))) keep.push(grid[rfIdx(c, r)]);
        const add = Array.from({ length: RF_ROWS - keep.length }, () => rfNew(free));
        add.forEach(x => fresh.push(x.id));
        next.push(...add, ...keep);
      }
      grid = next;
      steps.push({ grid: grid.slice(), wins: [], fresh });
    }
    const scat = grid.filter(x => x.s === RF_SCAT).length;
    const mults = grid.filter(x => x.s === "x").reduce((a, x) => a + x.m, 0);
    return { steps, win, scat, mults };
  }
  const SC_PRIZES = [[1, 1400], [2, 800], [5, 300], [10, 120], [20, 60], [50, 20], [100, 6], [500, 1]];
  function scDeal() {
    let r = rand(10000), win = 0;
    for (const [m, w] of SC_PRIZES) { if ((r -= w) < 0) { win = m; break; } }
    const vals = SC_PRIZES.map(p => p[0]), cells = [], count = {};
    if (win) { cells.push(win, win, win); count[win] = 3; }
    while (cells.length < 9) { const v = vals[rand(vals.length)]; if ((count[v] || 0) >= 2 || v === win) continue; count[v] = (count[v] || 0) + 1; cells.push(v); }
    for (let i = 8; i > 0; i--) { const j = rand(i + 1); [cells[i], cells[j]] = [cells[j], cells[i]]; }
    return { cells, win };
  }
  const JP_SEED = 10000, JP_RATE = 0.01, JP_ODDS = 15e6;
  const WH_TYPES = [
    { k: "x2", n: 27, lbl: "2", name: "×2", col: "#e9dcc0", fg: "#2b1a0c", pay: 2 }, { k: "x3", n: 18, lbl: "3", name: "×3", col: "#1d6b4e", fg: "#f5dfa8", pay: 3 },
    { k: "x6", n: 9, lbl: "6", name: "×6", col: "#7a1a2a", fg: "#f5dfa8", pay: 6 }, { k: "coin", n: 3, lbl: "🪙", name: "Монетка", col: "#c9962e", fg: "#2b1a0c" },
    { k: "chest", n: 2, lbl: "🎁", name: "Сундуки", col: "#1f4f63", fg: "#f5dfa8" }, { k: "super", n: 1, lbl: "★", name: "Супер", col: "#120d16", fg: "#e3c27a" }
  ];
  const WH_T = Object.fromEntries(WH_TYPES.map(t => [t.k, t]));
  const WH_SEGS = (() => { const N = 60, placed = {}, out = []; WH_TYPES.forEach(t => placed[t.k] = 0);
    for (let i = 0; i < N; i++) { let best = null, bd = -1e9; for (const t of WH_TYPES) { if (placed[t.k] >= t.n) continue; const d = t.n * (i + 1) / N - placed[t.k] - (out[i - 1] === t.k ? 0.7 : 0); if (d > bd) { bd = d; best = t; } } out.push(best.k); placed[best.k]++; }
    return out; })();
  const WH_COIN = [[5, 20], [8, 20], [10, 18], [15, 14], [20, 10], [25, 8], [50, 5], [100, 5]];
  const WH_CHEST = [[5, 20], [10, 22], [15, 18], [20, 14], [30, 10], [50, 9], [100, 5], [200, 3]];
  const WH_SUPER = [10, 10, 15, 15, 20, 20, 25, 25, 30, 30, 40, 40, 50, 50, 75, 75, 100, 100, 150, 200];
  const whPick = tbl => { const tot = tbl.reduce((a, b) => a + b[1], 0); let r = rand(tot); for (const [v, w] of tbl) { if ((r -= w) < 0) return v; } return tbl[0][0]; };
  const TW_ROWS = 8, TW_RTP = 0.90;
  const TW = { easy: { t: "Лёгкий", cols: 4, safe: 3 }, mid: { t: "Средний", cols: 3, safe: 2 }, hard: { t: "Сложный", cols: 2, safe: 1 }, hell: { t: "Безумный", cols: 3, safe: 1 } };
  const twMult = (lv, k) => Math.floor(TW_RTP * Math.pow(TW[lv].cols / TW[lv].safe, k) * 100) / 100;
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  /* ================= Игрок ================= */
  function newPlayer(now = Date.now()) {
    NOW = now;
    return {
      v: 1, created: now, rev: 0, name: "Игрок", code: "", adult: false,
      chips: START_CHIPS, stats: { maxChips: START_CHIPS, bigWin: 0 },
      prog: { xp: 0, lvl: 1 }, streak: { last: "", n: 0 },
      q: { day: "", list: [], c: {}, done: [], bonus: false }, wheelDay: "",
      rg: { day: 200, month: 1000, pend: null, remind: 60, pause: 0 },
      spent: { day: "", dayStars: 0, month: "", monthStars: 0 },
      ach: { got: {}, c: { rounds: 0, wins: 0, games: [], quests: 0 } },
      cos: { owned: [], eq: {}, vip: 0, wt: null },
      idle: null,
      lb: { week: "", wNet: 0, wWon: 0, wLost: 0, wRounds: 0, aNet: 0, aWon: 0, aLost: 0, best: 0 },
      hist: [], crashHist: [], whLast: [], scNo: 0,
      refs: 0, refBy: "", refDone: false, gifts: [], notes: [],
      g: null
    };
  }
  // дополняет старые записи новыми полями
  function fix(P) {
    const d = newPlayer(NOW);
    for (const k in d) if (P[k] === undefined) P[k] = d[k];
    for (const k of ["stats", "prog", "streak", "rg", "spent", "lb", "cos"]) P[k] = { ...d[k], ...P[k] };
    P.ach = { got: P.ach.got || {}, c: { ...d.ach.c, ...(P.ach.c || {}) } };
    return P;
  }

  /* ---------- сервисные ---------- */
  function addXP(P, n, ev) {
    P.prog.xp += n;
    while (P.prog.xp >= xpNeed(P.prog.lvl)) {
      P.prog.xp -= xpNeed(P.prog.lvl); P.prog.lvl++;
      const r = levelReward(P.prog.lvl); P.chips += r;
      ev.push({ t: "lvl", lvl: P.prog.lvl, r });
    }
    achCheck(P, ev);
  }
  function achGive(P, id, ev) {
    if (P.ach.got[id]) return;
    const a = ACH.find(x => x.id === id); if (!a) return;
    P.ach.got[id] = today(); P.chips += a.r;
    ev.push({ t: "ach", id, r: a.r, name: a.t });
  }
  function achCheck(P, ev) { for (const a of ACH) if (a.p && !P.ach.got[a.id]) { const [v, goal] = a.p(P); if (v >= goal) achGive(P, a.id, ev); } }
  function questsEnsure(P) {
    if (P.q.day === today()) return;
    const games = Object.keys(GAME_NAMES);
    P.q = { day: today(), list: [Q_A[rand(Q_A.length)].id, Q_B[rand(Q_B.length)].id, "g:" + games[rand(games.length)]], c: {}, done: [], bonus: false };
  }
  function lbRoll(P) { const w = isoWeek(); if (P.lb.week !== w) Object.assign(P.lb, { week: w, wNet: 0, wWon: 0, wLost: 0, wRounds: 0 }); }
  function lbTrack(P, p) {
    lbRoll(P); const L = P.lb;
    L.wNet += p; L.aNet += p; L.wRounds++;
    if (p > 0) { L.wWon += p; L.aWon += p; if (p > L.best) L.best = p; } else { L.wLost -= p; L.aLost -= p; }
  }
  function rgLimits(P) {
    const r = P.rg;
    if (r.pend && NOW >= r.pend.at) { r.day = r.pend.day; r.month = r.pend.month; r.pend = null; }
    return { day: Math.min(r.day, DAY_LIMIT_STARS), month: Math.min(r.month, MONTH_LIMIT_STARS) };
  }
  function spentRoll(P) { const sp = P.spent; if (sp.day !== today()) { sp.day = today(); sp.dayStars = 0; } if (sp.month !== month()) { sp.month = month(); sp.monthStars = 0; } return sp; }
  function canSpend(P, stars) { const sp = spentRoll(P), L = rgLimits(P); return !(L.day === 0 || L.month === 0 || sp.dayStars + stars > L.day || sp.monthStars + stars > L.month); }
  function spend(P, stars) { const sp = spentRoll(P); sp.dayStars += stars; sp.monthStars += stars; }
  const streakNext = P => P.streak.last === today() ? P.streak.n : P.streak.last === yesterday() ? P.streak.n + 1 : 1;
  const dailyAmount = P => STREAK[Math.min(STREAK.length, streakNext(P)) - 1] * (vipOn(P) ? 2 : 1);
  const paused = P => (P.rg.pause || 0) > NOW;

  /* ---------- раунд ---------- */
  function betOk(bet, max = MAX_BET) { bet = Math.round(+bet); if (!(bet >= MIN_BET && bet <= max)) fail(`Ставка от ${MIN_BET} до ${max.toLocaleString("ru-RU")}`); return bet; }
  function roundStart(P, g, bet, ev) {
    if (!P.adult) fail("Подтвердите возраст", 403);
    if (paused(P)) fail("Вы взяли паузу от игры", 403);
    if (P.chips < bet) fail("Недостаточно бемок", 402);
    P.chips -= bet;
    const c = P.ach.c; c.rounds++; if (!c.games.includes(g)) c.games.push(g);
    achGive(P, "first_round", ev);
    questsEnsure(P);
    const q = P.q.c; q.rounds = (q.rounds || 0) + 1; q.games = q.games || []; if (!q.games.includes(g)) q.games.push(g); q["g:" + g] = (q["g:" + g] || 0) + 1;
    addXP(P, xpFor(bet), ev);
    if (P.refBy && !P.refDone) { P.refDone = true; P.chips += FRIEND_BONUS; ev.push({ t: "ref", r: FRIEND_BONUS }); CTX.refCredit = P.refBy; }
    return { g, bet, t: NOW };
  }
  function onWin(P, profit, bet, ev) {
    const a = P.ach.c; a.wins++; achGive(P, "first_win", ev);
    const mm = bet ? (profit + bet) / bet : 0;
    [[10, "mult10"], [50, "mult50"], [100, "mult100"], [1000, "mult1000"]].forEach(([k, id]) => mm >= k && achGive(P, id, ev));
    if (profit >= 10000) achGive(P, "win10k", ev); if (profit >= 100000) achGive(P, "win100k", ev);
    questsEnsure(P); const c = P.q.c;
    c.wins = (c.wins || 0) + 1; c.profit = (c.profit || 0) + profit; c.mult = Math.max(c.mult || 0, mm);
    addXP(P, Math.round(xpFor(bet) / 2), ev);
  }
  function noteWin(P, profit, bet, ev) { if (profit > P.stats.bigWin) P.stats.bigWin = profit; if (profit > 0) onWin(P, profit, bet, ev); }
  // конец раунда: выплата, история, рейтинг, победа
  function roundEnd(P, h, pay, ev, mult) {
    pay = Math.floor(pay); P.chips += pay;
    const m = Math.round((mult || (h.bet ? pay / h.bet : 0)) * 100) / 100;
    P.hist.unshift({ g: h.g, bet: h.bet, pay, m, t: h.t }); if (P.hist.length > 50) P.hist.length = 50;
    lbTrack(P, pay - h.bet);
    noteWin(P, pay - h.bet, h.bet, ev);
    return pay;
  }
  function jackpot(P, bet, ev) {
    const J = CTX.jp; J.add += bet * JP_RATE;
    if (!J.hit && rand(1e9) / 1e9 < bet / JP_ODDS) {
      J.hit = true; const amount = Math.floor(J.v + J.add); J.won = amount;
      P.chips += amount; achGive(P, "jackpot", ev); noteWin(P, amount, bet, ev);
      ev.push({ t: "jp", n: amount });
    }
  }
  function needFree(P, g) { if (P.g && P.g.k !== g) fail(`Сначала завершите игру «${GAME_NAMES[P.g.k]}»`, 409); if (P.g) fail("Эта игра уже идёт", 409); }
  function needG(P, g) { if (!P.g || P.g.k !== g) fail("Игра уже завершена — обновите экран", 409); return P.g; }

  /* ---------- самолётик: расчёт ---------- */
  function crashFinish(P, g, claim, ev) {
    const auto = g.auto && g.auto < g.point ? g.auto : 0;
    let m = 0;
    if (claim && claim < g.point) m = claim;
    if (auto && (!m || auto < m)) m = auto;
    const pay = m ? Math.floor(g.bet * m) : 0;
    if (m >= 10) achGive(P, "crash_10", ev);
    roundEnd(P, g.h, pay, ev, m || g.point);
    P.crashHist.unshift(g.point); P.crashHist = P.crashHist.slice(0, 12);
    P.g = null;
    return (P.crashLast = { point: g.point, m, pay, done: 1, t0: g.t0 });
  }
  function crashSettle(P, ev) { const g = P.g; if (g && g.k === "crash" && NOW >= crashT(g) + CRASH_GRACE) return crashFinish(P, g, 0, ev); return null; }
  const crashWait = P => P.g && P.g.k === "crash" ? Math.max(0, crashT(P.g) + CRASH_GRACE - NOW) : 0;

  /* ================= Действия ================= */
  const A = {};
  A.state = (P, x, ev) => ({ ok: 1 });
  A.adult = (P, x, ev) => { P.adult = true; return { ok: 1 }; };

  /* бонусы */
  A["daily.claim"] = (P, x, ev) => {
    if (P.streak.last === today()) fail("Бонус дня уже получен");
    if (paused(P)) fail("Вы взяли паузу от игры", 403);
    const a = dailyAmount(P); P.streak = { last: today(), n: streakNext(P) }; P.chips += a; achCheck(P, ev);
    return { amount: a, n: P.streak.n };
  };
  A["fwheel.spin"] = (P, x, ev) => {
    if (P.wheelDay === today()) fail("Колесо дня уже крутили");
    if (paused(P)) fail("Вы взяли паузу от игры", 403);
    const tot = FW.reduce((a, b) => a + b[1] * 10, 0); let r = rand(tot), prize = FW[0][0];
    for (const [v, w] of FW) { if ((r -= w * 10) < 0) { prize = v; break; } }
    P.wheelDay = today(); P.chips += prize; return { prize };
  };
  A["quest.claim"] = (P, x, ev) => {
    questsEnsure(P); const id = String(x.id || "");
    if (id === "__all") { if (!qAllDone(P) || P.q.bonus) fail("Сундук пока закрыт"); P.q.bonus = true; P.chips += Q_ALL_BONUS; return { r: Q_ALL_BONUS }; }
    if (!P.q.list.includes(id) || P.q.done.includes(id)) fail("Задание недоступно");
    const d = qDef(id); if (qProgress(P, id) < d.goal) fail("Задание ещё не выполнено");
    P.q.done.push(id); P.chips += d.r; P.ach.c.quests++; addXP(P, 50, ev); if (qAllDone(P)) achGive(P, "quests_all", ev);
    return { r: d.r };
  };
  A["ach.claim"] = (P, x, ev) => { if (!ACH_CLIENT.includes(x.id)) fail("Нельзя"); achGive(P, x.id, ev); return { ok: 1 }; };

  /* ответственная игра */
  A["rg.limit"] = (P, x, ev) => {
    const kind = x.kind, v = +x.v, opts = kind === "day" ? RG_DAY : kind === "month" ? RG_MONTH : null;
    if (!opts || !opts.includes(v)) fail("Неверный лимит");
    const r = P.rg, cur = rgLimits(P)[kind];
    if (v <= cur) { r[kind] = v; if (r.pend) r.pend[kind] = Math.min(r.pend[kind], v); }
    else r.pend = { day: r.day, month: r.month, ...(r.pend || {}), [kind]: v, at: NOW + H24 };
    if (v < 200 || (kind === "month" && v < 1000)) achGive(P, "rg_limit", ev);
    return { ok: 1 };
  };
  A["rg.remind"] = (P, x) => { const v = +x.v; if (!RG_REMIND.includes(v)) fail("Неверное значение"); P.rg.remind = v; return { ok: 1 }; };
  A["rg.pause"] = (P, x) => { const d = +x.days; if (![1, 7, 30].includes(d)) fail("Неверный срок"); P.rg.pause = Math.max(P.rg.pause || 0, NOW + d * H24); return { until: P.rg.pause }; };

  A["notes.seen"] = P => { P.notes = []; return { ok: 1 }; };
  // начать заново: покупки, лимиты и пауза сохраняются; не чаще раза в 30 дней
  A.reset = P => {
    if (P.g) fail("Сначала завершите текущую игру", 409);
    if (P.resetAt && NOW - P.resetAt < 30 * H24) fail("Начать заново можно раз в 30 дней", 429);
    const keep = { created: P.created, rev: P.rev, name: P.name, code: P.code, adult: P.adult, rg: P.rg, spent: P.spent, refs: P.refs, refBy: P.refBy, refDone: P.refDone, gifts: P.gifts,
      cos: { owned: P.cos.owned, eq: P.cos.eq, vip: P.cos.vip, wt: P.cos.wt }, resetAt: NOW };
    for (const k of Object.keys(P)) delete P[k];
    Object.assign(P, newPlayer(NOW), keep);
    return { ok: 1 };
  };

  /* косметика: надеть / снять */
  A["cos.eq"] = (P, x) => {
    const it = cosItem(x.id); if (!it) fail("Нет такого предмета"); if (!owns(P, it.id)) fail("Предмет не куплен");
    P.cos.eq[it.slot] = P.cos.eq[it.slot] === it.id ? "" : it.id; return { on: P.cos.eq[it.slot] === it.id };
  };

  /* «Моё казино» */
  A["idle.collect"] = (P, x, ev) => { idleAccrue(P); const I = idleS(P), v = Math.floor(I.bank); if (v > 0) { I.bank -= v; I.total += v; P.chips += v; } return { v: Math.max(0, v) }; };
  A["idle.buy"] = (P, x) => {
    const b = IDLE_B.find(y => y.k === x.k); if (!b) fail("Нет такого здания");
    const c = bCost(P, b); if (P.chips < c) fail("Не хватает бемок", 402);
    idleAccrue(P); P.chips -= c; idleS(P).b[b.k] = bLevel(P, b.k) + 1;
    const l = bLevel(P, b.k); return { l, milestone: IDLE_MS.includes(l) };
  };
  A["idle.glove"] = P => { const I = idleS(P), c = GLOVE_COST(I.glove); if (P.chips < c) fail("Не хватает бемок", 402); idleAccrue(P); P.chips -= c; I.glove++; return { ok: 1 }; };
  A["idle.safe"] = P => { const I = idleS(P), n = SAFE[I.safe + 1]; if (!n) fail("Сейф уже максимальный"); if (P.chips < n.cost) fail("Не хватает бемок", 402); idleAccrue(P); P.chips -= n.cost; I.safe++; return { ok: 1 }; };
  A["idle.prestige"] = (P, x, ev) => {
    const I = idleS(P), gain = Math.max(0, Math.floor(Math.sqrt(I.total / 1e6)) - I.rep);
    if (I.total < PRESTIGE_AT || gain <= 0) fail("Пока рано");
    A["idle.collect"](P, x, ev);
    Object.assign(I, { b: {}, glove: 0, safe: 0, bank: 0, rep: I.rep + gain, pr: (I.pr || 0) + 1, last: NOW });
    return { rep: I.rep, gain };
  };
  A["idle.tap"] = (P, x) => {
    const I = idleS(P); let n = Math.max(0, Math.floor(+x.n || 0));
    const allow = Math.min(240, Math.ceil(Math.max(0, NOW - (I.tapT || 0)) / 1000 * TAPS_PER_SEC) + TAPS_PER_SEC);
    n = Math.min(n, allow); I.tapT = NOW;
    const v = n * tapValue(P); I.total += v; P.chips += v; return { n, v };
  };
  A["idle.hr"] = (P, x, ev) => {
    const I = idleS(P);
    if (!I.hrAt || NOW < I.hrAt - 2000 || NOW > I.hrAt + HR_WINDOW || !idleRate(P)) { if (!I.hrAt || NOW > I.hrAt + HR_WINDOW) I.hrAt = hrNext(); fail("Хайроллер уже ушёл"); }
    const v = Math.max(50, Math.round(idleRate(P) / 6)); I.total += v; P.chips += v; I.hrAt = hrNext();
    return { v };
  };

  /* ---------- игры ---------- */
  A["slots.spin"] = (P, x, ev) => {
    const bet = betOk(x.bet), h = roundStart(P, "slots", bet, ev);
    const reels = [pickSymI(), pickSymI(), pickSymI()], s = reels.map(i => SYMS[i].s);
    let win = 0;
    if (s[0] === s[1] && s[1] === s[2]) { win = bet * SYMS[reels[0]].p; if (s[0] === "7") achGive(P, "slots_777", ev); }
    else if (s.filter(y => y === "🍒").length === 2) win = bet * 2;
    const pay = roundEnd(P, h, win, ev);
    jackpot(P, bet, ev);
    return { reels, pay, bet };
  };
  A["roul.spin"] = (P, x, ev) => {
    const bets = x.bets || {}, keys = Object.keys(bets);
    if (!keys.length || keys.length > 60) fail("Сделайте ставку");
    let total = 0;
    for (const k of keys) {
      const v = Math.round(+bets[k]);
      if (!(v >= MIN_BET && v <= MAX_TABLE)) fail("Неверная ставка");
      if (k[0] === "n") { const n = +k.slice(1); if (!(Number.isInteger(n) && n >= 0 && n <= 36) || k !== "n" + n) fail("Неверная ставка"); }
      else if (!OUT.find(o => o.k === k)) fail("Неверная ставка");
      bets[k] = v; total += v;
    }
    if (total > MAX_TABLE) fail(`Сумма ставок не больше ${MAX_TABLE.toLocaleString("ru-RU")}`);
    const h = roundStart(P, "roul", total, ev);
    const n = WHEEL[rand(37)];
    let win = 0;
    for (const [k, amt] of Object.entries(bets)) {
      if (k[0] === "n") { if (+k.slice(1) === n) { win += amt * 36; achGive(P, n === 0 ? "roul_zero" : "roul_number", ev); } }
      else { const o = OUT.find(y => y.k === k); if (o.f(n)) win += amt * (o.pay + 1); }
    }
    const pay = roundEnd(P, h, win, ev);
    return { n, pay, bet: total };
  };

  /* блэкджек */
  function bjView(g) { return { player: g.player, dealer: g.done ? g.dealer : [g.dealer[0]], bet: g.bet, dbl: !!g.dbl, done: !!g.done, msg: g.msg, pay: g.pay || 0 }; }
  function bjFinish(P, g, msg, payout, ev) {
    g.h.bet = g.bet; g.done = true; g.pay = payout || 0;
    g.msg = msg + (payout > g.bet ? ` +${(payout - g.bet).toLocaleString("ru-RU")}` : "");
    if (g.dbl && payout > g.bet) achGive(P, "bj_double", ev);
    roundEnd(P, g.h, payout || 0, ev);
    P.g = null;
    return bjView(g);
  }
  function bjDealer(P, g, ev) {
    while (score(g.dealer) < 17) g.dealer.push(card());
    const p = score(g.player), d = score(g.dealer);
    if (d > 21) return bjFinish(P, g, "Дилер перебрал! Добыча ваша", g.bet * 2, ev);
    if (p > d) return bjFinish(P, g, "Вы победили!", g.bet * 2, ev);
    if (p === d) return bjFinish(P, g, "Ничья — ставка возвращена", g.bet, ev);
    return bjFinish(P, g, "Дилер сильнее", 0, ev);
  }
  A["bj.deal"] = (P, x, ev) => {
    needFree(P, "bj"); const bet = betOk(x.bet), h = roundStart(P, "bj", bet, ev);
    const g = P.g = { k: "bj", bet, h, player: [card(), card()], dealer: [card(), card()], msg: "Ещё или хватит?" };
    const p = score(g.player), d = score(g.dealer);
    if (p === 21 || d === 21) {
      if (p === 21 && d === 21) return bjFinish(P, g, "Оба с блэкджеком — ничья", g.bet, ev);
      if (p === 21) { achGive(P, "bj_blackjack", ev); return bjFinish(P, g, "Блэкджек! Йо-хо-хо!", Math.round(g.bet * 2.5), ev); }
      return bjFinish(P, g, "У дилера блэкджек", 0, ev);
    }
    return bjView(g);
  };
  A["bj.hit"] = (P, x, ev) => { const g = needG(P, "bj"); g.player.push(card()); if (score(g.player) > 21) return bjFinish(P, g, "Перебор! Сундук уходит дилеру", 0, ev); return bjView(g); };
  A["bj.stand"] = (P, x, ev) => bjDealer(P, needG(P, "bj"), ev);
  A["bj.double"] = (P, x, ev) => {
    const g = needG(P, "bj"); if (g.player.length !== 2) fail("Удвоить можно только сразу после раздачи");
    if (P.chips < g.bet) fail("Недостаточно бемок", 402);
    P.chips -= g.bet; g.bet *= 2; g.dbl = true; g.player.push(card());
    if (score(g.player) > 21) return bjFinish(P, g, "Перебор после удвоения!", 0, ev);
    return bjDealer(P, g, ev);
  };

  /* самолётик */
  A["crash.start"] = (P, x, ev) => {
    needFree(P, "crash"); const bet = betOk(x.bet), auto = AUTOS.includes(+x.auto) ? +x.auto : 0;
    const h = roundStart(P, "crash", bet, ev);
    P.g = { k: "crash", bet, h, auto, point: crashPoint(), t0: NOW };
    return { bet, auto, el: 0 };
  };
  A["crash.cash"] = (P, x, ev) => {
    const g = P.g;
    if (!g || g.k !== "crash") return { ...(P.crashLast || { done: 1, pay: 0 }), late: 1 };
    const claim = Math.floor(+x.m * 100) / 100;
    const mNow = Math.exp(CRASH_SPEED * (NOW - g.t0) / 1000);
    if (!(claim >= 1) || claim > mNow * 1.02 + 0.01) fail("Неверный множитель");
    if (NOW > crashT(g) + CRASH_GRACE) return crashFinish(P, g, 0, ev);
    return crashFinish(P, g, claim, ev);
  };
  A["crash.watch"] = (P, x, ev) => {
    const g = P.g;
    if (!g || g.k !== "crash") return { ...(P.crashLast || { done: 1, pay: 0 }) };
    if (NOW < crashT(g) + CRASH_GRACE) return { flying: 1, el: NOW - g.t0 };
    return crashFinish(P, g, 0, ev);
  };

  /* через дорогу */
  A["road.start"] = (P, x, ev) => {
    needFree(P, "road"); const lv = ROAD[x.lv] ? x.lv : fail("Неверная сложность"); const bet = betOk(x.bet);
    const h = roundStart(P, "road", bet, ev); P.g = { k: "road", bet, h, lv, step: 0 }; return { lv, step: 0, bet };
  };
  function roadCash(P, g, ev) { const m = roadMult(g.lv, g.step), pay = roundEnd(P, g.h, g.bet * m, ev, m); P.g = null; return { step: g.step, m, pay, done: 1 }; }
  A["road.step"] = (P, x, ev) => {
    const g = needG(P, "road"), L = ROAD[g.lv];
    if (rand(1e6) / 1e6 < L.p) {
      g.step++;
      if (g.step >= L.n) { achGive(P, "road_finish", ev); return { ok: 1, ...roadCash(P, g, ev), finish: 1 }; }
      return { ok: 1, step: g.step };
    }
    roundEnd(P, g.h, 0, ev); P.g = null; return { ok: 0, step: g.step, done: 1, pay: 0 };
  };
  A["road.cash"] = (P, x, ev) => { const g = needG(P, "road"); if (!g.step) fail("Сделайте хотя бы шаг"); return roadCash(P, g, ev); };

  /* минное поле */
  A["mines.start"] = (P, x, ev) => {
    needFree(P, "mines"); const count = MINE_OPTS.includes(+x.count) ? +x.count : fail("Неверное число мин"); const bet = betOk(x.bet);
    const h = roundStart(P, "mines", bet, ev);
    P.g = { k: "mines", bet, h, count, mines: shuffle([...Array(25).keys()]).slice(0, count), open: [] };
    return { count, open: [], bet };
  };
  function minesCash(P, g, ev) { const m = minesMult(g.count, g.open.length), pay = roundEnd(P, g.h, g.bet * m, ev, m); P.g = null; return { open: g.open, mines: g.mines, m, pay, done: 1 }; }
  A["mines.pick"] = (P, x, ev) => {
    const g = needG(P, "mines"), i = Math.floor(+x.i);
    if (!(i >= 0 && i < 25) || g.open.includes(i)) fail("Клетка уже открыта");
    if (g.mines.includes(i)) { roundEnd(P, g.h, 0, ev); P.g = null; return { boom: i, open: g.open, mines: g.mines, done: 1, pay: 0 }; }
    g.open.push(i);
    if (g.open.length === 25 - g.count) { achGive(P, "mines_clear", ev); return minesCash(P, g, ev); }
    return { open: g.open };
  };
  A["mines.cash"] = (P, x, ev) => { const g = needG(P, "mines"); if (!g.open.length) fail("Откройте хотя бы одну клетку"); return minesCash(P, g, ev); };

  /* звездопад */
  A["plinko.drop"] = (P, x, ev) => {
    const risk = P_RISK[x.risk] ? x.risk : fail("Неверный риск"), bet = betOk(x.bet);
    const h = roundStart(P, "plinko", bet, ev);
    const dirs = Array.from({ length: P_ROWS }, () => rand(2)), bucket = dirs.reduce((a, b) => a + b, 0), m = P_RISK[risk].m[bucket];
    if (bucket === 0 || bucket === P_ROWS) achGive(P, "plinko_edge", ev);
    const pay = roundEnd(P, h, bet * m, ev, m);
    return { dirs, bucket, m, pay, bet, risk };
  };

  /* сокровища рифа */
  A["reef.spin"] = (P, x, ev) => {
    const G = P.g && P.g.k === "reef" ? P.g : null;
    if (P.g && !G) needFree(P, "reef");
    if (!G) {
      const bet = betOk(x.bet), h = roundStart(P, "reef", bet, ev);
      const res = rfPlay(false); let paid = Math.floor(res.win * bet);
      jackpot(P, bet, ev);
      if (res.scat >= 4) {
        achGive(P, "reef_bonus", ev);
        const sp = Math.floor(RF_SCAT_PAY[Math.min(6, res.scat)] * bet);
        P.chips += paid + sp;
        P.g = { k: "reef", bet, h, free: 10, acc: 0, bonusWin: paid + sp };
        return { res, paid, sp, free: 10, acc: 0, bonusWin: paid + sp, bet };
      }
      roundEnd(P, h, paid, ev);
      return { res, paid, free: 0, bet };
    }
    const res = rfPlay(true);
    let paid = 0;
    if (res.win > 0) { if (res.mults > 0) G.acc += res.mults; paid = Math.floor(res.win * G.bet * Math.max(1, G.acc)); }
    P.chips += paid; G.bonusWin += paid; G.free--;
    let extra = 0; if (res.scat >= 3) { G.free += 5; extra = 5; }
    const out = { res, paid, free: G.free, acc: G.acc, bonusWin: G.bonusWin, extra, bet: G.bet, fs: 1 };
    if (G.free <= 0) {
      // выплаты бонуса уже на балансе: в истории и рейтинге — итог серии
      P.chips -= G.bonusWin; roundEnd(P, G.h, G.bonusWin, ev); P.g = null; out.end = 1;
    }
    return out;
  };

  /* золотой билет */
  A["scratch.buy"] = (P, x, ev) => {
    const bet = betOk(x.bet), h = roundStart(P, "scratch", bet, ev), d = scDeal();
    if (d.win >= 100) achGive(P, "scratch_100", ev);
    const pay = roundEnd(P, h, d.win * bet, ev, d.win);
    P.scNo++;
    return { cells: d.cells, win: d.win, pay, bet, no: P.scNo };
  };

  /* колесо удачи */
  A["wheel.spin"] = (P, x, ev) => {
    needFree(P, "wheel");
    const bets = x.bets || {}; let total = 0;
    for (const k of Object.keys(bets)) { const v = Math.round(+bets[k]); if (!WH_T[k] || !(v >= MIN_BET && v <= MAX_TABLE)) fail("Неверная ставка"); bets[k] = v; total += v; }
    if (!total) fail("Сделайте ставку"); if (total > MAX_TABLE) fail(`Сумма ставок не больше ${MAX_TABLE.toLocaleString("ru-RU")}`);
    const h = roundStart(P, "wheel", total, ev);
    const idx = rand(60), k = WH_SEGS[idx], t = WH_T[k], stake = bets[k] || 0;
    P.whLast.unshift(k); P.whLast = P.whLast.slice(0, 10);
    if (k === "super" && stake) achGive(P, "wheel_super", ev);
    const out = { idx, k, stake, bet: total };
    let m = 0;
    if (t.pay) m = t.pay;
    else if (k === "coin") { const a = whPick(WH_COIN), b = whPick(WH_COIN), side = rand(2); out.coin = { a, b, side }; m = side ? b : a; }
    else if (k === "super") { const order = shuffle(WH_SUPER.slice()), i = rand(order.length); out.sup = { order, i }; m = order[i]; }
    else {
      const vals = [whPick(WH_CHEST), whPick(WH_CHEST), whPick(WH_CHEST)];
      if (stake) { P.g = { k: "wheel", h, vals, stake, total }; out.chest = 1; return out; }
      out.chestVals = vals; m = 0;
    }
    out.m = m; out.pay = roundEnd(P, h, stake * m, ev);
    return out;
  };
  A["wheel.chest"] = (P, x, ev) => {
    const g = needG(P, "wheel"), i = Math.floor(+x.i); if (!(i >= 0 && i < 3)) fail("Выберите сундук");
    P.g = null; const m = g.vals[i], pay = roundEnd(P, g.h, g.stake * m, ev);
    return { vals: g.vals, i, m, pay, stake: g.stake, bet: g.total };
  };

  /* ледяная башня */
  A["tower.start"] = (P, x, ev) => {
    needFree(P, "tower"); const lv = TW[x.lv] ? x.lv : fail("Неверная сложность"), bet = betOk(x.bet), L = TW[lv];
    const h = roundStart(P, "tower", bet, ev);
    P.g = { k: "tower", bet, h, lv, row: 0, picks: [], traps: Array.from({ length: TW_ROWS }, () => shuffle([...Array(L.cols).keys()]).slice(0, L.cols - L.safe)) };
    return { lv, row: 0, picks: [], bet };
  };
  function twCash(P, g, ev) { const m = twMult(g.lv, g.row), pay = roundEnd(P, g.h, g.bet * m, ev, m); P.g = null; return { row: g.row, picks: g.picks, traps: g.traps, m, pay, done: 1 }; }
  A["tower.pick"] = (P, x, ev) => {
    const g = needG(P, "tower"), c = Math.floor(+x.c); if (!(c >= 0 && c < TW[g.lv].cols)) fail("Неверная плитка");
    g.picks[g.row] = c;
    if (g.traps[g.row].includes(c)) { roundEnd(P, g.h, 0, ev); P.g = null; return { lost: 1, lostRow: g.row, picks: g.picks, traps: g.traps, done: 1, pay: 0 }; }
    g.row++;
    if (g.row >= TW_ROWS) { achGive(P, "tower_top", ev); return twCash(P, g, ev); }
    return { row: g.row, picks: g.picks };
  };
  A["tower.cash"] = (P, x, ev) => { const g = needG(P, "tower"); if (!g.row) fail("Выберите плитку"); return twCash(P, g, ev); };

  /* ---------- покупки (сервер вызывает после оплаты, демо — сразу) ---------- */
  // описание товара: { stars, title, description }
  function product(kind, id) {
    if (kind === "pack") { const p = PACKS.find(y => y.id === id); return p && { stars: p.stars, title: `${p.chips.toLocaleString("ru-RU")} бемок`, description: "Виртуальная валюта Лудки. Нельзя вывести или передать." }; }
    if (kind === "item") { const it = cosItem(id); return it && it.price && { stars: it.price, title: it.t, description: `Оформление: ${it.g}. На шансы не влияет.` }; }
    if (kind === "bundle") { const b = BUNDLES.find(y => y.id === id); return b && { stars: b.price, title: b.t, description: b.d + ". На шансы не влияет." }; }
    if (kind === "vip") return { stars: VIP_PRICE, title: "Лудка VIP", description: `${VIP_DAYS} дней: бонус дня ×2 и значок VIP.` };
    return null;
  }
  // выдать товар (покупка себе или подарок)
  function grant(P, kind, id, ev = []) {
    if (kind === "pack") { const p = PACKS.find(y => y.id === id); P.chips += p.chips; return p.chips; }
    if (kind === "item") { const it = cosItem(id); if (!P.cos.owned.includes(id)) P.cos.owned.push(id); if (!P.cos.eq[it.slot]) P.cos.eq[it.slot] = id; return 0; }
    if (kind === "bundle") { const b = BUNDLES.find(y => y.id === id); b.items.forEach(i => { if (!P.cos.owned.includes(i)) P.cos.owned.push(i); }); return 0; }
    if (kind === "vip") { P.cos.vip = Math.max(NOW, P.cos.vip || 0) + VIP_DAYS * 864e5; return 0; }
    return 0;
  }
  // забрать товар при возврате звёзд
  function revoke(P, kind, id) {
    if (kind === "pack") { const p = PACKS.find(y => y.id === id); P.chips = Math.max(0, P.chips - p.chips); }
    else if (kind === "item") { P.cos.owned = P.cos.owned.filter(i => i !== id); }
    else if (kind === "bundle") { const b = BUNDLES.find(y => y.id === id); P.cos.owned = P.cos.owned.filter(i => !b.items.includes(i)); }
    else if (kind === "vip") { P.cos.vip = Math.max(0, (P.cos.vip || 0) - VIP_DAYS * 864e5); }
  }
  // демо-покупка без звёзд (только когда нет сервера)
  A["shop.demo"] = (P, x, ev) => {
    if (!CTX.demo) fail("Покупки — через Telegram", 403);
    const pr = product(x.kind, x.id); if (!pr) fail("Нет такого товара");
    if (!canSpend(P, pr.stars)) fail("Превышен лимит покупок");
    spend(P, pr.stars);
    if (x.to) { P.gifts.unshift({ to: x.to, kind: x.kind, id: x.id, t: pr.title, at: NOW, ok: false }); P.gifts = P.gifts.slice(0, 20); return { gift: 1 }; }
    return { chips: grant(P, x.kind, x.id, ev) };
  };

  /* ================= Вход ================= */
  // ctx: { now, rand, jp: {v}, demo, n? }
  function act(P, a, x = {}, ctx = {}) {
    NOW = ctx.now || Date.now();
    R = ctx.rand || R;
    CTX = ctx; CTX.jp = CTX.jp || { v: JP_SEED }; CTX.jp.add = 0; CTX.jp.hit = false; CTX.jp.won = 0;
    fix(P);
    const fn = A[a]; if (!fn) fail("Неизвестное действие", 404);
    const ev = [];
    if (P.cos.wt && P.cos.wt.until <= NOW) P.cos.wt = null;
    crashSettle(P, ev);
    questsEnsure(P); lbRoll(P); idleAccrue(P); rgLimits(P); spentRoll(P);
    const I = idleS(P); if (!I.hrAt || NOW > I.hrAt + HR_WINDOW) I.hrAt = hrNext();
    const r = fn(P, x, ev);
    if (P.chips > P.stats.maxChips) P.stats.maxChips = P.chips;
    P.chips = Math.max(0, Math.floor(P.chips));
    P.rev = (P.rev || 0) + 1;
    return { r, ev };
  }

  // что видит экран: без секретов (точка краша, мины, ловушки, карта дилера, сундуки)
  function view(P) {
    const v = JSON.parse(JSON.stringify(P)); const g = P.g;
    if (g) {
      if (g.k === "bj") v.g = { k: "bj", ...bjView(g) };
      else if (g.k === "crash") v.g = { k: "crash", bet: g.bet, auto: g.auto, el: NOW - g.t0 };
      else if (g.k === "road") v.g = { k: "road", bet: g.bet, lv: g.lv, step: g.step };
      else if (g.k === "mines") v.g = { k: "mines", bet: g.bet, count: g.count, open: g.open };
      else if (g.k === "tower") v.g = { k: "tower", bet: g.bet, lv: g.lv, row: g.row, picks: g.picks };
      else if (g.k === "reef") v.g = { k: "reef", bet: g.bet, free: g.free, acc: g.acc, bonusWin: g.bonusWin };
      else if (g.k === "wheel") v.g = { k: "wheel", stake: g.stake, bet: g.total };
    }
    v.now = NOW;
    return v;
  }
  // публичная карточка — её видят другие игроки
  function pub(P) {
    const t = eqd(P, "title");
    return { name: P.name, code: P.code, lvl: P.prog.lvl, title: t ? cosItem(t).t : levelTitle(P.prog.lvl), wt: weekTitle(P), frame: eqd(P, "frame"), nameCls: eqd(P, "name"), vip: vipOn(P),
      maxChips: P.stats.maxChips, rounds: P.ach.c.rounds, ach: Object.keys(P.ach.got).length };
  }
  const setNow = t => { NOW = t; };

  return {
    act, view, pub, newPlayer, fix, setNow, product, grant, revoke, canSpend, spend, crashWait, isoWeek, weekEnd, today, dayOf,
    START_CHIPS, MIN_BET, MAX_BET, MAX_TABLE, PACKS, DAY_LIMIT_STARS, MONTH_LIMIT_STARS, RG_DAY, RG_MONTH, RG_REMIND, H24, GAME_NAMES, STATEFUL,
    xpNeed, xpFor, levelReward, levelTitle, Q_A, Q_B, Q_ALL_BONUS, qDef, qProgress, qAllDone, STREAK, FW, streakNext, dailyAmount, rgLimits,
    ACH, ACH_CLIENT, COS, BUNDLES, VIP_PRICE, VIP_DAYS, cosItem, vipOn, owns, eqd, WEEK_TITLES, weekTitle, FRIEND_BONUS,
    IDLE_B, IDLE_MS, IDLE_SOFT, SAFE, GLOVE_COST, PRESTIGE_AT, bLevel, bCost, bRate, idleRate, idleGain, safeCap, tapValue,
    SYMS, WHEEL, REDS, colorOf, OUT, SUITS, RANKS, score, CRASH_RTP, CRASH_SPEED, AUTOS, ROAD, ROAD_RTP, roadMult, MINES_RTP, MINE_OPTS, minesMult,
    P_ROWS, P_RISK, RF_COLS, RF_ROWS, RF_SYMS, RF_SCAT, RF_SCAT_PAY, RF_PAY_SCALE, rfNew, rfIdx, rfPlay, SC_PRIZES, JP_SEED, JP_RATE, JP_ODDS,
    WH_TYPES, WH_T, WH_SEGS, WH_COIN, WH_CHEST, WH_SUPER, TW_ROWS, TW_RTP, TW, twMult
  };
})();
/* ENGINE:END */

const INIT_DATA_MAX_AGE = 7 * 24 * 3600;
const CODE_ABC = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const MAX_FRIENDS = 200;

const TERMS = `Условия «Лудки»

1. Лудка — развлекательная игра для лиц старше 18 лет на виртуальную валюту — бемки.
2. Бемки нельзя вывести, обменять на деньги, товары или услуги, передать другим игрокам. Выигрыш в игре не означает выигрыша в реальных азартных играх.
3. За Telegram Stars продаются бемки, оформление и VIP — цифровые товары для развлечения. Они зачисляются сразу после оплаты.
4. Действуют лимиты покупок: не больше 200 ⭐ в день и 1000 ⭐ в месяц. В игре можно установить свои, более строгие лимиты и паузу.
5. Если покупка не пришла или прошла с ошибкой — напишите /paysupport, разберёмся и при необходимости вернём звёзды.
6. Поддержка Telegram и поддержка ботов не помогают с покупками в этой игре — пишите нам через /paysupport.`;

/* ---------- Telegram Bot API ---------- */
async function tg(env, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}
const tgSafe = (env, m, p) => tg(env, m, p).catch(e => console.log("tg", e.message));

/* ---------- проверка, что запрос пришёл из настоящего Telegram ---------- */
async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash"); if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), botToken);
  if (hex(await hmac(secret, dataCheck)) !== hash) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > INIT_DATA_MAX_AGE) return null;
  try { const user = JSON.parse(params.get("user") || "null"); return user && { ...user, start: params.get("start_param") || "" }; } catch { return null; }
}

/* ---------- база ---------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, code TEXT UNIQUE, name TEXT, p TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
    chips INTEGER DEFAULT 0, max_chips INTEGER DEFAULT 0, rounds INTEGER DEFAULT 0, week TEXT DEFAULT '', wnet INTEGER DEFAULT 0, lvl INTEGER DEFAULT 1,
    pub TEXT, ref_by TEXT, created INTEGER, seen INTEGER)`,
  `CREATE INDEX IF NOT EXISTS i_chips ON players(chips DESC)`,
  `CREATE INDEX IF NOT EXISTS i_week ON players(week, wnet DESC)`,
  `CREATE INDEX IF NOT EXISTS i_rounds ON players(rounds DESC)`,
  `CREATE TABLE IF NOT EXISTS friends (a TEXT NOT NULL, b TEXT NOT NULL, at INTEGER, PRIMARY KEY (a, b))`,
  `CREATE TABLE IF NOT EXISTS payments (charge TEXT PRIMARY KEY, uid TEXT NOT NULL, kind TEXT, item TEXT, to_uid TEXT, stars INTEGER, at INTEGER, refunded INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS globals (k TEXT PRIMARY KEY, v TEXT)`
];
async function ensureSchema(env) { await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))); }

const nameOf = u => String([u.first_name, u.last_name ? u.last_name[0] + "." : ""].filter(Boolean).join(" ") || "Игрок").replace(/[<>]/g, "").slice(0, 32);
function randomCode() { const a = new Uint32Array(6); crypto.getRandomValues(a); return "LK-" + [...a].map(n => CODE_ABC[n % CODE_ABC.length]).join(""); }
const cryptoRand = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };

async function loadRow(env, uid) {
  const row = await env.DB.prepare("SELECT p, rev FROM players WHERE id = ?").bind(uid).first();
  if (!row) return null;
  const P = JSON.parse(row.p); P.rev = row.rev; return P;
}
async function createPlayer(env, user) {
  const uid = String(user.id), now = Date.now(), P = E.newPlayer(now);
  P.name = nameOf(user);
  // приглашение по ссылке ?startapp=ref_LK-XXXXXX
  const m = /^ref_(LK-[A-Z0-9]{4,8})$/.exec(user.start || "");
  let refUid = "";
  if (m) { const r = await env.DB.prepare("SELECT id FROM players WHERE code = ?").bind(m[1]).first(); if (r && r.id !== uid) refUid = r.id; }
  P.refBy = refUid;
  for (let i = 0; i < 6; i++) {
    P.code = randomCode();
    const res = await env.DB.prepare(`INSERT OR IGNORE INTO players (id, code, name, p, rev, chips, max_chips, rounds, week, wnet, lvl, pub, ref_by, created, seen)
      VALUES (?, ?, ?, ?, 0, ?, ?, 0, '', 0, 1, ?, ?, ?, ?)`).bind(uid, P.code, P.name, JSON.stringify(P), P.chips, P.chips, JSON.stringify(E.pub(P)), refUid, now, now).run();
    if (res.meta.changes) break;
    const ex = await loadRow(env, uid); if (ex) return ex; // уже создан параллельным запросом
  }
  if (refUid) await befriend(env, uid, refUid);
  P.rev = 0; return P;
}
// сохранить, только если никто не успел изменить запись (защита от двойных трат)
async function saveRow(env, uid, P, oldRev) {
  const res = await env.DB.prepare(`UPDATE players SET p = ?, rev = ?, name = ?, chips = ?, max_chips = ?, rounds = ?, week = ?, wnet = ?, lvl = ?, pub = ?, seen = ?
    WHERE id = ? AND rev = ?`).bind(JSON.stringify(P), P.rev, P.name, P.chips, P.stats.maxChips, P.ach.c.rounds, P.lb.week, P.lb.wNet, P.prog.lvl, JSON.stringify(E.pub(P)), Date.now(), uid, oldRev).run();
  return res.meta.changes > 0;
}
// изменить игрока с повтором при гонке; fn(P) может вернуть что угодно
async function mutate(env, uid, fn) {
  for (let i = 0; i < 6; i++) {
    const P = await loadRow(env, uid); if (!P) return null;
    const old = P.rev; E.fix(P); E.setNow(Date.now());
    const out = await fn(P); if (out === false) return false;
    P.rev = old + 1;
    if (await saveRow(env, uid, P, old)) return { P, out };
  }
  throw new Error("busy");
}
async function befriend(env, a, b) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO friends (a, b, at) VALUES (?, ?, ?)").bind(a, b, now),
    env.DB.prepare("INSERT OR IGNORE INTO friends (a, b, at) VALUES (?, ?, ?)").bind(b, a, now)
  ]);
}
async function globals(env) {
  const rows = (await env.DB.prepare("SELECT k, v FROM globals").all()).results || [];
  return Object.fromEntries(rows.map(r => [r.k, r.v]));
}
const note = (P, text) => { P.notes = [...(P.notes || []), { t: text, at: Date.now() }].slice(-10); };

/* ---------- ход игрока ---------- */
async function playerAct(env, user, a, x, G) {
  const uid = String(user.id);
  for (let attempt = 0; attempt < 5; attempt++) {
    let P = await loadRow(env, uid);
    if (!P) P = await createPlayer(env, user);
    const old = P.rev, name = nameOf(user);
    if (P.name !== name) P.name = name;
    const ctx = { now: Date.now(), rand: cryptoRand, jp: { v: Number(G.jp || E.JP_SEED) } };
    const { r, ev } = E.act(P, a, x, ctx);
    if (!(await saveRow(env, uid, P, old))) continue; // кто-то успел раньше — повторяем с новыми данными
    // общий джекпот
    if (ctx.jp.hit) await env.DB.prepare("INSERT INTO globals (k, v) VALUES ('jp', ?) ON CONFLICT(k) DO UPDATE SET v = ?").bind(String(E.JP_SEED), String(E.JP_SEED)).run();
    else if (ctx.jp.add) await env.DB.prepare("INSERT INTO globals (k, v) VALUES ('jp', ?) ON CONFLICT(k) DO UPDATE SET v = CAST(v AS REAL) + ?").bind(String(E.JP_SEED + ctx.jp.add), ctx.jp.add).run();
    // друг сыграл первую игру — награда пригласившему
    if (ctx.refCredit) await mutate(env, ctx.refCredit, Q => { Q.refs = (Q.refs || 0) + 1; Q.chips += E.FRIEND_BONUS; note(Q, `Ваш друг ${P.name} сыграл первую игру: +${E.FRIEND_BONUS.toLocaleString("ru-RU")} бемок`); }).catch(e => console.log("ref", e.message));
    const jp = ctx.jp.hit ? E.JP_SEED : Number(G.jp || E.JP_SEED) + ctx.jp.add;
    return { r, ev, p: E.view(P), jp };
  }
  throw new Error("busy");
}

/* ---------- рейтинги и друзья ---------- */
const pubOf = row => { try { return JSON.parse(row.pub); } catch { return { name: row.name, lvl: row.lvl }; } };
async function top(env, uid, tab) {
  const week = E.isoWeek(Date.now());
  const q = tab === "week" ? ["SELECT id, pub, wnet AS v FROM players WHERE week = ? AND rounds > 0 ORDER BY wnet DESC LIMIT 50", [week]]
    : tab === "games" ? ["SELECT id, pub, rounds AS v FROM players WHERE rounds > 0 ORDER BY rounds DESC LIMIT 50", []]
    : ["SELECT id, pub, chips AS v FROM players WHERE rounds > 0 ORDER BY chips DESC LIMIT 50", []];
  const rows = (await env.DB.prepare(q[0]).bind(...q[1]).all()).results || [];
  const me = await env.DB.prepare("SELECT chips, rounds, week, wnet FROM players WHERE id = ?").bind(uid).first();
  let place = null;
  if (me) {
    const mv = tab === "week" ? (me.week === week ? me.wnet : 0) : tab === "games" ? me.rounds : me.chips;
    const cnt = tab === "week" ? await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE week = ? AND rounds > 0 AND wnet > ?").bind(week, mv).first()
      : tab === "games" ? await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE rounds > ?").bind(mv).first()
      : await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE rounds > 0 AND chips > ?").bind(mv).first();
    place = { n: (cnt?.n || 0) + 1, v: mv };
  }
  return { rows: rows.map((r, i) => ({ n: i + 1, me: r.id === uid, v: r.v, ...pubOf(r) })), place, week, ends: E.weekEnd(Date.now()) };
}
async function friendsList(env, uid) {
  const week = E.isoWeek(Date.now());
  const rows = (await env.DB.prepare(`SELECT p.id, p.pub, p.chips, p.week, p.wnet, p.code FROM friends f JOIN players p ON p.id = f.b WHERE f.a = ? ORDER BY p.chips DESC LIMIT ?`).bind(uid, MAX_FRIENDS).all()).results || [];
  return { rows: rows.map(r => ({ ...pubOf(r), code: r.code, chips: r.chips, wnet: r.week === week ? r.wnet : 0 })) };
}
async function friendAdd(env, uid, code) {
  code = String(code || "").toUpperCase().replace(/\s/g, "");
  if (!/^LK-[A-Z0-9]{4,8}$/.test(code)) return { error: "Неверный код — он выглядит как LK-7Q2M" };
  const r = await env.DB.prepare("SELECT id FROM players WHERE code = ?").bind(code).first();
  if (!r) return { error: "Игрок с таким кодом не найден" };
  if (r.id === uid) return { error: "Это ваш собственный код" };
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM friends WHERE a = ?").bind(uid).first();
  if ((n?.n || 0) >= MAX_FRIENDS) return { error: "Слишком много друзей" };
  await befriend(env, uid, r.id);
  return { ok: 1 };
}
async function friendDel(env, uid, code) {
  const r = await env.DB.prepare("SELECT id FROM players WHERE code = ?").bind(String(code || "")).first();
  if (r) await env.DB.batch([env.DB.prepare("DELETE FROM friends WHERE a = ? AND b = ?").bind(uid, r.id), env.DB.prepare("DELETE FROM friends WHERE a = ? AND b = ?").bind(r.id, uid)]);
  return { ok: 1 };
}

/* ---------- покупки ---------- */
// payload счёта (до 128 байт): u — кто платит, k — вид, i — товар, t — кому (для подарка)
async function invoice(env, uid, x) {
  const kind = String(x.kind || ""), id = String(x.id || "");
  const pr = E.product(kind, id); if (!pr) return { error: "Нет такого товара" };
  const P = await loadRow(env, uid); if (!P) return { error: "Сначала откройте игру" };
  E.fix(P); E.setNow(Date.now());
  if (!P.adult) return { error: "Подтвердите возраст" };
  if (!E.canSpend(P, pr.stars)) return { error: "Превышен лимит покупок" };
  let to = "", title = pr.title;
  if (x.to) {
    if (!["item", "vip"].includes(kind)) return { error: "Это нельзя подарить" };
    const r = await env.DB.prepare("SELECT id, name FROM players WHERE code = ?").bind(String(x.to).toUpperCase()).first();
    if (!r) return { error: "Игрок с таким кодом не найден" };
    if (r.id === uid) return { error: "Себе подарок — это покупка 🙂" };
    to = r.id; title = `Подарок: ${pr.title}`;
  }
  const payload = JSON.stringify({ u: uid, k: kind, i: id, ...(to ? { t: to } : {}) });
  const link = await tg(env, "createInvoiceLink", {
    title: title.slice(0, 32), description: pr.description.slice(0, 255), payload, provider_token: "", currency: "XTR",
    prices: [{ label: pr.title.slice(0, 32), amount: pr.stars }]
  });
  return { link };
}
async function preCheckout(env, q) {
  let ok = false, err = "Этот товар сейчас недоступен. Откройте магазин в игре заново.";
  try {
    const d = JSON.parse(q.invoice_payload), pr = E.product(d.k, d.i);
    if (q.currency === "XTR" && pr && pr.stars === q.total_amount && String(q.from.id) === d.u) {
      const P = await loadRow(env, d.u);
      if (P) { E.fix(P); E.setNow(Date.now()); ok = E.canSpend(P, pr.stars); if (!ok) err = "Превышен лимит покупок. Его можно изменить в игре: «Ответственная игра»."; }
    }
  } catch { ok = false; }
  await tg(env, "answerPreCheckoutQuery", { pre_checkout_query_id: q.id, ok, ...(ok ? {} : { error_message: err }) });
}
async function paid(env, msg) {
  const sp = msg.successful_payment, charge = sp.telegram_payment_charge_id, d = JSON.parse(sp.invoice_payload), pr = E.product(d.k, d.i);
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO payments (charge, uid, kind, item, to_uid, stars, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(charge, d.u, d.k, d.i, d.t || "", sp.total_amount, Date.now()).run();
  if (!ins.meta.changes) return; // этот платёж уже обработан
  let giftTo = "";
  await mutate(env, d.u, P => {
    E.spend(P, sp.total_amount);
    if (d.t) { P.gifts = [{ to: "", kind: d.k, id: d.i, t: pr.title, at: Date.now(), ok: true }, ...(P.gifts || [])].slice(0, 20); return; }
    const chips = E.grant(P, d.k, d.i);
    note(P, chips ? `Зачислено ${chips.toLocaleString("ru-RU")} бемок. Спасибо!` : `Покупка: ${pr.title}. Спасибо!`);
  });
  if (d.t) {
    const res = await mutate(env, d.t, Q => { E.grant(Q, d.k, d.i); note(Q, `🎁 Вам подарок: ${pr.title}`); });
    const from = await env.DB.prepare("SELECT name, code FROM players WHERE id = ?").bind(d.u).first();
    giftTo = res?.P?.name || "";
    await mutate(env, d.u, P => { if (P.gifts[0]) P.gifts[0].to = res?.P?.code || ""; });
    await tgSafe(env, "sendMessage", { chat_id: Number(d.t), text: `🎁 ${from?.name || "Друг"} подарил(а) вам в «Лудке»: ${pr.title}` });
  }
  await tg(env, "sendMessage", { chat_id: msg.chat.id, text: `Спасибо! ${giftTo ? `Подарок «${pr.title}» отправлен: ${giftTo}.` : `Зачислено: ${pr.title}.`}\nНомер платежа: ${charge}\nЕсли что-то не так — /paysupport` });
}
async function refund(env, chatId, charge) {
  const rec = charge && await env.DB.prepare("SELECT * FROM payments WHERE charge = ?").bind(charge).first();
  if (!rec) return tg(env, "sendMessage", { chat_id: chatId, text: "Платёж не найден. Формат: /refund <номер платежа>" });
  if (rec.refunded) return tg(env, "sendMessage", { chat_id: chatId, text: "Этот платёж уже возвращён." });
  await tg(env, "refundStarPayment", { user_id: Number(rec.uid), telegram_payment_charge_id: charge });
  await env.DB.prepare("UPDATE payments SET refunded = 1 WHERE charge = ?").bind(charge).run();
  await mutate(env, rec.to_uid || rec.uid, P => { E.revoke(P, rec.kind, rec.item); });
  await tg(env, "sendMessage", { chat_id: chatId, text: `Возвращено ${rec.stars} ⭐, покупка списана.` });
}

/* ---------- звания недели ---------- */
async function weeklyTitles(env, force) {
  const now = Date.now(), prev = E.isoWeek(now - 864e5 * 7 + 3600e3);
  // отмечаем неделю атомарно: если два запроса пришли одновременно, звания раздаст только один
  const mark = await env.DB.prepare("INSERT INTO globals (k, v) VALUES ('wt_week', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE globals.v <> excluded.v").bind(prev).run();
  if (!force && !mark.meta.changes) return 0;
  const rows = (await env.DB.prepare("SELECT id FROM players WHERE week = ? AND wnet > 0 ORDER BY wnet DESC LIMIT 10").bind(prev).all()).results || [];
  const until = E.weekEnd(now);
  for (let i = 0; i < rows.length; i++) {
    const w = E.WEEK_TITLES[i];
    await mutate(env, rows[i].id, P => { P.cos.wt = { place: i + 1, until }; note(P, `${w.i} Итоги недели: ${i + 1} место! Звание «${w.t}» — на всю неделю`); }).catch(e => console.log("wt", e.message));
  }
  return rows.length;
}

/* ---------- ответы игре ---------- */
function cors(env, request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  return { "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : (allowed[0] || ""), "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Init-Data", "Access-Control-Max-Age": "86400", "Vary": "Origin" };
}
const json = (env, request, body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(env, request) } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function handleApi(request, env, path, ctx) {
  const user = await verifyInitData(request.headers.get("X-Init-Data"), env.BOT_TOKEN);
  if (!user?.id) return json(env, request, { error: "Откройте игру из Telegram" }, 401);
  const uid = String(user.id);
  const body = await request.text(); if (body.length > 8000) return json(env, request, { error: "Слишком большой запрос" }, 413);
  let x = {}; try { x = JSON.parse(body || "{}"); } catch {}
  const G = await globals(env);
  if (G.wt_week !== E.isoWeek(Date.now() - 864e5 * 7 + 3600e3)) ctx.waitUntil(weeklyTitles(env).catch(e => console.log("wt", e.message)));

  if (path === "/api") {
    const a = String(x.a || ""), args = x.x && typeof x.x === "object" ? x.x : {};
    if (a === "crash.watch") { // держим запрос до падения самолётика (до 20 секунд за раз)
      const P = await loadRow(env, uid);
      if (P) { E.setNow(Date.now()); const w = E.crashWait(P); if (w > 0) await sleep(Math.min(w + 30, 20000)); }
    }
    return json(env, request, await playerAct(env, user, a, args, G));
  }
  if (path === "/top") return json(env, request, await top(env, uid, x.tab));
  if (path === "/friends") return json(env, request, await friendsList(env, uid));
  if (path === "/friend.add") return json(env, request, await friendAdd(env, uid, x.code));
  if (path === "/friend.del") return json(env, request, await friendDel(env, uid, x.code));
  if (path === "/invoice") return json(env, request, await invoice(env, uid, x));
  return json(env, request, { error: "Не найдено" }, 404);
}

/* ---------- обновления от Telegram ---------- */
async function handleUpdate(update, env) {
  if (update.pre_checkout_query) return preCheckout(env, update.pre_checkout_query);
  const msg = update.message; if (!msg) return;
  if (msg.successful_payment) return paid(env, msg);
  const text = (msg.text || "").trim(), chat_id = msg.chat.id, support = env.SUPPORT_CONTACT || "владельцу бота";
  const isAdmin = env.ADMIN_ID && String(msg.from?.id) === String(env.ADMIN_ID);
  if (text.startsWith("/start")) {
    const ref = text.split(/\s+/)[1] || "", url = env.GAME_URL ? env.GAME_URL + "?startapp" + (ref.startsWith("ref_") ? "=" + encodeURIComponent(ref) : "") : "";
    await tg(env, "sendMessage", { chat_id, text: "🎰 «Лудка» — социальное казино на бемки: слоты, рулетка, самолётик, минное поле и ещё 7 игр. Соревнуйтесь с друзьями в рейтинге!\n\nТолько 18+. Бемки виртуальные — их нельзя вывести.",
      reply_markup: url ? { inline_keyboard: [[{ text: "Играть", url }]] } : undefined });
  } else if (text.startsWith("/terms")) {
    await tg(env, "sendMessage", { chat_id, text: TERMS });
  } else if (text.startsWith("/paysupport")) {
    await tg(env, "sendMessage", { chat_id, text: `Проблема с оплатой? Напишите ${support}: что купили, когда и номер платежа из сообщения бота. Ответим и при необходимости вернём звёзды.` });
  } else if (text.startsWith("/support")) {
    await tg(env, "sendMessage", { chat_id, text: `Вопросы и идеи по игре: ${support}. Поддержка Telegram с покупками в этой игре не помогает.` });
  } else if (text.startsWith("/refund") && isAdmin) {
    await refund(env, chat_id, text.split(/\s+/)[1]);
  } else if (text.startsWith("/stats") && isAdmin) {
    const s = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(rounds) AS r FROM players").first();
    const p = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(stars) AS s FROM payments WHERE refunded = 0").first();
    await tg(env, "sendMessage", { chat_id, text: `Игроков: ${s?.n || 0}\nРаундов: ${s?.r || 0}\nПокупок: ${p?.n || 0} на ${p?.s || 0} ⭐` });
  }
}

/* ---------- точка входа ---------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env, request) });

    if (path === "/tg" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      try { await handleUpdate(await request.json(), env); } catch (e) { console.log("update error", e.message); }
      return new Response("ok");
    }

    // Одноразовая настройка: /setup?key=WEBHOOK_SECRET
    if (path === "/setup") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const out = [];
      const step = async (t, f) => { try { await f(); out.push("✓ " + t); } catch (e) { out.push("✗ " + t + ": " + e.message); } };
      await step("база данных", () => ensureSchema(env));
      await step("вебхук", () => tg(env, "setWebhook", { url: `${url.origin}/tg`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "pre_checkout_query"] }));
      await step("команды", () => tg(env, "setMyCommands", { commands: [
        { command: "start", description: "Играть" }, { command: "terms", description: "Условия" },
        { command: "paysupport", description: "Помощь с оплатой" }, { command: "support", description: "Поддержка" }] }));
      if (env.APP_URL) await step("кнопка «Играть»", () => tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "Играть", web_app: { url: env.APP_URL } } }));
      await step("описание", () => tg(env, "setMyShortDescription", { short_description: "Социальное казино на бемки. 18+. Бемки нельзя вывести." }));
      return new Response("Лудка — настройка:\n" + out.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (["/api", "/top", "/friends", "/friend.add", "/friend.del", "/invoice"].includes(path) && request.method === "POST") {
      try { return await handleApi(request, env, path, ctx); }
      catch (e) {
        if (e.user) return json(env, request, { error: e.message, code: e.code }, 200);
        console.log("api error", e.stack || e.message);
        return json(env, request, { error: "Ошибка сервера, попробуйте ещё раз" }, 500);
      }
    }
    return new Response("Лудка — сервер работает", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(weeklyTitles(env)); }
};
