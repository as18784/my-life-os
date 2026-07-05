/*═══════════════════════════════════════════════════════════════
  LIFE OS BACKEND — Telegram bot + PWA sync + scheduled coach
  One Apps Script project. One Google Sheet. Zero servers.

  SETUP (one time):
  1. Paste this whole file into a new Apps Script project (script.google.com)
  2. Deploy → New deployment → Web app → Execute as: Me,
     Access: Anyone → copy the /exec URL
  3. Paste that URL into WEB_APP_URL below and save
  4. Run the function `setup` once (authorize when asked)
  5. In Telegram, open your bot and send /start
  6. In the PWA: Settings → Sync URL → paste the same /exec URL
  (Optional) Project Settings → Script Properties → add
     ANTHROPIC_API_KEY = sk-ant-...   → unlocks AI coach replies in bot
═══════════════════════════════════════════════════════════════*/

const BOT_TOKEN   = '8625808882:AAGpfGfh4N2kh2whZXPOkO2mqNl9mPet1zY';
const SHEET_ID    = '1e-2o-eX6ABT4JTAuZ0BFiT9gOi-ysbzQcn-GJU4a7DU';
const WEB_APP_URL = 'PASTE_YOUR_EXEC_URL_HERE';   // step 3
const TZ          = 'Asia/Kolkata';
const SYNC_KEY    = 'CHANGE_ME_to_a_long_random_string';   // must match Sync Key in app Settings
const TG          = 'https://api.telegram.org/bot' + BOT_TOKEN;
const CATEGORIES  = ['Food','Transport','Personal','Work','Home','Fun','Other'];

/*──────────────── SHEET / STATE ────────────────*/
function ss(){ return SpreadsheetApp.openById(SHEET_ID); }
function sheet(name, headers){
  let sh = ss().getSheetByName(name);
  if(!sh){ sh = ss().insertSheet(name); if(headers) sh.appendRow(headers); }
  return sh;
}
function getState(){
  const sh = sheet('State');
  const raw = sh.getRange('A1').getValue();
  try { return raw ? JSON.parse(raw) : {}; } catch(e){ return {}; }
}
function setState(s){
  s.lastUpdated = Date.now();
  sheet('State').getRange('A1').setValue(JSON.stringify(s));
}
function props(){ return PropertiesService.getScriptProperties(); }
function today(){ return Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd'); }
function nowT(){ return Utilities.formatDate(new Date(),TZ,'HH:mm'); }
function hourNow(){ return Number(Utilities.formatDate(new Date(),TZ,'H')); }

/*──────────────── WEB APP: PWA sync + Telegram webhook ────────────────*/
function doGet(e){
  if(e && e.parameter && e.parameter.action === 'load'){
    if((e.parameter.k||'') !== SYNC_KEY) return json({ok:false, err:'auth'});
    return json({ok:true, data:getState()});
  }
  return json({ok:true, ping:'LifeOS backend alive'});
}

function doPost(e){
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch(err){ return json({ok:false}); }

  // Telegram update
  if(body.update_id !== undefined){ handleTelegram(body); return json({ok:true}); }

  // PWA sync save — merge money & log by id so bot entries never get overwritten
  if(body.action === 'save' && body.data){
    if((body.key||'') !== SYNC_KEY) return json({ok:false, err:'auth'});
    const server = getState();
    const incoming = body.data;
    incoming.money = mergeById(server.money, incoming.money);
    incoming.log   = mergeById(server.log,   incoming.log);
    setState(incoming);
    return json({ok:true});
  }
  return json({ok:false});
}

function mergeById(a,b){
  const map = {};
  (a||[]).forEach(x=>{ if(x&&x.id) map[x.id]=x; });
  (b||[]).forEach(x=>{ if(x&&x.id) map[x.id]=x; });
  return Object.values(map).sort((x,y)=>(x.ts||0)-(y.ts||0));
}
function json(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/*──────────────── TELEGRAM CORE ────────────────*/
function tg(method, payload){
  return UrlFetchApp.fetch(TG+'/'+method,{
    method:'post', contentType:'application/json',
    payload:JSON.stringify(payload), muteHttpExceptions:true
  });
}
function send(text, keyboard){
  const chatId = props().getProperty('CHAT_ID');
  if(!chatId) return;
  const p = {chat_id:chatId, text:text, parse_mode:'HTML'};
  if(keyboard) p.reply_markup = {inline_keyboard:keyboard};
  tg('sendMessage', p);
}
function appBtns(){
  const base = WEB_APP_URL.indexOf('http')===0 ? null : null; // PWA url set below
  const pwa = props().getProperty('PWA_URL') || 'https://as18784.github.io/my-life-os/';
  return [[{text:'📊 Life Dashboard', url:pwa+'?mode=life'},{text:'💰 Money', url:pwa+'?mode=money'}]];
}

/*──────────────── TELEGRAM HANDLER ────────────────*/
function handleTelegram(update){
  if(update.callback_query) return handleCallback(update.callback_query);
  const msg = update.message;
  if(!msg || !msg.text) return;
  const text = msg.text.trim();

  // Owner lock: first /start claims the bot; everyone else is ignored
  const owner = props().getProperty('CHAT_ID');
  if(!owner){ if(text==='/start') props().setProperty('CHAT_ID', String(msg.chat.id)); else return; }
  else if(String(msg.chat.id) !== owner) return;

  if(text === '/start'){
    send('🔥 <b>Life OS bot is live.</b>\n\nI will ping you:\n• 7 AM — priorities & habits\n• 1 PM & 6 PM — spend check\n• 7 PM onward — habit check-in (I nag until you answer, hard stop midnight)\n\nLog money anytime: just type <b>spent 400 lunch</b>\nLog a win: <b>done gym</b>\nAnything else — just talk to me.', appBtns());
    return;
  }
  if(text === '/status') return sendStatus();
  if(text === '/money')  return sendMoneySummary();
  // "balance 45000" — store current account balance
  const bal = text.match(/^balance\s+₹?(\d+(?:\.\d+)?)/i);
  if(bal){ const s=getState(); s.balance=Number(bal[1]); setState(s);
    send('✅ Balance noted.'+(isPrivate()?'':' ₹'+Number(bal[1]).toLocaleString())); return; }

  // Money: "spent 400 lunch" / "400 uber" / "paid 250 chai"
  const m = text.match(/^(?:spent|paid)?\s*₹?(\d+(?:\.\d+)?)\s*(.*)$/i);
  if(m && Number(m[1])>0){
    return logMoneyFlow(Number(m[1]), (m[2]||'').trim());
  }

  // Habit quick log: "done <habit>"
  const d = text.match(/^done\s+(.+)/i);
  if(d) return markHabitByName(d[1]);

  // Free text → AI coach (or template)
  coachReply(text);
}

function logMoneyFlow(amount, note){
  const cat = autoCategory(note);
  if(cat){
    saveMoney(amount, cat, note);
    send('✅ Logged <b>₹'+amount+'</b> · '+cat+(note?' · '+esc(note):'')+(isPrivate()?'':'\n'+monthLine()));
  } else {
    // Ask category with buttons; stash pending
    props().setProperty('PENDING_MONEY', JSON.stringify({amount:amount, note:note}));
    const rows=[]; for(let i=0;i<CATEGORIES.length;i+=3){
      rows.push(CATEGORIES.slice(i,i+3).map(c=>({text:c, callback_data:'cat:'+c})));
    }
    send('₹'+amount+(note?' — '+esc(note):'')+'\nTag it:', rows);
  }
}

function autoCategory(note){
  const n=(note||'').toLowerCase();
  const map={Food:['lunch','dinner','breakfast','food','swiggy','zomato','chai','coffee','snack','grocery','tea'],
    Transport:['uber','ola','rapido','auto','metro','petrol','fuel','bus','train','cab'],
    Work:['office','client','print','work'],
    Home:['rent','electricity','bill','wifi','gas','maid','milk'],
    Fun:['movie','game','netflix','party','drinks'],
    Personal:['gym','haircut','clothes','medicine','doctor']};
  for(const c in map) if(map[c].some(k=>n.indexOf(k)>=0)) return c;
  return null;
}

function saveMoney(amount, cat, note){
  const s = getState();
  s.money = s.money||[];
  const entry = {id:Date.now().toString(36)+Math.random().toString(36).slice(2,5),
    ts:Date.now(), date:today(), time:nowT(), amount:amount, cat:cat, note:note||'', src:'bot'};
  s.money.push(entry);
  setState(s);
  sheet('Money',['date','time','amount','category','note','source']).appendRow([entry.date,entry.time,amount,cat,note||'','bot']);
}

function isPrivate(){ const s=getState(); return s.moneyPrivate !== false; }
function monthLine(){
  const s=getState(); const mo=today().slice(0,7);
  const tot=(s.money||[]).filter(x=>x.date&&x.date.indexOf(mo)===0).reduce((a,x)=>a+Number(x.amount||0),0);
  const tday=(s.money||[]).filter(x=>x.date===today()).reduce((a,x)=>a+Number(x.amount||0),0);
  let line='Today ₹'+tday+' · Month ₹'+tot;
  if(s.budget>0) line+=' / ₹'+s.budget+' ('+Math.round(tot/s.budget*100)+'%)';
  return line;
}

function sendMoneySummary(){
  const s=getState(); const mo=today().slice(0,7);
  const rows=(s.money||[]).filter(x=>x.date&&x.date.indexOf(mo)===0);
  const byCat={}; rows.forEach(x=>{byCat[x.cat]=(byCat[x.cat]||0)+Number(x.amount||0);});
  let t='💰 <b>This month</b>\n'+monthLine()+'\n';
  Object.keys(byCat).sort((a,b)=>byCat[b]-byCat[a]).forEach(c=>{t+='\n'+c+': ₹'+byCat[c];});
  send(t, appBtns());
}

function sendStatus(){
  const s=getState();
  const done=(s.habits||[]).filter(h=>h.done).length, tot=(s.habits||[]).length;
  send('📊 Habits today: '+done+'/'+tot+'\nScore: '+(s.score||'—')+(isPrivate()?'':'\n'+monthLine()), appBtns());
}

/*──────────────── CALLBACKS (button taps) ────────────────*/
function handleCallback(cb){
  const data = cb.data||'';
  tg('answerCallbackQuery',{callback_query_id:cb.id});

  if(data.indexOf('cat:')===0){
    const cat=data.slice(4);
    const pend=JSON.parse(props().getProperty('PENDING_MONEY')||'null');
    if(pend){ saveMoney(pend.amount,cat,pend.note); props().deleteProperty('PENDING_MONEY');
      send('✅ Logged <b>₹'+pend.amount+'</b> · '+cat+(isPrivate()?'':'\n'+monthLine())); }
    return;
  }
  if(data.indexOf('hab:')===0){
    const parts=data.split(':'); // hab:<id>:done|miss
    setHabit(parts[1], parts[2]==='done');
    checkAllAnswered();
    return;
  }
  if(data==='spend:none'){ send('👍 Noted — nothing spent.'); return; }
  if(data==='allhab:done'){
    const s=getState(); (s.habits||[]).forEach(h=>{ if(!h.done){h.done=true;h.streak=(h.streak||0)+1;h.total=(h.total||0)+1;} });
    setState(s); clearPending(); send('🔥 All habits done. That\'s how it\'s built.');
    return;
  }
}

function setHabit(id, done){
  const s=getState();
  const h=(s.habits||[]).find(x=>x.id===id);
  if(!h) return;
  h.done=done;
  if(done){h.streak=(h.streak||0)+1;h.total=(h.total||0)+1;} else {h.streak=0;}
  setState(s);
}

function checkAllAnswered(){
  const s=getState();
  const pend=(s.habits||[]).filter(h=>!h.done);
  // "answered" = every habit has been tapped today; we track taps loosely:
  // if all done → celebrate & clear; if some missed we still clear after taps
  const flag=JSON.parse(props().getProperty('HABIT_PENDING')||'null');
  if(!flag) return;
  flag.remaining=(flag.remaining||0)-1;
  if(flag.remaining<=0){ clearPending();
    const done=(s.habits||[]).filter(h=>h.done).length;
    send(done===(s.habits||[]).length?'🔥 Clean sweep. See you tomorrow.':'Logged. '+done+'/'+(s.habits||[]).length+' today. Tomorrow, all of them.');
  } else props().setProperty('HABIT_PENDING',JSON.stringify(flag));
}
function clearPending(){ props().deleteProperty('HABIT_PENDING'); }

function markHabitByName(name){
  const s=getState(); const n=name.toLowerCase();
  const h=(s.habits||[]).find(x=>x.name.toLowerCase().indexOf(n)>=0);
  if(!h) return send('No habit matching "'+esc(name)+'". Your habits: '+(s.habits||[]).map(x=>x.name).join(', '));
  h.done=true; h.streak=(h.streak||0)+1; h.total=(h.total||0)+1; setState(s);
  send('✅ '+esc(h.name)+' — streak '+h.streak+' 🔥');
}

/*──────────────── SCHEDULED PINGS ────────────────*/
/* Morning #2 (9 AM): daily money question — asks, never states numbers when private */
function ping9amMoney(){
  send('💰 <b>Daily money check.</b>\n1) What have you spent so far today? → type <i>spent 250 chai</i>\n2) What is in your account right now? → type <i>balance 45000</i>',
    [[{text:'Nothing yet', callback_data:'spend:none'}],[{text:'💰 Open Money in app', url:(props().getProperty('PWA_URL')||'https://as18784.github.io/my-life-os/')+'?mode=money'}]]);
}

/* Evening engine: 8 pings from 19:30, every 30 min. Habit pings silence once answered; money pings always fire. */
function eveningEngine(){
  const hm = Utilities.formatDate(new Date(),TZ,'HH:mm');
  const slot = ['19:30','20:00','20:30','21:00','21:30','22:00','22:30','23:00'].findIndex(t=>{
    const [H,M]=t.split(':').map(Number);
    const [h,m]=hm.split(':').map(Number);
    return h===H && Math.abs(m-M)<15;   // trigger fires within ~15 min of slot
  });
  if(slot<0) return;
  const s=getState();
  const pwa=(props().getProperty('PWA_URL')||'https://as18784.github.io/my-life-os/');
  const moneySlots=[1,4];  // 20:00 spend ask, 21:30 balance ask — ALWAYS fire
  if(moneySlots.indexOf(slot)>=0){
    if(slot===1) send('💰 <b>Money ping.</b> Any spends since morning? Type <i>spent 400 dinner</i> or log in app.',
      [[{text:'Nothing spent', callback_data:'spend:none'},{text:'💰 Open app', url:pwa+'?mode=money'}]]);
    else send('🏦 <b>Balance check.</b> What\'s in your account right now? Type <i>balance 45000</i>.'+(s.balance!=null&&!isPrivate()?'\nLast noted: ₹'+Number(s.balance).toLocaleString():''),
      [[{text:'💰 Open Money', url:pwa+'?mode=money'}]]);
    return;
  }
  // Habit slots: fire only while unanswered
  const flag=JSON.parse(props().getProperty('HABIT_PENDING')||'null');
  const pending=(s.habits||[]).filter(h=>!h.done);
  if(slot===0){
    if(!pending.length){ send('🔥 Habits already done. Log today\'s skill practice in the app.',[[{text:'📖 Open app', url:pwa}]]); return; }
    props().setProperty('HABIT_PENDING', JSON.stringify({date:today(), remaining:pending.length, nags:0}));
    sendHabitButtons(pending,'🌙 <b>Habit check-in (7:30 PM).</b> Answer here or log in the app:');
    return;
  }
  if(slot===7){ // 23:00 closer — always fires
    send('🌑 <b>Last call.</b> Unanswered habits get marked at midnight. Skill practiced today? Any final spends?',
      [[{text:'📖 Open app', url:pwa},{text:'💰 Money', url:pwa+'?mode=money'}]]);
    return;
  }
  // slots 2,3,5,6 → habit nags, only if still pending
  if(flag && flag.date===today() && pending.length){
    flag.nags=(flag.nags||0)+1;
    props().setProperty('HABIT_PENDING',JSON.stringify(flag));
    sendHabitButtons(pending,'⏰ Still open — '+pending.length+' habit(s). Tap here or log in app:');
  }
}

function ping7am(){
  const s=getState();
  const habs=(s.habits||[]).map(h=>'• '+h.name+(h.streak?' ('+h.streak+'🔥)':'')).join('\n');
  const pris=(s.priorities||[]).length?('\n\n🎯 Priorities:\n'+(s.priorities||[]).map(p=>'• '+p).join('\n')):'\n\n🎯 Open the app and set today\'s 3 priorities.';
  send('☀️ <b>Morning, '+( s.name||'Akash')+'.</b>\n\nHabits today:\n'+habs+pris, appBtns());
}
function ping1pm(){
  send('🕐 <b>Midday check.</b>\nWhat\'s done from your priorities? Spent anything?\n\nType it (e.g. <i>spent 250 lunch</i>) or tap:',
    [[{text:'Nothing spent', callback_data:'spend:none'}],[{text:'💰 Open Money', url:(props().getProperty('PWA_URL')||'https://as18784.github.io/my-life-os/')+'?mode=money'}]]);
}
function ping6pm(){
  send('🕕 <b>Evening spend check.</b>'+(isPrivate()?'':'\n'+monthLine())+'\nAnything unlogged from today?',
    [[{text:'Nothing spent', callback_data:'spend:none'}]]);
}
function ping7pmHabits(){
  const s=getState();
  const pending=(s.habits||[]).filter(h=>!h.done);
  if(!pending.length){ send('🔥 All habits already done. Rare air.'); return; }
  props().setProperty('HABIT_PENDING', JSON.stringify({date:today(), remaining:pending.length, nags:0}));
  sendHabitButtons(pending, '🌙 <b>Habit check-in.</b> Answer honestly:');
}
function sendHabitButtons(pending, title){
  const rows = pending.map(h=>[
    {text:'✅ '+h.name, callback_data:'hab:'+h.id+':done'},
    {text:'✖️', callback_data:'hab:'+h.id+':miss'}
  ]);
  rows.push([{text:'🔥 All done', callback_data:'allhab:done'}]);
  rows.push([{text:'📖 Open app to log', url:(props().getProperty('PWA_URL')||'https://as18784.github.io/my-life-os/')}]);
  send(title, rows);
}
// Runs every 30 min; only acts 19:00–23:59 when check-in unanswered
function nagChecker(){
  const h=hourNow(); if(h<19) return;
  const flag=JSON.parse(props().getProperty('HABIT_PENDING')||'null');
  if(!flag || flag.date!==today()) return;
  flag.nags=(flag.nags||0)+1;
  if(flag.nags>5) return; // max 5 nags
  props().setProperty('HABIT_PENDING',JSON.stringify(flag));
  const s=getState();
  const pending=(s.habits||[]).filter(x=>!x.done);
  if(!pending.length){ clearPending(); return; }
  sendHabitButtons(pending, '⏰ Still waiting. '+pending.length+' habit(s) unanswered. Nag '+flag.nags+'/5:');
}
function midnightMark(){
  const flag=JSON.parse(props().getProperty('HABIT_PENDING')||'null');
  if(flag && flag.date===today()){
    const s=getState();
    s.ignoredDays=s.ignoredDays||[]; s.ignoredDays.push(flag.date);
    (s.habits||[]).forEach(h=>{ if(!h.done) h.streak=0; });
    setState(s); clearPending();
    send('🟥 Day marked <b>IGNORED</b>. Streaks of unanswered habits reset to 0. It\'s on the dashboard in red.');
  }
  // daily reset happens in the PWA on open; also reset here for bot accuracy
  const s2=getState(); (s2.habits||[]).forEach(h=>h.done=false); s2.priorities=[]; setState(s2);
}

/*──────────────── AI COACH (optional) ────────────────*/
function coachReply(text){
  const key = props().getProperty('ANTHROPIC_API_KEY');
  const s = getState();
  if(!key){
    send('Noted. (Add ANTHROPIC_API_KEY in Script Properties to unlock AI replies.)');
    const log=s.log||[]; log.push({id:Date.now().toString(36),ts:Date.now(),type:'note',text:text,time:nowT()});
    s.log=log; setState(s); return;
  }
  try{
    const res=UrlFetchApp.fetch('https://api.anthropic.com/v1/messages',{
      method:'post', contentType:'application/json',
      headers:{'x-api-key':key,'anthropic-version':'2023-06-01'},
      payload:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:300,
        system:'You are a strict but caring accountability coach for '+(s.name||'Akash')+'. Goal: '+(s.goal||'')+'. Weakness: '+(s.weakness||'')+'. Habits: '+(s.habits||[]).map(h=>h.name+' streak '+(h.streak||0)).join(', ')+'. '+(isPrivate()?'':monthLine()+'. ')+'Reply in under 60 words. Push back on excuses. No fluff.',
        messages:[{role:'user',content:text}]}),
      muteHttpExceptions:true});
    const j=JSON.parse(res.getContentText());
    const reply=(j.content&&j.content[0]&&j.content[0].text)||'Noted.';
    send(esc(reply));
    const log=s.log||[]; log.push({id:Date.now().toString(36),ts:Date.now(),type:'note',text:text,time:nowT()});
    s.log=log; setState(s);
  }catch(e){ send('Noted (AI temporarily unreachable).'); }
}

function esc(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/*──────────────── ONE-TIME SETUP ────────────────*/
function setup(){
  if(WEB_APP_URL.indexOf('http')!==0) throw new Error('Paste your deployed /exec URL into WEB_APP_URL first, then run setup again.');
  // store PWA url for buttons
  props().setProperty('PWA_URL','https://as18784.github.io/my-life-os/');
  // webhook
  tg('setWebhook',{url:WEB_APP_URL});
  // clear old triggers
  ScriptApp.getProjectTriggers().forEach(t=>ScriptApp.deleteTrigger(t));
  // daily anchors
  // MORNING (2): 7 AM life, 9 AM money question
  ScriptApp.newTrigger('ping7am').timeBased().atHour(7).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('ping9amMoney').timeBased().atHour(9).everyDays(1).inTimezone(TZ).create();
  // EVENING (8): engine fires every 30 min, acts on slots 19:30→23:00
  ScriptApp.newTrigger('eveningEngine').timeBased().everyMinutes(30).create();
  // Midnight judgement
  ScriptApp.newTrigger('midnightMark').timeBased().atHour(0).everyDays(1).inTimezone(TZ).create();
  Logger.log('Setup complete: webhook set, 2 morning + 8 evening pings + midnight mark. Send /start to your bot.');
}
