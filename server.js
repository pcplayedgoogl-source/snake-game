const http=require('http'),fs=require('fs'),crypto=require('crypto');
const PORT=process.env.PORT||3000;
const db={users:{},requests:[],tokens:{}};
const DF='/tmp/snake_db.json';
function sDB(){try{fs.writeFileSync(DF,JSON.stringify(db))}catch(e){}}
function lDB(){try{if(fs.existsSync(DF))Object.assign(db,JSON.parse(fs.readFileSync(DF,'utf8')))}catch(e){}}
lDB();setInterval(sDB,30000);
function gId(){let i;do{i=String(Math.floor(100000+Math.random()*900000))}while(db.users[i]);return i}
function gTk(){return crypto.randomBytes(32).toString('hex')}
function gU(t){const u=db.tokens[t];if(u&&db.users[u])return{id:u,...db.users[u]};return null}
const sse={};
function sSSE(u,d){if(sse[u]){const m='data: '+JSON.stringify(d)+'\n\n';sse[u]=sse[u].filter(r=>{try{r.write(m);return true}catch(e){return false}})}}
function hAPI(req,res,path,body){
res.setHeader('Content-Type','application/json');
if(path==='/api/register'&&req.method==='POST'){
const{token:t,name}=body;
if(t){const u=gU(t);if(u){if(name&&name.trim())db.users[u.id].name=name.trim().substring(0,15);sDB();res.end(JSON.stringify({ok:1,userId:u.id,token:t,user:db.users[u.id]}));return}}
const uid=gId(),tok=gTk();
db.users[uid]={name:(name&&name.trim())?name.trim().substring(0,15):'User',bestScore:0,coins:0,totalApples:0,friends:[],token:tok};
db.tokens[tok]=uid;sDB();
res.end(JSON.stringify({ok:1,userId:uid,token:tok,user:db.users[uid]}));return}
const at=body.token||'';const cu=gU(at);
if(!cu){res.statusCode=401;res.end(JSON.stringify({ok:0,error:'Auth'}));return}
if(path==='/api/update'){
const u=db.users[cu.id];
if(body.name!==undefined)u.name=String(body.name).trim().substring(0,15);
if(body.bestScore!==undefined)u.bestScore=Math.max(u.bestScore,Number(body.bestScore)||0);
if(body.coins!==undefined)u.coins=Number(body.coins)||0;
if(body.totalApples!==undefined)u.totalApples=Number(body.totalApples)||0;
sDB();res.end(JSON.stringify({ok:1,user:u}));return}
if(path==='/api/friend/find'){
const t=db.users[body.targetId];
if(!t){res.end(JSON.stringify({ok:0,error:'Не найден'}));return}
res.end(JSON.stringify({ok:1,user:{id:body.targetId,name:t.name,bestScore:t.bestScore}}));return}
if(path==='/api/friend/request'){
const{targetId}=body;
if(targetId===cu.id){res.end(JSON.stringify({ok:0,error:'Нельзя добавить себя'}));return}
if(!db.users[targetId]){res.end(JSON.stringify({ok:0,error:'Не найден'}));return}
if(db.users[cu.id].friends&&db.users[cu.id].friends.includes(targetId)){res.end(JSON.stringify({ok:0,error:'Уже в друзьях'}));return}
const ex=db.requests.find(r=>((r.from===cu.id&&r.to===targetId)||(r.from===targetId&&r.to===cu.id))&&r.status==='pending');
if(ex){res.end(JSON.stringify({ok:0,error:'Заявка уже есть'}));return}
const rid='r_'+Date.now()+'_'+Math.random().toString(36).substr(2,6);
db.requests.push({id:rid,from:cu.id,to:targetId,status:'pending',time:Date.now()});
sDB();sSSE(targetId,{type:'friend_request',from:cu.id,fromName:db.users[cu.id].name});
res.end(JSON.stringify({ok:1}));return}
if(path==='/api/friend/accept'){
const r=db.requests.find(x=>x.id===body.requestId&&x.to===cu.id&&x.status==='pending');
if(!r){res.end(JSON.stringify({ok:0,error:'Не найдена'}));return}
r.status='accepted';
if(!db.users[cu.id].friends)db.users[cu.id].friends=[];
if(!db.users[r.from].friends)db.users[r.from].friends=[];
if(!db.users[cu.id].friends.includes(r.from))db.users[cu.id].friends.push(r.from);
if(!db.users[r.from].friends.includes(cu.id))db.users[r.from].friends.push(cu.id);
sDB();sSSE(r.from,{type:'friend_accepted',by:cu.id,byName:db.users[cu.id].name});
res.end(JSON.stringify({ok:1}));return}
if(path==='/api/friend/reject'){
db.requests=db.requests.filter(x=>!(x.id===body.requestId&&x.to===cu.id));
sDB();res.end(JSON.stringify({ok:1}));return}
if(path==='/api/friend/cancel'){
    db.requests=db.requests.filter(x=>!(x.id===body.requestId&&x.from===cu.id));
sDB();res.end(JSON.stringify({ok:1}));return}
if(path==='/api/friend/remove'){
const u=db.users[cu.id];
u.friends=(u.friends||[]).filter(f=>f!==body.friendId);
if(db.users[body.friendId])db.users[body.friendId].friends=(db.users[body.friendId].friends||[]).filter(f=>f!==cu.id);
sDB();sSSE(body.friendId,{type:'friend_removed',by:cu.id});
res.end(JSON.stringify({ok:1}));return}
if(path==='/api/friend/list'){
const u=db.users[cu.id];
const fr=(u.friends||[]).map(fid=>{const f=db.users[fid];return f?{id:fid,name:f.name,bestScore:f.bestScore}:null}).filter(Boolean);
res.end(JSON.stringify({ok:1,friends:fr}));return}
if(path==='/api/friend/requests'){
const inc=db.requests.filter(r=>r.to===cu.id&&r.status==='pending').map(r=>({...r,fromName:db.users[r.from]?db.users[r.from].name:'?'}));
const out=db.requests.filter(r=>r.from===cu.id&&r.status==='pending').map(r=>({...r,toName:db.users[r.to]?db.users[r.to].name:'?'}));
res.end(JSON.stringify({ok:1,incoming:inc,outgoing:out}));return}
if(path==='/api/admin'){
if(body.password!=='br123'){res.end(JSON.stringify({ok:0,error:'Пароль'}));return}
const u=db.users[cu.id];
if(body.action==='addApples')u.totalApples+=(Number(body.amount)||0);
if(body.action==='addCoins')u.coins+=(Number(body.amount)||0);
sDB();res.end(JSON.stringify({ok:1,user:u}));return}
res.statusCode=404;res.end(JSON.stringify({ok:0}))}

const HTML=`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,user-scalable=no">
<title>Snake</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
body{background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;font-family:'Segoe UI',Tahoma,sans-serif;min-height:100vh;overflow-x:hidden;touch-action:manipulation}
.c{max-width:500px;margin:0 auto;padding:10px}
.hd{display:flex;justify-content:space-between;align-items:center;padding:10px 15px;background:rgba(255,255,255,.1);border-radius:15px;margin-bottom:10px;flex-wrap:wrap;gap:5px}
.hi{font-size:13px;display:flex;align-items:center;gap:4px}
.hi span{font-weight:700;color:#ffd700}
canvas{display:block;margin:0 auto;border-radius:15px;border:3px solid rgba(255,255,255,.2);background:#1a1a2e;touch-action:none}
.b{padding:12px 24px;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;transition:all .3s;color:#fff;display:inline-flex;align-items:center;gap:6px;width:100%;justify-content:center}
.b:active{transform:scale(.97)}
.bp{background:linear-gradient(135deg,#00b09b,#96c93d);font-size:20px;padding:16px;margin:10px 0}
.bs{background:linear-gradient(135deg,#667eea,#764ba2);flex:1;width:auto}
.bi{background:linear-gradient(135deg,#f093fb,#f5576c);flex:1;width:auto}
.bpr{background:linear-gradient(135deg,#4facfe,#00f2fe);flex:1;width:auto}
.bf{background:linear-gradient(135deg,#f7971e,#ffd200);flex:1;width:auto;color:#333}
.bad{background:linear-gradient(135deg,#333,#555);font-size:10px;padding:6px 10px;width:auto}
.br{display:flex;gap:6px;margin:8px 0;flex-wrap:wrap}
.go{display:none;text-align:center;padding:30px 20px;background:rgba(255,255,255,.05);border-radius:20px;margin:10px 0}
.go h2{font-size:28px;margin-bottom:10px;color:#ff6b6b}
.go .gs{font-size:18px;margin:15px 0;line-height:2}
.mo{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:100;justify-content:center;align-items:center;padding:20px}
.mo.v{display:flex}
.md{background:linear-gradient(135deg,#1a1a2e,#16213e);border-radius:20px;padding:25px;max-width:450px;width:100%;max-height:85vh;overflow-y:auto;border:2px solid rgba(255,255,255,.1)}
.md h2{text-align:center;margin-bottom:20px;font-size:22px}
.mc{background:#ff4757;border:none;color:#fff;padding:10px 20px;border-radius:10px;cursor:pointer;width:100%;font-size:16px;margin-top:15px;font-weight:700}
.si{background:rgba(255,255,255,.08);border-radius:12px;padding:15px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.sn{flex:1;min-width:150px}.sn h3{font-size:16px;margin-bottom:4px}.sn p{font-size:12px;color:#aaa}
.bb{background:linear-gradient(135deg,#f093fb,#f5576c);border:none;color:#fff;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700}
.bb:disabled{background:#555;cursor:not-allowed}.bb.ow{background:#2ed573}
.lb{background:rgba(255,255,255,.05);border-radius:20px;padding:20px;margin:15px 0}
.lb h2{text-align:center;margin-bottom:15px;font-size:22px}
.le{display:flex;justify-content:space-between;align-items:center;padding:10px 15px;background:rgba(255,255,255,.05);border-radius:10px;margin-bottom:6px;font-size:15px}
.le:first-child{background:rgba(255,215,0,.15);border:1px solid rgba(255,215,0,.3)}
.le:nth-child(2){background:rgba(192,192,192,.1)}.le:nth-child(3){background:rgba(205,127,50,.1)}
.lr{font-weight:700;margin-right:10px;min-width:30px}.lm{flex:1}.lv{color:#ffd700;font-weight:700}
.inp{background:rgba(255,255,255,.1);border:2px solid rgba(255,255,255,.2);border-radius:10px;padding:12px 16px;color:#fff;font-size:16px;width:100%;margin:8px 0;outline:none}
.inp:focus{border-color:#4facfe}
.tr{display:flex;gap:5px;margin-bottom:15px}
.tb{flex:1;padding:10px;border:none;border-radius:10px;background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font-size:13px;font-weight:700}
.tb.v{background:linear-gradient(135deg,#667eea,#764ba2)}
.sd{text-align:center;padding:5px;font-size:16px;background:rgba(255,255,255,.05);border-radius:10px;margin:5px 0}
.ii,.fi{background:rgba(255,255,255,.08);border-radius:12px;padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:5px}
.be{background:linear-gradient(135deg,#00b09b,#96c93d);border:none;color:#fff;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700}
.be.eq{background:linear-gradient(135deg,#ffd700,#ffaa00)}
.fn{flex:1}.fm{font-weight:700;font-size:15px}.fd{font-size:11px;color:#aaa}
.fb{border:none;color:#fff;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;margin-left:5px}
.fba{background:#2ed573}.fbr{background:#ff4757}.fbd{background:#ff6348}
.ib{text-align:center;background:rgba(255,255,255,.1);border-radius:12px;padding:15px;margin-bottom:15px}
.ib .iv{font-size:28px;font-weight:700;color:#ffd700;letter-spacing:5px}
.ib p{font-size:12px;color:#aaa;margin-top:5px}
.nt{position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:12px 24px;border-radius:12px;font-weight:700;z-index:200;display:none;font-size:14px;text-align:center;max-width:90%;background:#2ed573;color:#fff;box-shadow:0 5px 20px rgba(0,0,0,.3)}
.nt.er{background:#ff4757}
@media(max-width:520px){.c{padding:5px}.hd{padding:8px 10px}.hi{font-size:11px}}
</style>
</head>
<body>
<div id="nt" class="nt"></div>
<div class="c">
<div class="hd"><div class="hi">🍎<span id="hA">0</span></div><div class="hi">🪙<span id="hC">0</span></div><div class="hi">🏆<span id="hB">0</span></div><div class="hi">👤<span id="hN">User</span></div><div class="hi">🆔<span id="hI">---</span></div></div>
<div class="sd" id="sB" style="display:none">🍎<span id="cS">0</span>|🪙<span id="cC">0</span></div>
<canvas id="cv"></canvas>
<div class="go" id="gO"><h2>💀 Конец!</h2><div class="gs">🍎<span id="gA">0</span><br>🪙<span id="gC">0</span><br>🏆<span id="gB">0</span></div><button class="b bp" onclick="SG()">🔄 Снова</button></div>
<button class="b bp" id="pB" onclick="SG()">🎮 Играть</button>
<div class="br"><button class="b bs" onclick="OSh()">🛒 Магазин</button><button class="b bi" onclick="OIn()">🎒 Инвентарь</button></div>
<div class="br"><button class="b bpr" onclick="OPr()">👤 Профиль</button><button class="b bf" onclick="OFr()">👥 Друзья<span id="fBd"></span></button></div>
<div style="text-align:center;margin:5px"><button class="b bad" onclick="OAd()">⚙️</button></div>
<div class="lb"><h2>🏆 Лидеры</h2><div id="lL"></div></div>
</div>
<div class="mo" id="sM"><div class="md"><h2>🛒 Магазин</h2><div class="tr"><button class="tb v" onclick="ST('s',this)">🎨Скины</button><button class="tb" onclick="ST('u',this)">⬆️Улучшения</button></div><div id="sC"></div><button class="mc" onclick="CM('sM')">Закрыть</button></div></div>
<div class="mo" id="iM"><div class="md"><h2>🎒 Инвентарь</h2><div id="iC"></div><button class="mc" onclick="CM('iM')">Закрыть</button></div></div>
<div class="mo" id="pM"><div class="md"><h2>👤 Профиль</h2><div class="ib"><div class="iv" id="pI">---</div><p>Ваш ID</p></div><label style="font-size:14px;color:#aaa">Имя:</label><input class="inp" id="pN" maxlength="15"><button class="b bp" onclick="SN()">💾Сохранить</button><button class="mc" onclick="CM('pM')">Закрыть</button></div></div>
<div class="mo" id="fM"><div class="md"><h2>👥 Друзья</h2><div class="ib"><div class="iv" id="fI">---</div><p>Ваш ID</p></div><div class="tr"><button class="tb v" onclick="FT('l',this)">📋Список</button><button class="tb" onclick="FT('a',this)">➕Добавить</button><button class="tb" onclick="FT('r',this)">📩Заявки<span id="rC"></span></button></div><div id="fC"></div><button class="mc" onclick="CM('fM')">Закрыть</button></div></div>
<div class="mo" id="aM"><div class="md"><h2>⚙️</h2><div id="aL"><label style="font-size:14px;color:#aaa">Пароль:</label><input type="password" class="inp" id="aP"><button class="b bp" onclick="AL()">🔓</button></div><div id="aPn" style="display:none"><label style="color:#aaa">🍎:</label><input type="number" class="inp" id="aAp" min="0"><button class="b bp" onclick="AG('addApples','aAp')" style="font-size:14px;padding:10px">Выдать</button><label style="color:#aaa;margin-top:10px;display:block">🪙:</label><input type="number" class="inp" id="aCo" min="0"><button class="b bp" onclick="AG('addCoins','aCo')" style="font-size:14px;padding:10px">Выдать</button></div><button class="mc" onclick="CM('aM');X('aPn').style.display='none';X('aL').style.display='block'">Закрыть</button></div></div>
<script>
function X(i){return document.getElementById(i)}
const S='Loren',DF={token:'',myId:'',name:'User',coins:0,totalApples:0,bestScore:0,ownedSkins:['default'],equippedSkin:'default',upgrades:{coinX2:0,coinX3:0,appleX2:0,appleX3:0},leaderboard:[{name:'Bros',score:150},{name:'Chuck',score:125},{name:'MrBeast',score:110},{name:'Ded',score:100},{name:'Coin',score:90}]};
const SK={default:{n:'Стандартная',h:'🟢',b:['🟩'],p:0,c:'f',d:'Обычная'},bunny:{n:'Зайчик',h:'🐰',b:['⚪'],p:5,c:'c',d:'🐰⚪'},panda:{n:'Панда',h:'🐼',b:['⚫','⚪','⚫','⚪'],p:10,c:'c',d:'🐼⚫⚪'},elephant:{n:'Слон',h:'🐘',b:['🔴','⚫','🔴','⚫'],p:15,c:'a',d:'15🍎 за игру'},dragon:{n:'Дракон',h:'🐲',b:['🟢','🟢','🟢'],p:50,c:'c',d:'🐲🟢'},ghost:{n:'Призрак',h:'👻',b:['🔘','🔘','🔘'],p:85,c:'c',d:'👻🔘+прозрачность'},demon:{n:'Демон',h:'😈',b:['🟣','🟣','🟣'],p:130,c:'c',d:'😈🟣+эффекты'}};
function LD(){try{const r=localStorage.getItem(S);if(r){const d=JSON.parse(r);for(let k in DF)if(d[k]===undefined)d[k]=DF[k];if(!d.upgrades)d.upgrades={...DF.upgrades};return d}}catch(e){}return JSON.parse(JSON.stringify(DF))}
function SV(){localStorage.setItem(S,JSON.stringify(G))}
let G=LD();
async function api(p,d={}){d.token=G.token;try{const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});return await r.json()}catch(e){return{ok:0,error:'Net'}}}
let nT;function NT(m,e){const el=X('nt');el.textContent=m;el.className='nt'+(e?' er':'');el.style.display='block';clearTimeout(nT);nT=setTimeout(()=>el.style.display='none',2500)}
const cv=X('cv'),cx=cv.getContext('2d'),GR=20;let CL,RW;
function RZ(){const w=Math.min(innerWidth-10,500),h=Math.min(innerHeight*.5,500);CL=Math.floor(w/GR);RW=Math.floor(h/GR);cv.width=CL*GR;cv.height=RW*GR}RZ();
let sn=[],dr={x:1,y:0},nd={x:1,y:0},ap=null,co=null,run=0,lp=null,sc=0,sco=0,sap=0,cTm=null,lt=0,mt=0,SP=120,ps=[],ip=0,dp=[];
function UI(){X('hA').textContent=G.totalApples;X('hC').textContent=G.coins;X('hB').textContent=G.bestScore;X('hN').textContent=G.name;X('hI').textContent=G.myId||'---';RL()}
async function INIT(){const r=await api('/api/register',{name:G.name});if(r.ok){G.token=r.tokenG.token;G.myId=r.userId;if(r.user){G.coins=Math.max(G.coins,r.user.coins0);G.totalApples=Math.max(G.totalApples,r.user.totalApples0);G.bestScore=Math.max(G.bestScore,r.user.bestScore0);G.name=r.user.name||G.name}SV();await api('/api/update',{name:G.name,bestScore:G.bestScore,coins:G.coins,totalApples:G.totalApples})}UI();CSSE();PR()}
let ev;function CSSE(){if(!G.token)return;try{ev=new EventSource('/api/sse?token='+G.token);ev.onmessage=function(e){try{const d=JSON.parse(e.data);if(d.type==='friend_request')NT('📩 Заявка от '+d.fromName);else if(d.type==='friend_accepted')NT('✅ '+d.byName+' принял!');PR()}catch(e){}};ev.onerror=()=>{if(ev)ev.close();setTimeout(CSSE,5000)}}catch(e){}}
async function PR(){const r=await api('/api/friend/requests');if(r.ok){const c=(r.incoming||[]).length;X('rC').textContent=c>0?'('+c+')':'';X('fBd').textContent=c>0?'('+c+')':''}}
setInterval(PR,15000);
function SG(){RZ();const x=Math.floor(CL/2),y=Math.floor(RW/2);sn=[{x,y},{x:x-1,y},{x:x-2,y}];ps=sn.map(s=>({...s}));dr={x:1,y:0};nd={x:1,y:0};sc=0;sco=0;sap=0;ap=null;co=null;dp=[];SA();run=1;X('gO').style.display='none';X('pB').style.display='none';X('sB').style.display='block';X('cS').textContent='0';X('cC').textContent='0';clearTimeout(cTm);SC();try{screen.orientation.lock('portrait').catch(()=>{})}catch(e){}if(lp)cancelAnimationFrame(lp);lt=performance.now();mt=0;lp=requestAnimationFrame(TK)}
function SC(){cTm=setTimeout(()=>{if(run){SPC();SC()}},(5+Math.random()*5)*1e3)}
function SA(){let p;do{p={x:Math.floor(Math.random()*CL),y:Math.floor(Math.random()*RW)}}while(sn.some(s=>s.x===p.x&&s.y===p.y)||(co&&co.x===p.x&&co.y===p.y));ap=p}
function SPC(){let p;do{p={x:Math.floor(Math.random()*CL),y:Math.floor(Math.random()*RW)}}while(sn.some(s=>s.x===p.x&&s.y===p.y)||(ap&&ap.x===p.x&&ap.y===p.y));co=p}
function TK(n){if(!run)return;const d=n-lt;lt=n;mt+=d;ip=Math.min(mt/SP,1);if(mt>=SP){mt-=SP;if(mt>SP)mt=0;UP();ip=0}DW();lp=requestAnimationFrame(TK)}
function UP(){dr={...nd};ps=sn.map(s=>({...s}));const h={x:sn[0].x+dr.x,y:sn[0].y+dr.y};if(h.x<0h.x>=CLh.y<0||h.y>=RW){ED();return}if(sn.some(s=>s.x===h.x&&s.y===h.y)){ED();return}sn.unshift(h);if(G.equippedSkin==='demon')dp.push({x:h.x*GR+GR/2+(Math.random()-.5)*10,y:h.y*GR+GR/2+(Math.random()-.5)*10,l:30,ml:30,vx:(Math.random()-.5)*2,vy:-Math.random()*2-1,sz:3+Math.random()*4});if(ap&&h.x===ap.x&&h.y===ap.y){let g=1;if(G.upgrades.appleX3)g=3;else if(G.upgrades.appleX2)g=2;sc+=g;sap+=g;X('cS').textContent=sc;SA();if(sap>=15&&!G.ownedSkins.includes('elephant')){G.ownedSkins.push('elephant');SV();NT('🐘 Разблокировано!')}}else sn.pop();if(co&&h.x===co.x&&h.y===co.y){let g=1;if(G.upgrades.coinX3)g=3;else if(G.upgrades.coinX2)g=2;sco+=g;X('cC').textContent=sco;co=null}ps=sn.map(s=>({...s}))}
async function ED(){run=0;clearTimeout(cTm);cancelAnimationFrame(lp);G.totalApples+=sap;G.coins+=sco;if(sc>G.bestScore)G.bestScore=sc;ULB(sc);SV();UI();await api('/api/update',{name:G.name,bestScore:G.bestScore,coins:G.coins,totalApples:G.totalApples});X('gA').textContent=sap;X('gC').textContent=sco;X('gB').textContent=G.bestScore;X('gO').style.display='block';X('sB').style.display='none';X('pB').style.display='block'}
function ULB(n){const l=G.leaderboard;const e=l.findIndex(x=>x.name===G.name);if(e!==-1){if(n>l[e].score)l[e].score=n}else if(l.length<5||n>l[l.length-1].score)l.push({name:G.name,score:n});l.sort((a,b)=>b.score-a.score);if(l.length>5)l.length=5}
function lp2(a,b,t){return a+(b-a)*t}
function DW(){cx.clearRect(0,0,cv.width,cv.height);cx.strokeStyle='rgba(255,255,255,.03)';cx.lineWidth=1;for(let x=0;x<=CL;x++){cx.beginPath();cx.moveTo(x*GR,0);cx.lineTo(x*GR,cv.height);cx.stroke()}for(let y=0;y<=RW;y++){cx.beginPath();cx.moveTo(0,y*GR);cx.lineTo(cv.width,y*GR);cx.stroke()}const sk=SK[G.equippedSkin]||SK.default;cx.font=(GR-2)+'px serif';cx.textAlign='center';cx.textBaseline='middle';const isD=G.equippedSkin==='demon',isGh=G.equippedSkin==='ghost';if(isD){for(let i=dp.length-1;i>=0;i--){const p=dp[i];p.x+=p.vx;p.y+=p.vy;p.l--;if(p.l<=0){dp.splice(i,1);continue}const a=p.l/p.ml;cx.beginPath();cx.arc(p.x,p.y,p.sz*a,0,Math.PI*2);cx.fillStyle='rgba(155,89,182,'+a*.6+')';cx.fill()}if(sn.length){const hx=sn[0].x*GR+GR/2,hy=sn[0].y*GR+GR/2;const g=cx.createRadialGradient(hx,hy,2,hx,hy,GR*1.5);g.addColorStop(0,'rgba(155,89,182,.4)');g.addColorStop(1,'rgba(155,89,182,0)');cx.fillStyle=g;cx.fillRect(hx-GR*2,hy-GR*2,GR*4,GR*4)}}for(let i=sn.length-1;i>=0;i--){let x,y;if(i<ps.length){x=lp2(ps[i].x,sn[i].x,ip);y=lp2(ps[i].y,sn[i].y,ip)}else{x=sn[i].x;y=sn[i].y}const px=x*GR+GR/2,py=y*GR+GR/2;if(isGh)cx.globalAlpha=1-(i/sn.length)*.6;cx.fillText(i===0?sk.h:sk.b[(i-1)%sk.b.length],px,py);if(isGh)cx.globalAlpha=1}if(ap){const ax=ap.x*GR+GR/2,ay=ap.y*GR+GR/2,p=1+Math.sin(performance.now()/200)*.1;cx.save();cx.translate(ax,ay);cx.scale(p,p);cx.fillText('🍎',0,0);cx.restore()}if(co){const x2=co.x*GR+GR/2,y2=co.y*GR+GR/2,p=1+Math.sin(performance.now()/150)*.15;cx.save();cx.translate(x2,y2);cx.scale(p,p);cx.fillText('🪙',0,0);cx.restore()}}
document.addEventListener('keydown',e=>{switch(e.key){case'ArrowUp':case'w':case'W':if(dr.y!==1)nd={x:0,y:-1};e.preventDefault();break;case'ArrowDown':case's':case'S':if(dr.y!==-1)nd={x:0,y:1};e.preventDefault();break;case'ArrowLeft':case'a':case'A':if(dr.x!==1)nd={x:-1,y:0};e.preventDefault();break;case'ArrowRight':case'd':case'D':if(dr.x!==-1)nd={x:1,y:0};e.preventDefault();break}});
let tX=0,tY=0,tc=0;
cv.addEventListener('touchstart',e=>{e.preventDefault();tc=1;tX=e.touches[0].clientX;tY=e.touches[0].clientY},{passive:false});
cv.addEventListener('touchmove',e=>e.preventDefault(),{passive:false});
cv.addEventListener('touchend',e=>{e.preventDefault();if(!tc)return;tc=0;const dx=e.changedTouches[0].clientX-tX,dy=e.changedTouches[0].clientY-tY;if(Math.max(Math.abs(dx),Math.abs(dy))<10)return;if(Math.abs(dx)>Math.abs(dy)){if(dx>0&&dr.x!==-1)nd={x:1,y:0};else if(dx<0&&dr.x!==1)nd={x:-1,y:0}}else{if(dy>0&&dr.y!==-1)nd={x:0,y:1};else if(dy<0&&dr.y!==1)nd={x:0,y:-1}}},{passive:false});
document.addEventListener('touchstart',e=>{if(!run)return;tX=e.touches[0].clientX;tY=e.touches[0].clientY;tc=1},{passive:true});
document.addEventListener('touchend',e=>{if(!run||!tc)return;tc=0;const dx=e.changedTouches[0].clientX-tX,dy=e.changedTouches[0].clientY-tY;if(Math.max(Math.abs(dx),Math.abs(dy))<20)return;if(Math.abs(dx)>Math.abs(dy)){if(dx>0&&dr.x!==-1)nd={x:1,y:0};else if(dx<0&&dr.x!==1)nd={x:-1,y:0}}else{if(dy>0&&dr.y!==-1)nd={x:0,y:1};else if(dy<0&&dr.y!==1)nd={x:0,y:-1}}},{passive:true});
document.body.addEventListener('touchmove',e=>{if(run)e.preventDefault()},{passive:false});
let stc='s';
function OSh(){X('sM').classList.add('v');ST('s',document.querySelector('#sM .tb'))}
function ST(t,b){stc=t;document.querySelectorAll('#sM .tb').forEach(x=>x.classList.remove('v'));if(b)b.classList.add('v');RS()}
function RS(){const c=X('sC');if(stc==='s'){let h='';for(const[id,s]of Object.entries(SK)){if(id==='default')continue;const o=G.ownedSkins.includes(id);let pt='',cb=0;if(s.c==='c'){pt=s.p+' 🪙';cb=G.coins>=s.p}else pt=s.p+'🍎/игру';h+='<div class="si"><div class="sn"><h3>'+s.h+' '+s.n+'</h3><p>'+s.d+'</p></div>'+(o?'<button class="bb ow" disabled>✅</button>':(s.c!=='c'?'<button class="bb"
disabled>'+pt+'</button>':'<button class="bb" '+(cb?'':'disabled')+' onclick="BS(\\''+id+'\\')">'+pt+'</button>'))+'</div>'}c.innerHTML=h}else{const u=[{id:'coinX2',n:'×2 Монеты',p:25},{id:'appleX2',n:'×2 Яблоки',p:15},{id:'coinX3',n:'×3 Монеты',p:75},{id:'appleX3',n:'×3 Яблоки',p:30}];let h='';for(const x of u){const o=G.upgrades[x.id],cb=G.coins>=x.p;h+='<div class="si"><div class="sn"><h3>'+x.n+'</h3></div>'+(o?'<button class="bb ow" disabled>✅</button>':'<button class="bb" '+(cb?'':'disabled')+' onclick="BU(\\''+x.id+'\\','+x.p+')">'+x.p+'🪙</button>')+'</div>'}c.innerHTML=h}}
async function BS(id){const s=SK[id];if(!s||G.ownedSkins.includes(id))return;if(s.c==='c'&&G.coins>=s.p){G.coins-=s.p;G.ownedSkins.push(id);SV();UI();RS();NT(s.h+' Куплено!');await api('/api/update',{coins:G.coins})}}
async function BU(id,p){if(G.upgrades[id]||G.coins<p)return;G.coins-=p;G.upgrades[id]=1;if(id==='coinX3')G.upgrades.coinX2=1;if(id==='appleX3')G.upgrades.appleX2=1;SV();UI();RS();NT('⬆️ Куплено!');await api('/api/update',{coins:G.coins})}
function OIn(){X('iM').classList.add('v');RI()}
function RI(){let h='';for(const id of G.ownedSkins){const s=SK[id];if(!s)continue;const e=G.equippedSkin===id;h+='<div class="ii"><div><b>'+s.h+' '+s.n+'</b><br><span style="font-size:12px;color:#aaa">'+s.d+'</span></div><button class="be '+(e?'eq':'')+'" onclick="ES(\\''+id+'\\')\">'+(e?'⭐':'👕')+'</button></div>'}X('iC').innerHTML=h}
function ES(id){if(!G.ownedSkins.includes(id))return;G.equippedSkin=id;SV();RI()}
function OPr(){X('pM').classList.add('v');X('pN').value=G.name;X('pI').textContent=G.myId||'---'}
async function SN(){const n=X('pN').value.trim();if(n.length>0&&n.length<=15){G.name=n;SV();UI();CM('pM');NT('✅ Сохранено!');await api('/api/update',{name:n})}}
let ftc='l';
function OFr(){X('fM').classList.add('v');X('fI').textContent=G.myId||'---';FT('l',document.querySelector('#fM .tb'));PR()}
function FT(t,b){ftc=t;document.querySelectorAll('#fM .tb').forEach(x=>x.classList.remove('v'));if(b)b.classList.add('v');RF()}
async function RF(){const c=X('fC');c.innerHTML='<p style="text-align:center;color:#aaa;padding:20px">Загрузка...</p>';if(ftc==='l'){const r=await api('/api/friend/list');if(!r.ok!r.friends!r.friends.length){c.innerHTML='<p style="text-align:center;color:#aaa;padding:20px">Нет друзей</p>';return}let h='';for(const f of r.friends)h+='<div class="fi"><div class="fn"><div class="fm">'+f.name+'</div><div class="fd">ID:'+f.id+'|🏆'+f.bestScore+'</div></div><button class="fb fbd" onclick="RMF(\\''+f.id+'\\')">❌</button></div>';c.innerHTML=h}else if(ftc==='a'){c.innerHTML='<div style="text-align:center;padding:10px"><p style="color:#aaa;margin-bottom:10px">6-значный ID:</p><input class="inp" id="aFI" maxlength="6" placeholder="000000" style="text-align:center;font-size:24px;letter-spacing:5px"><div id="fR" style="margin:10px 0"></div><button class="b bp" onclick="SFR()" style="font-size:16px">📩Отправить</button></div>';X('aFI').addEventListener('input',async()=>{const v=X('aFI').value.trim(),r2=X('fR');if(v.length===6&&/^[0-9]{6}$/.test(v)){const r=await api('/api/friend/find',{targetId:v});r2.innerHTML=r.ok?'<p style="color:#2ed573">✅'+r.user.name+'</p>':'<p style="color:#ff4757">❌Не найден</p>'}else r2.innerHTML=''})}else{const r=await api('/api/friend/requests');if(!r.ok){c.innerHTML='<p style="color:#aaa;text-align:center">Ошибка</p>';return}let h='';if(r.incoming&&r.incoming.length){h+='<h3 style="font-size:14px;color:#aaa;margin-bottom:8px">📩Входящие:</h3>';for(const x of r.incoming)h+='<div class="fi"><div class="fn"><div class="fm">'+x.fromName+'</div><div class="fd">ID:'+x.from+'</div></div><div><button class="fb fba" onclick="ACR(\\''+x.id+'\\')">✅</button><button class="fb fbr" onclick="RJR(\\''+x.id+'\\')">❌</button></div></div>'}if(r.outgoing&&r.outgoing.length){h+='<h3 style="font-size:14px;color:#aaa;margin:12px 0 8px">📤Отправленные:</h3>';for(const x of r.outgoing)h+='<div class="fi"><div class="fn"><div class="fm">'+x.toName+'</div><div class="fd">ID:'+x.to+'</div></div><button class="fb fbr"
onclick="CNR(\\''+x.id+'\\')">🗑</button></div>'}if(!h)h='<p style="text-align:center;color:#aaa;padding:20px">Нет заявок</p>';c.innerHTML=h}}
async function SFR(){const v=X('aFI').value.trim();if(v.length!==6){NT('ID!',1);return}if(v===G.myId){NT('Себя нельзя!',1);return}const r=await api('/api/friend/request',{targetId:v});if(r.ok){NT('📩Отправлено!');X('aFI').value='';X('fR').innerHTML=''}else NT(r.error||'Ошибка',1)}
async function ACR(id){const r=await api('/api/friend/accept',{requestId:id});if(r.ok){NT('✅Принято!');RF();PR()}else NT(r.error,1)}
async function RJR(id){await api('/api/friend/reject',{requestId:id});NT('❌');RF();PR()}
async function CNR(id){await api('/api/friend/cancel',{requestId:id});NT('🗑');RF()}
async function RMF(id){if(!confirm('Удалить?'))return;await api('/api/friend/remove',{friendId:id});NT('Удалён');RF()}
function OAd(){X('aM').classList.add('v');X('aP').value='';X('aL').style.display='block';X('aPn').style.display='none'}
function AL(){if(X('aP').value==='br123'){X('aL').style.display='none';X('aPn').style.display='block'}else NT('Пароль!',1)}
async function AG(act,inp){const a=parseInt(X(inp).value)0;if(a>0){const r=await api('/api/admin',{password:'br123',action:act,amount:a});if(r.ok&&r.user){G.coins=r.user.coins;G.totalApples=r.user.totalApples;SV();UI();X(inp).value='';NT('✅Выдано!')}else NT(r.error'Ошибка',1)}}
function CM(id){X(id).classList.remove('v')}
document.querySelectorAll('.mo').forEach(o=>o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('v')}));
function RL(){const l=G.leaderboard,m=['🥇','🥈','🥉','4️⃣','5️⃣'];let h='';for(let i=0;i<l.length;i++)h+='<div class="le"><span class="lr">'+m[i]+'</span><span class="lm">'+l[i].name+'</span><span class="lv">'+l[i].score+'🍎</span></div>';X('lL').innerHTML=h}
function DI(){cx.fillStyle='#1a1a2e';cx.fillRect(0,0,cv.width,cv.height);cx.font='40px serif';cx.textAlign='center';cx.textBaseline='middle';cx.fillText('🐍',cv.width/2,cv.height/2-20);cx.font='16px sans-serif';cx.fillStyle='#aaa';cx.fillText('Нажмите Играть',cv.width/2,cv.height/2+30)}
DI();window.addEventListener('resize',()=>{if(!run){RZ();DI()}});
INIT();
</script></body></html>`;

const server=http.createServer((req,res)=>{
const url=new URL(req.url,'http://localhost:'+PORT);const p=url.pathname;
res.setHeader('Access-Control-Allow-Origin','*');
res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
res.setHeader('Access-Control-Allow-Headers','Content-Type');
if(req.method==='OPTIONS'){res.writeHead(200);res.end();return}
if(p==='/api/sse'&&req.method==='GET'){const token=url.searchParams.get('token');const uid=db.tokens[token];if(!uid){res.writeHead(401);res.end();return}res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write('data:{"type":"connected"}\n\n');if(!sse[uid])sse[uid]=[];sse[uid].push(res);const ka=setInterval(()=>{try{res.write(':ka\n\n')}catch(e){clearInterval(ka)}},30000);req.on('close',()=>{clearInterval(ka);if(sse[uid])sse[uid]=sse[uid].filter(r=>r!==res)});return}
if(p.startsWith('/api/')&&req.method==='POST'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{let d={};try{d=JSON.parse(body)}catch(e){}hAPI(req,res,p,d)});return}
if(p==='/'||p==='/index.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(HTML);return}
res.writeHead(404);res.end('404')});
server.listen(PORT,'0.0.0.0',()=>console.log('Snake on port '+PORT));
process.on('SIGINT',()=>{sDB();process.exit()});
