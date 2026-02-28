// server.js
// Запуск: node server.js
// Откройте в браузере: http://localhost:3000

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const PORT = 3000;

// ========== IN-MEMORY DATABASE ==========
const db = {
    users: {},      // id -> { name, bestScore, coins, totalApples, friends:[], token }
    requests: [],   // { id, from, to, status, time }
    tokens: {}      // token -> userId
};

// Save/load to file for persistence
const DB_FILE = 'snake_db.json';
function saveDB() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch(e) {}
}
function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            Object.assign(db, data);
        }
    } catch(e) {}
}
loadDB();

// Auto-save every 30 seconds
setInterval(saveDB, 30000);

function generateId() {
    let id;
    do { id = String(Math.floor(100000 + Math.random() * 900000)); } while(db.users[id]);
    return id;
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function getUserByToken(token) {
    const userId = db.tokens[token];
    if (userId && db.users[userId]) return { id: userId, ...db.users[userId] };
    return null;
}

// ========== SSE (Server-Sent Events) for real-time ==========
const sseClients = {}; // userId -> [response, ...]

function sendSSE(userId, data) {
    if (sseClients[userId]) {
        const msg = data: ${JSON.stringify(data)}\n\n;
        sseClients[userId] = sseClients[userId].filter(res => {
            try { res.write(msg); return true; } catch(e) { return false; }
        });
    }
}

// ========== API HANDLERS ==========
function handleAPI(req, res, pathname, body) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // POST /api/register — register or login
    if (pathname === '/api/register' && req.method === 'POST') {
        const { token: existingToken, name } = body;

        // Try to restore session
        if (existingToken) {
            const user = getUserByToken(existingToken);
            if (user) {
                if (name && name.trim()) {
                    db.users[user.id].name = name.trim().substring(0, 15);
                    saveDB();
                }
                res.end(JSON.stringify({ ok: true, userId: user.id, token: existingToken, user: db.users[user.id] }));
                return;
            }
        }

        // New registration
        const userId = generateId();
        const token = generateToken();
        db.users[userId] = {
            name: (name && name.trim()) ? name.trim().substring(0, 15) : 'User',
            bestScore: 0,
            coins: 0,
            totalApples: 0,
            friends: [],
            token: token
        };
        db.tokens[token] = userId;
        saveDB();
        res.end(JSON.stringify({ ok: true, userId, token, user: db.users[userId] }));
        return;
    }

    // Auth check for other endpoints
    const authToken = body.token || '';
    const currentUser = getUserByToken(authToken);

    if (!currentUser && pathname !== '/api/register' && pathname !== '/api/sse') {
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false, error: 'Не авторизован' }));
        return;
    }

    // POST /api/update — update user data
    if (pathname === '/api/update' && req.method === 'POST') {
        const { name, bestScore, coins, totalApples } = body;
        const u = db.users[currentUser.id];
        if (name !== undefined) u.name = String(name).trim().substring(0, 15);
        if (bestScore !== undefined) u.bestScore = Math.max(u.bestScore, Number(bestScore) || 0);
        if (coins !== undefined) u.coins = Number(coins) || 0;
        if (totalApples !== undefined) u.totalApples = Number(totalApples) || 0;
        saveDB();
        res.end(JSON.stringify({ ok: true, user: u }));
        return;
    }
// POST /api/friend/find — find user by ID
    if (pathname === '/api/friend/find' && req.method === 'POST') {
        const { targetId } = body;
        const target = db.users[targetId];
        if (!target) {
            res.end(JSON.stringify({ ok: false, error: 'Пользователь не найден' }));
            return;
        }
        res.end(JSON.stringify({ ok: true, user: { id: targetId, name: target.name, bestScore: target.bestScore } }));
        return;
    }

    // POST /api/friend/request — send friend request
    if (pathname === '/api/friend/request' && req.method === 'POST') {
        const { targetId } = body;
        if (targetId === currentUser.id) {
            res.end(JSON.stringify({ ok: false, error: 'Нельзя добавить себя' }));
            return;
        }
        if (!db.users[targetId]) {
            res.end(JSON.stringify({ ok: false, error: 'Пользователь не найден' }));
            return;
        }
        const u = db.users[currentUser.id];
        if (u.friends && u.friends.includes(targetId)) {
            res.end(JSON.stringify({ ok: false, error: 'Уже в друзьях' }));
            return;
        }
        const existing = db.requests.find(r =>
            ((r.from === currentUser.id && r.to === targetId) || (r.from === targetId && r.to === currentUser.id))
            && r.status === 'pending'
        );
        if (existing) {
            res.end(JSON.stringify({ ok: false, error: 'Заявка уже существует' }));
            return;
        }
        const reqId = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        db.requests.push({ id: reqId, from: currentUser.id, to: targetId, status: 'pending', time: Date.now() });
        saveDB();
        // Notify target via SSE
        sendSSE(targetId, { type: 'friend_request', from: currentUser.id, fromName: db.users[currentUser.id].name });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // POST /api/friend/accept
    if (pathname === '/api/friend/accept' && req.method === 'POST') {
        const { requestId } = body;
        const r = db.requests.find(x => x.id === requestId && x.to === currentUser.id && x.status === 'pending');
        if (!r) {
            res.end(JSON.stringify({ ok: false, error: 'Заявка не найдена' }));
            return;
        }
        r.status = 'accepted';

        // Add friends both ways
        if (!db.users[currentUser.id].friends) db.users[currentUser.id].friends = [];
        if (!db.users[r.from].friends) db.users[r.from].friends = [];
        if (!db.users[currentUser.id].friends.includes(r.from)) db.users[currentUser.id].friends.push(r.from);
        if (!db.users[r.from].friends.includes(currentUser.id)) db.users[r.from].friends.push(currentUser.id);
        saveDB();

        sendSSE(r.from, { type: 'friend_accepted', by: currentUser.id, byName: db.users[currentUser.id].name });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // POST /api/friend/reject
    if (pathname === '/api/friend/reject' && req.method === 'POST') {
        const { requestId } = body;
        db.requests = db.requests.filter(x => !(x.id === requestId && x.to === currentUser.id));
        saveDB();
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // POST /api/friend/cancel
    if (pathname === '/api/friend/cancel' && req.method === 'POST') {
        const { requestId } = body;
        db.requests = db.requests.filter(x => !(x.id === requestId && x.from === currentUser.id));
        saveDB();
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // POST /api/friend/remove
    if (pathname === '/api/friend/remove' && req.method === 'POST') {
        const { friendId } = body;
        const u = db.users[currentUser.id];
        u.friends = (u.friends || []).filter(f => f !== friendId);
if (db.users[friendId]) {
            db.users[friendId].friends = (db.users[friendId].friends || []).filter(f => f !== currentUser.id);
        }
        saveDB();
        sendSSE(friendId, { type: 'friend_removed', by: currentUser.id });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // POST /api/friend/list
    if (pathname === '/api/friend/list' && req.method === 'POST') {
        const u = db.users[currentUser.id];
        const friends = (u.friends || []).map(fid => {
            const f = db.users[fid];
            return f ? { id: fid, name: f.name, bestScore: f.bestScore } : null;
        }).filter(Boolean);
        res.end(JSON.stringify({ ok: true, friends }));
        return;
    }

    // POST /api/friend/requests
    if (pathname === '/api/friend/requests' && req.method === 'POST') {
        const incoming = db.requests.filter(r => r.to === currentUser.id && r.status === 'pending').map(r => ({
            ...r,
            fromName: db.users[r.from] ? db.users[r.from].name : 'Unknown'
        }));
        const outgoing = db.requests.filter(r => r.from === currentUser.id && r.status === 'pending').map(r => ({
            ...r,
            toName: db.users[r.to] ? db.users[r.to].name : 'Unknown'
        }));
        res.end(JSON.stringify({ ok: true, incoming, outgoing }));
        return;
    }

    // POST /api/admin — admin actions
    if (pathname === '/api/admin' && req.method === 'POST') {
        const { password, action, amount } = body;
        if (password !== 'br123') {
            res.end(JSON.stringify({ ok: false, error: 'Неверный пароль' }));
            return;
        }
        const u = db.users[currentUser.id];
        if (action === 'addApples') { u.totalApples += (Number(amount) || 0); }
        if (action === 'addCoins') { u.coins += (Number(amount) || 0); }
        saveDB();
        res.end(JSON.stringify({ ok: true, user: u }));
        return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}

// ========== HTML ==========
const HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,user-scalable=no">
<title>🐍 Змейка</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
body{background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;min-height:100vh;overflow-x:hidden;touch-action:manipulation}
.container{max-width:500px;margin:0 auto;padding:10px}
.header{display:flex;justify-content:space-between;align-items:center;padding:10px 15px;background:rgba(255,255,255,.1);border-radius:15px;margin-bottom:10px;flex-wrap:wrap;gap:5px}
.header-item{font-size:13px;display:flex;align-items:center;gap:4px}
.header-item span{font-weight:700;color:#ffd700}
canvas{display:block;margin:0 auto;border-radius:15px;border:3px solid rgba(255,255,255,.2);background:#1a1a2e;touch-action:none}
.btn{padding:12px 24px;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;transition:all .3s;color:#fff;display:inline-flex;align-items:center;gap:6px}
.btn:hover{transform:translateY(-2px);box-shadow:0 5px 20px rgba(0,0,0,.3)}
.btn:active{transform:translateY(0)}
.btn-play{background:linear-gradient(135deg,#00b09b,#96c93d);width:100%;justify-content:center;font-size:20px;padding:16px;margin:10px 0}
.btn-shop{background:linear-gradient(135deg,#667eea,#764ba2);flex:1}
.btn-inv{background:linear-gradient(135deg,#f093fb,#f5576c);flex:1}
.btn-profile{background:linear-gradient(135deg,#4facfe,#00f2fe);flex:1}
.btn-friends{background:linear-gradient(135deg,#f7971e,#ffd200);flex:1;color:#333}
.btn-admin{background:linear-gradient(135deg,#333,#555);font-size:10px;padding:6px 10px}
.btn-row{display:flex;gap:6px;margin:8px 0;flex-wrap:wrap}
.game-over-screen{display:none;text-align:center;padding:30px 20px;background:rgba(255,255,255,.05);border-radius:20px;margin:10px 0}
.game-over-screen h2{font-size:28px;margin-bottom:10px;color:#ff6b6b}
.game-over-screen .stats{font-size:18px;margin:15px 0;line-height:2}
.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:100;justify-content:center;align-items:center;padding:20px}
.modal-overlay.active{display:flex}
.modal{background:linear-gradient(135deg,#1a1a2e,#16213e);border-radius:20px;padding:25px;max-width:450px;width:100%;max-height:85vh;overflow-y:auto;border:2px solid rgba(255,255,255,.1)}
.modal h2{text-align:center;margin-bottom:20px;font-size:22px}
.modal-close{background:#ff4757;border:none;color:#fff;padding:10px 20px;border-radius:10px;cursor:pointer;width:100%;font-size:16px;margin-top:15px;font-weight:700}
.shop-item{background:rgba(255,255,255,.08);border-radius:12px;padding:15px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.shop-item-info{flex:1;min-width:150px}
.shop-item-info h3{font-size:16px;margin-bottom:4px}
.shop-item-info p{font-size:12px;color:#aaa}
.btn-buy{background:linear-gradient(135deg,#f093fb,#f5576c);border:none;color:#fff;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;white-space:nowrap}
.btn-buy:disabled{background:#555;cursor:not-allowed}
.btn-buy.owned{background:#2ed573}
.leaderboard{background:rgba(255,255,255,.05);border-radius:20px;padding:20px;margin:15px 0}
.leaderboard h2{text-align:center;margin-bottom:15px;font-size:22px}
.lb-entry{display:flex;justify-content:space-between;align-items:center;padding:10px 15px;background:rgba(255,255,255,.05);border-radius:10px;margin-bottom:6px;font-size:15px}
.lb-entry:first-child{background:rgba(255,215,0,.15);border:1px solid rgba(255,215,0,.3)}
.lb-entry:nth-child(2){background:rgba(192,192,192,.1)}
.lb-entry:nth-child(3){background:rgba(205,127,50,.1)}
.lb-rank{font-weight:700;margin-right:10px;min-width:30px}
.lb-name{flex:1}
.lb-score{color:#ffd700;font-weight:700}
.profile-input,.admin-input,.friend-input{background:rgba(255,255,255,.1);border:2px solid rgba(255,255,255,.2);border-radius:10px;padding:12px 16px;color:#fff;font-size:16px;width:100%;margin:8px 0;outline:none}
.profile-input:focus,.admin-input:focus,.friend-input:focus{border-color:#4facfe}
.tab-row{display:flex;gap:5px;margin-bottom:15px}
.tab-btn{flex:1;padding:10px;border:none;border-radius:10px;background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font-size:13px;font-weight:700;transition:.3s}
.tab-btn.active{background:linear-gradient(135deg,#667eea,#764ba2)}
.score-display{text-align:center;padding:5px;font-size:16px;background:rgba(255,255,255,.05);border-radius:10px;margin:5px 0}
.inv-item{background:rgba(255,255,255,.08);border-radius:12px;padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
.btn-equip{background:linear-gradient(135deg,#00b09b,#96c93d);border:none;color:#fff;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700}
.btn-equip.equipped{background:linear-gradient(135deg,#ffd700,#ffaa00)}
.friend-item{background:rgba(255,255,255,.08);border-radius:12px;padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:5px}
.f-info{flex:1}.f-name{font-weight:700;font-size:15px}.f-id{font-size:11px;color:#aaa}
.friend-btn{border:none;color:#fff;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;margin-left:5px}
.friend-btn.accept{background:#2ed573}
.friend-btn.reject{background:#ff4757}
.friend-btn.remove{background:#ff6348}
.my-id-box{text-align:center;background:rgba(255,255,255,.1);border-radius:12px;padding:15px;margin-bottom:15px}
.my-id-box .id-val{font-size:28px;font-weight:700;color:#ffd700;letter-spacing:5px}
.my-id-box p{font-size:12px;color:#aaa;margin-top:5px}
.notif{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#2ed573;color:#fff;padding:12px 24px;border-radius:12px;font-weight:700;z-index:200;display:none;font-size:14px;box-shadow:0 5px 20px rgba(0,0,0,.3);text-align:center;max-width:90%}
.notif.error{background:#ff4757}
.loading{text-align:center;padding:20px;color:#aaa}
@media(max-width:520px){.container{padding:5px}.header{padding:8px 10px}.header-item{font-size:11px}}
</style>
</head>
<body>
<div id="notif" class="notif"></div>
<div class="container" id="app">
    <div class="header">
        <div class="header-item">🍎 <span id="totalApples">0</span></div>
        <div class="header-item">🪙 <span id="totalCoins">0</span></div>
        <div class="header-item">🏆 <span id="bestScore">0</span></div>
        <div class="header-item">👤 <span id="displayName">User</span></div>
        <div class="header-item">🆔 <span id="displayId">------</span></div>
    </div>
    <div class="score-display" id="scoreDisplay" style="display:none">🍎 <span id="currentScore">0</span> | 🪙 <span id="sessionCoins">0</span></div>
    <canvas id="gameCanvas"></canvas>
    <div class="game-over-screen" id="gameOverScreen">
        <h2>💀 Игра Окончена!</h2>
        <div class="stats">🍎 Собрано: <span id="goApples">0</span><br>🪙 Монет: <span id="goCoins">0</span><br>🏆 Рекорд: <span id="goBest">0</span></div>
        <button class="btn btn-play" onclick="startGame()">🔄 Играть Снова</button>
    </div>
    <button class="btn btn-play" id="playBtn" onclick="startGame()">🎮 Играть</button>
    <div class="btn-row">
        <button class="btn btn-shop" onclick="openShop()">🛒 Магазин</button>
        <button class="btn btn-inv" onclick="openInventory()">🎒 Инвентарь</button>
    </div>
    <div class="btn-row">
        <button class="btn btn-profile" onclick="openProfile()">👤 Профиль</button>
        <button class="btn btn-friends" onclick="openFriends()">👥 Друзья <span id="friendBadge"></span></button>
    </div>
    <div style="text-align:center;margin:5px 0"><button class="btn btn-admin" onclick="openAdmin()">⚙️</button></div>
    <div class="leaderboard">
        <h2>🏆 Доска Лидеров</h2>
        <div id="leaderboardList"></div>
    </div>
</div>

<!-- Modals -->
<div class="modal-overlay" id="shopModal"><div class="modal"><h2>🛒 Магазин</h2><div class="tab-row"><button class="tab-btn active" onclick="shopTab('skins',this)">🎨 Скины</button><button class="tab-btn" onclick="shopTab('upgrades',this)">⬆️ Улучшения</button></div><div id="shopContent"></div><button class="modal-close" onclick="closeModal('shopModal')">Закрыть</button></div></div>
<div class="modal-overlay" id="invModal"><div class="modal"><h2>🎒 Инвентарь</h2><div id="invContent"></div><button class="modal-close" onclick="closeModal('invModal')">Закрыть</button></div></div>
<div class="modal-overlay" id="profileModal"><div class="modal"><h2>👤 Профиль</h2><div class="my-id-box"><div class="id-val" id="profileId">------</div><p>Ваш ID — дайте друзьям</p></div><label style="font-size:14px;color:#aaa">Имя:</label><input type="text" class="profile-input" id="profileNameInput" maxlength="15" placeholder="Имя..."><button class="btn btn-play" onclick="saveName()" style="margin-top:10px">💾 Сохранить</button><button class="modal-close" onclick="closeModal('profileModal')">Закрыть</button></div></div>
<div class="modal-overlay" id="friendsModal"><div class="modal"><h2>👥 Друзья</h2><div class="my-id-box"><div class="id-val" id="friendsMyId">------</div><p>Ваш ID</p></div><div class="tab-row"><button class="tab-btn active" onclick="friendsTab('list',this)">📋 Список</button><button class="tab-btn" onclick="friendsTab('add',this)">➕ Добавить</button><button class="tab-btn" onclick="friendsTab('requests',this)">📩 Заявки <span id="reqCount"></span></button></div><div
id="friendsContent"></div><button class="modal-close" onclick="closeModal('friendsModal')">Закрыть</button></div></div>
<div class="modal-overlay" id="adminModal"><div class="modal"><h2>⚙️ Панель</h2><div id="adminContent"><label style="font-size:14px;color:#aaa">Пароль:</label><input type="password" class="admin-input" id="adminPass" placeholder="Пароль..."><button class="btn btn-play" onclick="adminLogin()" style="margin-top:10px;font-size:16px">🔓 Войти</button></div><div id="adminPanel" style="display:none"><label style="font-size:14px;color:#aaa">🍎 Яблоки:</label><input type="number" class="admin-input" id="adminApples" placeholder="Кол-во" min="0"><button class="btn btn-play" onclick="adminGive('addApples','adminApples')" style="font-size:14px;padding:10px">Выдать</button><label style="font-size:14px;color:#aaa;margin-top:10px;display:block">🪙 Монеты:</label><input type="number" class="admin-input" id="adminCoins" placeholder="Кол-во" min="0"><button class="btn btn-play" onclick="adminGive('addCoins','adminCoins')" style="font-size:14px;padding:10px">Выдать</button></div><button class="modal-close" onclick="closeModal('adminModal');document.getElementById('adminPanel').style.display='none';document.getElementById('adminContent').style.display='block'">Закрыть</button></div></div>

<script>
// ========== CONFIG ==========
const API = '';
const STORAGE_KEY = 'Loren';

const DEFAULT_LOCAL = {
    token: '',
    myId: '',
    name: 'User',
    coins: 0,
    totalApples: 0,
    bestScore: 0,
    ownedSkins: ['default'],
    equippedSkin: 'default',
    upgrades: { coinX2:false, coinX3:false, appleX2:false, appleX3:false },
    leaderboard: [
        { name:'Bros', score:150 },
        { name:'Chuck', score:125 },
        { name:'MrBeast', score:110 },
        { name:'Ded', score:100 },
        { name:'Coin', score:90 }
    ]
};

const SKINS = {
    default:{name:'Стандартная',head:'🟢',body:['🟩'],price:0,currency:'free',desc:'Обычная змейка'},
    bunny:{name:'Зайчик',head:'🐰',body:['⚪'],price:5,currency:'coins',desc:'Голова: 🐰 Тело: ⚪'},
    panda:{name:'Панда',head:'🐼',body:['⚫','⚪','⚫','⚪'],price:10,currency:'coins',desc:'Голова: 🐼 Тело: ⚫⚪'},
    elephant:{name:'Клубничный Слон',head:'🐘',body:['🔴','⚫','🔴','⚫'],price:15,currency:'apples_per_game',desc:'Набрать 15 🍎 за игру'},
    dragon:{name:'Дракон',head:'🐲',body:['🟢','🟢','🟢'],price:50,currency:'coins',desc:'Голова: 🐲 Тело: 🟢'},
    ghost:{name:'Призрак',head:'👻',body:['🔘','🔘','🔘'],price:85,currency:'coins',desc:'Голова: 👻 Тело: 🔘'},
    demon:{name:'Демон',head:'😈',body:['🟣','🟣','🟣'],price:130,currency:'coins',desc:'Голова: 😈 Тело: 🟣 + эффекты'}
};

// ========== LOCAL DATA ==========
function loadLocal() {
    try {
        const r = localStorage.getItem(STORAGE_KEY);
        if (r) { const d = JSON.parse(r); for (let k in DEFAULT_LOCAL) if(d[k]===undefined) d[k]=DEFAULT_LOCAL[k]; if(!d.upgrades) d.upgrades={...DEFAULT_LOCAL.upgrades}; return d; }
    } catch(e) {}
    return JSON.parse(JSON.stringify(DEFAULT_LOCAL));
}
function saveLocal() { localStorage.setItem(STORAGE_KEY, JSON.stringify(GD)); }
let GD = loadLocal();

// ========== API HELPER ==========
async function api(path, data={}) {
    data.token = GD.token;
    try {
        const r = await fetch(API + path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
        return await r.json();
    } catch(e) { return { ok:false, error:'Ошибка сети' }; }
}

// ========== NOTIFICATIONS ==========
let notifT;
function showNotif(msg, err) {
    const el = document.getElementById('notif');
    el.textContent = msg; el.className = 'notif' + (err?' error':''); el.style.display = 'block';
    clearTimeout(notifT); notifT = setTimeout(()=>{ el.style.display='none' }, 2500);
}
// ========== INIT ==========
async function init() {
    const res = await api('/api/register', { name: GD.name });
    if (res.ok) {
        GD.token = res.token || GD.token;
        GD.myId = res.userId;
        if (res.user) {
            // Sync server data
            GD.coins = Math.max(GD.coins, res.user.coins || 0);
            GD.totalApples = Math.max(GD.totalApples, res.user.totalApples || 0);
            GD.bestScore = Math.max(GD.bestScore, res.user.bestScore || 0);
            GD.name = res.user.name || GD.name;
        }
        saveLocal();
        // Sync to server
        await api('/api/update', { name:GD.name, bestScore:GD.bestScore, coins:GD.coins, totalApples:GD.totalApples });
    }
    updateUI();
    connectSSE();
    pollRequests();
}

// ========== SSE ==========
let eventSource;
function connectSSE() {
    if (!GD.token) return;
    try {
        eventSource = new EventSource(API + '/api/sse?token=' + GD.token);
        eventSource.onmessage = function(e) {
            try {
                const data = JSON.parse(e.data);
                if (data.type === 'friend_request') {
                    showNotif('📩 Заявка от ' + (data.fromName||'игрока') + '!');
                    pollRequests();
                } else if (data.type === 'friend_accepted') {
                    showNotif('✅ ' + (data.byName||'Игрок') + ' принял заявку!');
                } else if (data.type === 'friend_removed') {
                    showNotif('Друг удалён');
                }
            } catch(e) {}
        };
        eventSource.onerror = function() {
            setTimeout(connectSSE, 5000);
        };
    } catch(e) {}
}

async function pollRequests() {
    const res = await api('/api/friend/requests');
    if (res.ok) {
        const count = (res.incoming||[]).length;
        document.getElementById('reqCount').textContent = count > 0 ? '('+count+')' : '';
        document.getElementById('friendBadge').textContent = count > 0 ? '('+count+')' : '';
    }
}
setInterval(pollRequests, 10000);

// ========== CANVAS ==========
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const GRID = 20;
let COLS, ROWS;
function resizeCanvas() {
    const mW = Math.min(window.innerWidth-10,500), mH = Math.min(window.innerHeight*.5,500);
    COLS = Math.floor(mW/GRID); ROWS = Math.floor(mH/GRID);
    canvas.width = COLS*GRID; canvas.height = ROWS*GRID;
}
resizeCanvas();

// ========== GAME ==========
let snake=[],dir={x:1,y:0},nextDir={x:1,y:0};
let apple=null,coin=null,gameRunning=false,gameLoop=null;
let score=0,sessionCoins=0,sessionApples=0;
let coinTimer=null,lastTime=0,moveTimer=0;
const SPEED=120;
let prevSnake=[],interpFactor=0,demonParticles=[];

function updateUI() {
    document.getElementById('totalApples').textContent = GD.totalApples;
    document.getElementById('totalCoins').textContent = GD.coins;
    document.getElementById('bestScore').textContent = GD.bestScore;
    document.getElementById('displayName').textContent = GD.name;
    document.getElementById('displayId').textContent = GD.myId || '------';
    renderLeaderboard();
}

function startGame() {
    resizeCanvas();
    const sx=Math.floor(COLS/2),sy=Math.floor(ROWS/2);
    snake=[{x:sx,y:sy},{x:sx-1,y:sy},{x:sx-2,y:sy}];
    prevSnake=snake.map(s=>({...s}));
    dir={x:1,y:0};nextDir={x:1,y:0};
    score=0;sessionCoins=0;sessionApples=0;
    apple=null;coin=null;demonParticles=[];
    spawnApple();gameRunning=true;
    document.getElementById('gameOverScreen').style.display='none';
    document.getElementById('playBtn').style.display='none';
    document.getElementById('scoreDisplay').style.display='block';
    document.getElementById('currentScore').textContent='0';
    document.getElementById('sessionCoins').textContent='0';
clearTimeout(coinTimer);scheduleCoin();
    try{if(screen.orientation&&screen.orientation.lock)screen.orientation.lock('portrait').catch(()=>{})}catch(e){}
    if(gameLoop)cancelAnimationFrame(gameLoop);
    lastTime=performance.now();moveTimer=0;
    gameLoop=requestAnimationFrame(tick);
}

function scheduleCoin(){coinTimer=setTimeout(()=>{if(gameRunning){spawnCoin();scheduleCoin()}},(5+Math.random()*5)*1e3)}
function spawnApple(){let p;do{p={x:Math.floor(Math.random()*COLS),y:Math.floor(Math.random()*ROWS)}}while(snake.some(s=>s.x===p.x&&s.y===p.y)||(coin&&coin.x===p.x&&coin.y===p.y));apple=p}
function spawnCoin(){let p;do{p={x:Math.floor(Math.random()*COLS),y:Math.floor(Math.random()*ROWS)}}while(snake.some(s=>s.x===p.x&&s.y===p.y)||(apple&&apple.x===p.x&&apple.y===p.y));coin=p}

function tick(now){if(!gameRunning)return;const d=now-lastTime;lastTime=now;moveTimer+=d;interpFactor=Math.min(moveTimer/SPEED,1);if(moveTimer>=SPEED){moveTimer-=SPEED;if(moveTimer>SPEED)moveTimer=0;update();interpFactor=0}draw();gameLoop=requestAnimationFrame(tick)}

function update(){
    dir={...nextDir};prevSnake=snake.map(s=>({...s}));
    const head={x:snake[0].x+dir.x,y:snake[0].y+dir.y};
    if(head.x<0head.x>=COLShead.y<0||head.y>=ROWS){endGame();return}
    if(snake.some(s=>s.x===head.x&&s.y===head.y)){endGame();return}
    snake.unshift(head);
    if(GD.equippedSkin==='demon'){demonParticles.push({x:head.x*GRID+GRID/2+(Math.random()-.5)*10,y:head.y*GRID+GRID/2+(Math.random()-.5)*10,life:30,maxLife:30,vx:(Math.random()-.5)*2,vy:-Math.random()*2-1,size:3+Math.random()*4})}
    if(apple&&head.x===apple.x&&head.y===apple.y){
        let g=1;if(GD.upgrades.appleX3)g=3;else if(GD.upgrades.appleX2)g=2;
        score+=g;sessionApples+=g;document.getElementById('currentScore').textContent=score;spawnApple();
        if(sessionApples>=15&&!GD.ownedSkins.includes('elephant')){GD.ownedSkins.push('elephant');saveLocal();showNotif('🐘 Скин разблокирован!')}
    }else{snake.pop()}
    if(coin&&head.x===coin.x&&head.y===coin.y){let g=1;if(GD.upgrades.coinX3)g=3;else if(GD.upgrades.coinX2)g=2;sessionCoins+=g;document.getElementById('sessionCoins').textContent=sessionCoins;coin=null}
    prevSnake=snake.map(s=>({...s}));
}

async function endGame(){
    gameRunning=false;clearTimeout(coinTimer);cancelAnimationFrame(gameLoop);
    GD.totalApples+=sessionApples;GD.coins+=sessionCoins;
    if(score>GD.bestScore)GD.bestScore=score;
    updateLeaderboard(score);saveLocal();updateUI();
    // Sync to server
    await api('/api/update',{name:GD.name,bestScore:GD.bestScore,coins:GD.coins,totalApples:GD.totalApples});
    document.getElementById('goApples').textContent=sessionApples;
    document.getElementById('goCoins').textContent=sessionCoins;
    document.getElementById('goBest').textContent=GD.bestScore;
    document.getElementById('gameOverScreen').style.display='block';
    document.getElementById('scoreDisplay').style.display='none';
    document.getElementById('playBtn').style.display='block';
}

function updateLeaderboard(ns){
    const lb=GD.leaderboard;
    const ex=lb.findIndex(e=>e.name===GD.name);
    if(ex!==-1){if(ns>lb[ex].score)lb[ex].score=ns}
    else if(lb.length<5||ns>lb[lb.length-1].score)lb.push({name:GD.name,score:ns});
    lb.sort((a,b)=>b.score-a.score);if(lb.length>5)lb.length=5;
}

function lerp(a,b,t){return a+(b-a)*t}

function draw(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle='rgba(255,255,255,.03)';ctx.lineWidth=1;
    for(let x=0;x<=COLS;x++){ctx.beginPath();ctx.moveTo(x*GRID,0);ctx.lineTo(x*GRID,canvas.height);ctx.stroke()}
    for(let y=0;y<=ROWS;y++){ctx.beginPath();ctx.moveTo(0,y*GRID);ctx.lineTo(canvas.width,y*GRID);ctx.stroke()}
    const skin=SKINS[GD.equippedSkin]||SKINS.default;
    ctx.font=(GRID-2)+'px serif';ctx.textAlign='center';ctx.textBaseline='middle';
const isDemon=GD.equippedSkin==='demon',isGhost=GD.equippedSkin==='ghost';
    if(isDemon){
        for(let i=demonParticles.length-1;i>=0;i--){const p=demonParticles[i];p.x+=p.vx;p.y+=p.vy;p.life--;if(p.life<=0){demonParticles.splice(i,1);continue}const a=p.life/p.maxLife;ctx.beginPath();ctx.arc(p.x,p.y,p.size*a,0,Math.PI*2);ctx.fillStyle='rgba(155,89,182,'+a*.6+')';ctx.fill()}
        if(snake.length>0){const hx=snake[0].x*GRID+GRID/2,hy=snake[0].y*GRID+GRID/2;const g=ctx.createRadialGradient(hx,hy,2,hx,hy,GRID*1.5);g.addColorStop(0,'rgba(155,89,182,0.4)');g.addColorStop(1,'rgba(155,89,182,0)');ctx.fillStyle=g;ctx.fillRect(hx-GRID*2,hy-GRID*2,GRID*4,GRID*4)}
    }
    for(let i=snake.length-1;i>=0;i--){
        let x,y;if(i<prevSnake.length){x=lerp(prevSnake[i].x,snake[i].x,interpFactor);y=lerp(prevSnake[i].y,snake[i].y,interpFactor)}else{x=snake[i].x;y=snake[i].y}
        const px=x*GRID+GRID/2,py=y*GRID+GRID/2;
        if(isGhost){ctx.globalAlpha=1-(i/snake.length)*.6}
        ctx.fillText(i===0?skin.head:skin.body[(i-1)%skin.body.length],px,py);
        if(isGhost)ctx.globalAlpha=1;
    }
    if(apple){const ax=apple.x*GRID+GRID/2,ay=apple.y*GRID+GRID/2,p=1+Math.sin(performance.now()/200)*.1;ctx.save();ctx.translate(ax,ay);ctx.scale(p,p);ctx.fillText('🍎',0,0);ctx.restore()}
    if(coin){const cx=coin.x*GRID+GRID/2,cy=coin.y*GRID+GRID/2,p=1+Math.sin(performance.now()/150)*.15;ctx.save();ctx.translate(cx,cy);ctx.scale(p,p);ctx.fillText('🪙',0,0);ctx.restore()}
}

// ========== CONTROLS ==========
document.addEventListener('keydown',e=>{
    switch(e.key){case'ArrowUp':case'w':case'W':if(dir.y!==1)nextDir={x:0,y:-1};e.preventDefault();break;case'ArrowDown':case's':case'S':if(dir.y!==-1)nextDir={x:0,y:1};e.preventDefault();break;case'ArrowLeft':case'a':case'A':if(dir.x!==1)nextDir={x:-1,y:0};e.preventDefault();break;case'ArrowRight':case'd':case'D':if(dir.x!==-1)nextDir={x:1,y:0};e.preventDefault();break}
});
let tX=0,tY=0,tch=false;
canvas.addEventListener('touchstart',e=>{e.preventDefault();tch=true;tX=e.touches[0].clientX;tY=e.touches[0].clientY},{passive:false});
canvas.addEventListener('touchmove',e=>{e.preventDefault()},{passive:false});
canvas.addEventListener('touchend',e=>{e.preventDefault();if(!tch)return;tch=false;const dx=e.changedTouches[0].clientX-tX,dy=e.changedTouches[0].clientY-tY;if(Math.max(Math.abs(dx),Math.abs(dy))<10)return;if(Math.abs(dx)>Math.abs(dy)){if(dx>0&&dir.x!==-1)nextDir={x:1,y:0};else if(dx<0&&dir.x!==1)nextDir={x:-1,y:0}}else{if(dy>0&&dir.y!==-1)nextDir={x:0,y:1};else if(dy<0&&dir.y!==1)nextDir={x:0,y:-1}}},{passive:false});
document.addEventListener('touchstart',e=>{if(!gameRunning)return;tX=e.touches[0].clientX;tY=e.touches[0].clientY;tch=true},{passive:true});
document.addEventListener('touchend',e=>{if(!gameRunning||!tch)return;tch=false;const dx=e.changedTouches[0].clientX-tX,dy=e.changedTouches[0].clientY-tY;if(Math.max(Math.abs(dx),Math.abs(dy))<20)return;if(Math.abs(dx)>Math.abs(dy)){if(dx>0&&dir.x!==-1)nextDir={x:1,y:0};else if(dx<0&&dir.x!==1)nextDir={x:-1,y:0}}else{if(dy>0&&dir.y!==-1)nextDir={x:0,y:1};else if(dy<0&&dir.y!==1)nextDir={x:0,y:-1}}},{passive:true});
document.body.addEventListener('touchmove',e=>{if(gameRunning)e.preventDefault()},{passive:false});

// ========== SHOP ==========
let shopTabCur='skins';
function openShop(){document.getElementById('shopModal').classList.add('active');shopTab('skins',document.querySelector('#shopModal .tab-btn'))}
function shopTab(t,btn){shopTabCur=t;document.querySelectorAll('#shopModal .tab-btn').forEach(b=>b.classList.remove('active'));if(btn)btn.classList.add('active');renderShop()}
function renderShop(){
    const c=document.getElementById('shopContent');
    if(shopTabCur==='skins'){
        let h='';for(const[id,s]of Object.entries(SKINS)){if(id==='default')continue;const owned=GD.ownedSkins.includes(id);let pt='',cb=false;if(s.currency==='coins'){pt=s.price+' 🪙';cb=GD.coins>=s.price}else if(s.currency==='apples_per_game'){pt=s.price+' 🍎 за игру'}
h+='<div class="shop-item"><div class="shop-item-info"><h3>'+s.head+' '+s.name+'</h3><p>'+s.desc+'</p></div>'+(owned?'<button class="btn-buy owned" disabled>✅</button>':(s.currency==='apples_per_game'?'<button class="btn-buy" disabled>'+pt+'</button>':'<button class="btn-buy" '+(cb?'':'disabled')+' onclick="buySkin(\''+id+'\')">'+pt+'</button>'))+'</div>'}c.innerHTML=h;
    }else{
        const ups=[{id:'coinX2',name:'×2 Монеты',price:25},{id:'appleX2',name:'×2 Яблоки',price:15},{id:'coinX3',name:'×3 Монеты',price:75},{id:'appleX3',name:'×3 Яблоки',price:30}];
        let h='';for(const u of ups){const o=GD.upgrades[u.id],cb=GD.coins>=u.price;h+='<div class="shop-item"><div class="shop-item-info"><h3>'+u.name+'</h3></div>'+(o?'<button class="btn-buy owned" disabled>✅</button>':'<button class="btn-buy" '+(cb?'':'disabled')+' onclick="buyUpgrade(\''+u.id+'\','+u.price+')">'+u.price+' 🪙</button>')+'</div>'}c.innerHTML=h;
    }
}
async function buySkin(id){const s=SKINS[id];if(!s||GD.ownedSkins.includes(id))return;if(s.currency==='coins'&&GD.coins>=s.price){GD.coins-=s.price;GD.ownedSkins.push(id);saveLocal();updateUI();renderShop();showNotif(s.head+' Куплено!');await api('/api/update',{coins:GD.coins})}}
async function buyUpgrade(id,p){if(GD.upgrades[id]||GD.coins<p)return;GD.coins-=p;GD.upgrades[id]=true;if(id==='coinX3')GD.upgrades.coinX2=true;if(id==='appleX3')GD.upgrades.appleX2=true;saveLocal();updateUI();renderShop();showNotif('⬆️ Куплено!');await api('/api/update',{coins:GD.coins})}

// ========== INVENTORY ==========
function openInventory(){document.getElementById('invModal').classList.add('active');renderInventory()}
function renderInventory(){let h='';for(const id of GD.ownedSkins){const s=SKINS[id];if(!s)continue;const eq=GD.equippedSkin===id;h+='<div class="inv-item"><div><strong>'+s.head+' '+s.name+'</strong><br><span style="font-size:12px;color:#aaa">'+s.desc+'</span></div><button class="btn-equip '+(eq?'equipped':'')+'" onclick="equipSkin(\''+id+'\')">'+(eq?'⭐ Надето':'👕 Надеть')+'</button></div>'}document.getElementById('invContent').innerHTML=h}
function equipSkin(id){if(!GD.ownedSkins.includes(id))return;GD.equippedSkin=id;saveLocal();renderInventory()}

// ========== PROFILE ==========
function openProfile(){document.getElementById('profileModal').classList.add('active');document.getElementById('profileNameInput').value=GD.name;document.getElementById('profileId').textContent=GD.myId||'------'}
async function saveName(){const n=document.getElementById('profileNameInput').value.trim();if(n.length>0&&n.length<=15){GD.name=n;saveLocal();updateUI();closeModal('profileModal');showNotif('✅ Сохранено!');await api('/api/update',{name:n})}}

// ========== FRIENDS ==========
let friendsTabCur='list';
function openFriends(){document.getElementById('friendsModal').classList.add('active');document.getElementById('friendsMyId').textContent=GD.myId||'------';friendsTab('list',document.querySelector('#friendsModal .tab-btn'));pollRequests()}
function friendsTab(t,btn){friendsTabCur=t;document.querySelectorAll('#friendsModal .tab-btn').forEach(b=>b.classList.remove('active'));if(btn)btn.classList.add('active');renderFriends()}
async function renderFriends(){
    const c=document.getElementById('friendsContent');
    c.innerHTML='<div class="loading">Загрузка...</div>';
    if(friendsTabCur==='list'){
        const res=await api('/api/friend/list');
        if(!res.ok){c.innerHTML='<p style="text-align:center;color:#aaa">Ошибка загрузки</p>';return}
        if(!res.friends||res.friends.length===0){c.innerHTML='<p style="text-align:center;color:#aaa;padding:20px">Нет друзей. Добавьте по ID!</p>';return}
        let h='';for(const f of res.friends){h+='<div class="friend-item"><div class="f-info"><div class="f-name">'+f.name+'</div><div class="f-id">ID: '+f.id+' | 🏆 '+f.bestScore+'</div></div><button class="friend-btn remove" onclick="removeFriend(\''+f.id+'\')">❌</button></div>'}c.innerHTML=h;
}else if(friendsTabCur==='add'){
        c.innerHTML='<div style="text-align:center;padding:10px"><p style="color:#aaa;margin-bottom:10px">Введите 6-значный ID друга:</p><input type="text" class="friend-input" id="addFriendInput" maxlength="6" placeholder="000000" style="text-align:center;font-size:24px;letter-spacing:5px"><div id="findResult" style="margin:10px 0"></div><button class="btn btn-play" onclick="sendRequest()" style="margin-top:5px;font-size:16px">📩 Отправить заявку</button></div>';
        const inp=document.getElementById('addFriendInput');
        inp.addEventListener('input',async()=>{
            const v=inp.value.trim();const rd=document.getElementById('findResult');
            if(v.length===6&&/^\\d{6}$/.test(v)){const r=await api('/api/friend/find',{targetId:v});rd.innerHTML=r.ok?'<p style="color:#2ed573">✅ '+r.user.name+' (🏆 '+r.user.bestScore+')</p>':'<p style="color:#ff4757">❌ Не найден</p>'}else{rd.innerHTML=''}
        });
    }else if(friendsTabCur==='requests'){
        const res=await api('/api/friend/requests');
        if(!res.ok){c.innerHTML='<p style="color:#aaa;text-align:center">Ошибка</p>';return}
        let h='';
        if(res.incoming&&res.incoming.length>0){h+='<h3 style="font-size:14px;color:#aaa;margin-bottom:8px">📩 Входящие:</h3>';for(const r of res.incoming){h+='<div class="friend-item"><div class="f-info"><div class="f-name">'+r.fromName+'</div><div class="f-id">ID: '+r.from+'</div></div><div><button class="friend-btn accept" onclick="acceptReq(\''+r.id+'\')">✅</button><button class="friend-btn reject" onclick="rejectReq(\''+r.id+'\')">❌</button></div></div>'}}
        if(res.outgoing&&res.outgoing.length>0){h+='<h3 style="font-size:14px;color:#aaa;margin:12px 0 8px">📤 Отправленные:</h3>';for(const r of res.outgoing){h+='<div class="friend-item"><div class="f-info"><div class="f-name">'+r.toName+'</div><div class="f-id">ID: '+r.to+' — ожидает</div></div><button class="friend-btn reject" onclick="cancelReq(\''+r.id+'\')">🗑</button></div>'}}
        if(!h)h='<p style="text-align:center;color:#aaa;padding:20px">Нет заявок</p>';
        c.innerHTML=h;
    }
}
async function sendRequest(){
    const v=document.getElementById('addFriendInput').value.trim();
    if(v.length!==6||!/^\\d{6}$/.test(v)){showNotif('Введите корректный ID!',true);return}
    if(v===GD.myId){showNotif('Нельзя добавить себя!',true);return}
    const r=await api('/api/friend/request',{targetId:v});
    if(r.ok){showNotif('📩 Заявка отправлена!');document.getElementById('addFriendInput').value='';document.getElementById('findResult').innerHTML=''}
    else{showNotif(r.error||'Ошибка',true)}
}
async function acceptReq(id){const r=await api('/api/friend/accept',{requestId:id});if(r.ok){showNotif('✅ Принято!');renderFriends();pollRequests()}else showNotif(r.error||'Ошибка',true)}
async function rejectReq(id){const r=await api('/api/friend/reject',{requestId:id});if(r.ok){showNotif('❌ Отклонено');renderFriends();pollRequests()}else showNotif('Ошибка',true)}
async function cancelReq(id){const r=await api('/api/friend/cancel',{requestId:id});if(r.ok){showNotif('🗑 Отменено');renderFriends()}else showNotif('Ошибка',true)}
async function removeFriend(id){if(!confirm('Удалить из друзей?'))return;const r=await api('/api/friend/remove',{friendId:id});if(r.ok){showNotif('Удалён');renderFriends()}else showNotif('Ошибка',true)}

// ========== ADMIN ==========
function openAdmin(){document.getElementById('adminModal').classList.add('active');document.getElementById('adminPass').value='';document.getElementById('adminContent').style.display='block';document.getElementById('adminPanel').style.display='none'}
function adminLogin(){if(document.getElementById('adminPass').value==='br123'){document.getElementById('adminContent').style.display='none';document.getElementById('adminPanel').style.display='block'}else showNotif('Неверный пароль!',true)}
async function adminGive(action,inputId){const a=parseInt(document.getElementById(inputId).value)0;if(a>0){const r=await api('/api/admin',{password:'br123',action,amount:a});if(r.ok){if(r.user){GD.coins=r.user.coins;GD.totalApples=r.user.totalApples}saveLocal();updateUI();document.getElementById(inputId).value='';showNotif('Выдано!')}else showNotif(r.error'Ошибка',true)}}

// ========== MODALS ==========
function closeModal(id){document.getElementById(id).classList.remove('active')}
document.querySelectorAll('.modal-overlay').forEach(o=>{o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('active')})});

// ========== LEADERBOARD ==========
function renderLeaderboard(){
    const lb=GD.leaderboard,m=['🥇','🥈','🥉','4️⃣','5️⃣'];let h='';
    for(let i=0;i<lb.length;i++){h+='<div class="lb-entry"><span class="lb-rank">'+m[i]+'</span><span class="lb-name">'+lb[i].name+'</span><span class="lb-score">'+lb[i].score+' 🍎</span></div>'}
    document.getElementById('leaderboardList').innerHTML=h;
}

// ========== DRAW INIT ==========
function drawInit(){ctx.fillStyle='#1a1a2e';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.font='40px serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('🐍',canvas.width/2,canvas.height/2-20);ctx.font='16px Segoe UI';ctx.fillStyle='#aaa';ctx.fillText('Нажмите "Играть"',canvas.width/2,canvas.height/2+30)}
drawInit();
window.addEventListener('resize',()=>{if(!gameRunning){resizeCanvas();drawInit()}});

// ========== START ==========
init();
</script>
</body>
</html>;

// ========== HTTP SERVER ==========
const server = http.createServer((req, res) => {
    const url = new URL(req.url, http://localhost:${PORT}`);
    const pathname = url.pathname;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // SSE endpoint
    if (pathname === '/api/sse' && req.method === 'GET') {
        const token = url.searchParams.get('token');
        const userId = db.tokens[token];
        if (!userId) {
            res.writeHead(401);
            res.end('Unauthorized');
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        res.write('data: {"type":"connected"}\n\n');

        if (!sseClients[userId]) sseClients[userId] = [];
        sseClients[userId].push(res);

        // Keep alive
        const keepAlive = setInterval(() => {
            try { res.write(': keepalive\n\n'); } catch(e) { clearInterval(keepAlive); }
        }, 30000);

        req.on('close', () => {
            clearInterval(keepAlive);
            if (sseClients[userId]) {
                sseClients[userId] = sseClients[userId].filter(r => r !== res);
            }
        });
        return;
    }

    // API endpoints
    if (pathname.startsWith('/api/') && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            let parsed = {};
            try { parsed = JSON.parse(body); } catch(e) {}
            handleAPI(req, res, pathname, parsed);
        });
        return;
    }

    // Serve HTML
    if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML);
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  🐍 Змейка запущена!');
    console.log('');
    console.log('  Локально:     http://localhost:' + PORT);
    console.log('');
// Try to get local IP
    const os = require('os');
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log('  В сети:       http://' + net.address + ':' + PORT);
            }
        }
    }
    console.log('');
    console.log('  Другие устройства в той же WiFi сети');
    console.log('  могут подключиться по адресу выше!');
    console.log('');
    console.log('  База данных: ' + DB_FILE);
    console.log('');
});

process.on('SIGINT', () => {
    saveDB();
    console.log('\n  💾 База сохранена. Выход.');
    process.exit();
});
