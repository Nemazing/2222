// server.js — Wildfall backend
// Работает на Render / Railway / VPS / локально
// Запуск: node server.js

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// CORS — разрешаем всем (для P2P и внешних клиентов)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Простое логирование
app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
});

// Статика — index.html, css, js, картинки
app.use(express.static(__dirname, {
    maxAge: '1h',
    etag: true,
}));

// ─────────────────────────────────────────────
// БАЗА ДАННЫХ (файловая, простейшая)
// ─────────────────────────────────────────────
let db = { accounts: {}, notifs: {} };
try {
    if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        db = JSON.parse(raw);
        // Валидация структуры
        if (!db.accounts) db.accounts = {};
        if (!db.notifs) db.notifs = {};
        console.log(`📂 БД загружена: ${Object.keys(db.accounts).length} аккаунтов`);
    } else {
        console.log('📂 БД не найдена, будет создана при первом сохранении');
    }
} catch (e) {
    console.error('❌ Ошибка загрузки БД:', e.message);
}

let saveTimer = null;
function saveDb() {
    // Дебаунсим запись, чтобы не спамить диск
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        } catch (e) {
            console.error('❌ Ошибка сохранения БД:', e.message);
        }
    }, 300);
}

// ─────────────────────────────────────────────
// ХЕШИРОВАНИЕ ПАРОЛЕЙ
// ─────────────────────────────────────────────
const SALT = process.env.SALT || 'wildfall_salt_2024_change_me';
function hashPass(p) {
    return crypto.createHash('sha256').update(p + SALT).digest('hex');
}

// ─────────────────────────────────────────────
// API
// ─────────────────────────────────────────────

// Healthcheck
app.get('/api/ping', (req, res) => {
    res.json({
        ok: true,
        server: 'Wildfall',
        uptime: Math.round(process.uptime()),
        accounts: Object.keys(db.accounts).length,
        time: Date.now(),
    });
});

// Регистрация
app.post('/api/register', (req, res) => {
    try {
        const { username, password, avatar, avatarIsImage, color } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ ok: false, error: 'Нужны ник и пароль' });
        }
        if (username.length < 2 || username.length > 16) {
            return res.status(400).json({ ok: false, error: 'Ник от 2 до 16 символов' });
        }
        if (password.length < 3) {
            return res.status(400).json({ ok: false, error: 'Пароль от 3 символов' });
        }
        if (!/^[a-zA-Zа-яА-Я0-9_\- ]+$/.test(username)) {
            return res.status(400).json({ ok: false, error: 'Только буквы, цифры, _ - и пробел' });
        }
        if (db.accounts[username]) {
            return res.status(400).json({ ok: false, error: 'Ник занят' });
        }
        db.accounts[username] = {
            passHash: hashPass(password),
            avatar: avatar || '😀',
            avatarIsImage: !!avatarIsImage,
            color: color || '#8bc34a',
            created: Date.now(),
        };
        db.notifs[username] = db.notifs[username] || [];
        saveDb();
        console.log(`✅ Зарегистрирован: ${username}`);
        res.json({ ok: true });
    } catch (e) {
        console.error('register error:', e);
        res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    }
});

// Логин
app.post('/api/login', (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ ok: false, error: 'Нужны ник и пароль' });
        }
        const acc = db.accounts[username];
        if (!acc) {
            return res.status(400).json({ ok: false, error: 'Аккаунт не найден' });
        }
        if (acc.passHash !== hashPass(password)) {
            return res.status(400).json({ ok: false, error: 'Неверный пароль' });
        }
        res.json({
            ok: true,
            avatar: acc.avatar,
            avatarIsImage: acc.avatarIsImage,
            color: acc.color,
        });
    } catch (e) {
        console.error('login error:', e);
        res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    }
});

// Проверка существования пользователя
app.get('/api/user/:username', (req, res) => {
    res.json({ exists: !!db.accounts[req.params.username] });
});

// Получить уведомления пользователя
app.get('/api/notifs/:username', (req, res) => {
    const u = req.params.username;
    res.json({ notifs: db.notifs[u] || [] });
});

// Отправить уведомление пользователю
app.post('/api/notifs/:username', (req, res) => {
    try {
        const u = req.params.username;
        if (!db.accounts[u]) {
            return res.status(404).json({ ok: false, error: 'Пользователь не найден' });
        }
        if (!db.notifs[u]) db.notifs[u] = [];
        const notif = { ...req.body, t: req.body.t || Date.now() };
        db.notifs[u].push(notif);
        // Ограничиваем длину очереди
        if (db.notifs[u].length > 100) {
            db.notifs[u] = db.notifs[u].slice(-100);
        }
        saveDb();
        res.json({ ok: true });
    } catch (e) {
        console.error('notif post error:', e);
        res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    }
});

// Удалить уведомление по timestamp
app.delete('/api/notifs/:username/:t', (req, res) => {
    try {
        const u = req.params.username;
        const t = parseInt(req.params.t, 10);
        if (!db.notifs[u]) return res.json({ ok: true });
        db.notifs[u] = db.notifs[u].filter(n => n.t !== t);
        saveDb();
        res.json({ ok: true });
    } catch (e) {
        console.error('notif delete error:', e);
        res.status(500).json({ ok: false, error: 'Ошибка сервера' });
    }
});

// Список аккаунтов (для отладки, можно убрать в проде)
app.get('/api/stats', (req, res) => {
    res.json({
        accounts: Object.keys(db.accounts).length,
        notifs_total: Object.values(db.notifs).reduce((s, a) => s + a.length, 0),
        uptime: Math.round(process.uptime()),
    });
});

// ─────────────────────────────────────────────
// FALLBACK: всё остальное → index.html
// ─────────────────────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ─────────────────────────────────────────────
// ERROR HANDLER
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ ok: false, error: 'Внутренняя ошибка' });
});

// ─────────────────────────────────────────────
// ЗАПУСК
// ─────────────────────────────────────────────
const server = app.listen(PORT, () => {
    console.log('');
    console.log('🌲 ═══════════════════════════════════════');
    console.log(`🌲  Wildfall server запущен`);
    console.log(`🌲  Порт: ${PORT}`);
    console.log(`🌲  URL:  http://localhost:${PORT}`);
    console.log(`🌲  БД:   ${DB_FILE}`);
    console.log(`🌲  Режим: ${process.env.NODE_ENV || 'development'}`);
    console.log('🌲 ═══════════════════════════════════════');
    console.log('');
});

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────
function shutdown(signal) {
    console.log(`\n⏹️  Получен ${signal}, завершаем...`);
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch(e) {}
    server.close(() => {
        console.log('👋 Сервер остановлен');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));