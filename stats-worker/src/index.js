// 落地页访客统计：接收事件 + 带密码的统计后台
// 路由：
//   POST /e            接收落地页上报的事件
//   GET  /             统计后台（未登录时显示登录页）
//   POST /login        登录
//   GET  /logout       登出
//   GET  /api/stats    统计数据（需登录）

const EVENTS = new Set(["view", "copy", "copy_fail", "open_ok", "open_fail", "return", "dialog_show", "dialog_close", "steps_view", "scroll", "engagement", "leave"]);
const DIMS = { env: "env", os: "os", country: "country", w: "w", src: "src", cmp: "cmp" };
const TZ_OFFSET_SEC = 8 * 3600; // 按香港 / 台北时间（UTC+8）切分日期
const COOKIE = "stats_auth";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/e") return await collect(req, env);
      if (path === "/login" && req.method === "POST") return await login(req, env);
      if (path === "/logout") return logout();
      if (path === "/api/stats" || path === "/api/timeline") {
        if (!(await isAuthed(req, env))) return json({ error: "unauthorized" }, 401);
        if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        return json(path === "/api/stats" ? await stats(url, env) : await timeline(url, env));
      }
      if (path === "/") {
        if (!env.ADMIN_PASSWORD) return html(setupPage(), 500);
        return (await isAuthed(req, env)) ? html(dashboardPage()) : html(loginPage(url.searchParams.has("err")));
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ error: "server_error", detail: String(err && err.message || err) }, 500);
    }
  },
};

/* ---------------- 事件收集 ---------------- */

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin");
  const h = { "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  if (origin && allowedOrigins(env).includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

async function collect(req, env) {
  const headers = corsHeaders(req, env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response(null, { status: 405, headers });

  const origin = req.headers.get("Origin");
  const allowed = allowedOrigins(env);
  if (allowed.length && origin && !allowed.includes(origin)) return new Response(null, { status: 403, headers });

  const text = await req.text();
  if (text.length > 2048) return new Response(null, { status: 413, headers });

  let d;
  try { d = JSON.parse(text); } catch { return new Response(null, { status: 400, headers }); }
  if (!d || !EVENTS.has(d.e)) return new Response(null, { status: 400, headers });

  const vid = clip(d.vid, 40);
  if (!vid) return new Response(null, { status: 400, headers });

  // New fields are optional for older landing pages; reject malformed new values.
  const fields = { page: 256, sid: 80, event_id: 80, ref: 253 };
  for (const [name, max] of Object.entries(fields)) {
    if (d[name] != null && (typeof d[name] !== "string" || d[name].length > max)) return new Response(null, { status: 400, headers });
  }
  if (d.page && (!d.page.startsWith("/") || /[?#]/.test(d.page))) return new Response(null, { status: 400, headers });
  if (d.ref && !/^(?=.{1,253}$)[a-z0-9.-]+$/i.test(d.ref)) return new Response(null, { status: 400, headers });
  const requestedTarget = clip(d.target, 20);
  const target = ["modal", "page", "button", "escape", "copy"].includes(requestedTarget) ? requestedTarget : "";
  for (const [name, max] of [["elapsed_ms", 86400000], ["scroll_pct", 100]]) {
    if (d[name] != null && (!Number.isInteger(d[name]) || d[name] < 0 || d[name] > max)) return new Response(null, { status: 400, headers });
  }
  const ua = req.headers.get("User-Agent") || "";
  await env.DB.prepare(
    "INSERT OR IGNORE INTO events (ts,e,vid,w,src,cmp,env,os,country,page,sid,event_id,ref,target,elapsed_ms,scroll_pct) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    Date.now(), d.e, vid, clip(d.w, 64), clip(d.src, 64), clip(d.cmp, 64),
    browserEnv(ua), osName(ua), (req.cf && req.cf.country) || "",
    clip(d.page, 256) || null, clip(d.sid, 80) || null, clip(d.event_id, 80) || null,
    clip(d.ref, 253), target, d.elapsed_ms ?? null, d.scroll_pct ?? null
  ).run();
  return new Response(null, { status: 204, headers });
}

function clip(v, n) {
  return typeof v === "string" ? v.trim().slice(0, n) : "";
}

function browserEnv(ua) {
  if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua)) return "Facebook";
  if (/Instagram/i.test(ua)) return "Instagram";
  if (/MicroMessenger/i.test(ua)) return "WeChat";
  if (/WhatsApp/i.test(ua)) return "WhatsApp";
  if (/\bLine\//i.test(ua)) return "LINE";
  if (/Threads|Barcelona/i.test(ua)) return "Threads";
  if (/TikTok|musical_ly|BytedanceWebview/i.test(ua)) return "TikTok";
  if (/SamsungBrowser/i.test(ua)) return "Samsung";
  if (/EdgA?|EdgiOS/i.test(ua)) return "Edge";
  if (/CriOS|Chrome/i.test(ua)) return "Chrome";
  if (/FxiOS|Firefox/i.test(ua)) return "Firefox";
  if (/Safari/i.test(ua)) return "Safari";
  return "其他";
}

function osName(ua) {
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  return "其他";
}

/* ---------------- 统计查询 ---------------- */

function dayStartTs(daysBack) {
  // 今天（UTC+8）往前 daysBack-1 天的 00:00
  const nowSec = Math.floor(Date.now() / 1000) + TZ_OFFSET_SEC;
  const todayStart = nowSec - (nowSec % 86400);
  return (todayStart - (daysBack - 1) * 86400 - TZ_OFFSET_SEC) * 1000;
}

function counts(since, sameDay = false) { return `
  COUNT(DISTINCT CASE WHEN e='view' THEN vid END) AS views,
  COUNT(DISTINCT CASE WHEN e='view' AND sid IS NOT NULL AND sid != '' THEN sid END) AS visits,
  COUNT(DISTINCT CASE WHEN e='copy' AND sid IS NOT NULL AND sid != '' AND EXISTS (SELECT 1 FROM events AS seen WHERE seen.e='view' AND seen.sid=events.sid AND seen.page IS events.page AND seen.ts >= ${since} ${sameDay ? `AND date(seen.ts/1000 + ${TZ_OFFSET_SEC}, 'unixepoch') = date(events.ts/1000 + ${TZ_OFFSET_SEC}, 'unixepoch')` : ''}) THEN sid END) AS copies,
  SUM(CASE WHEN e='view' THEN 1 ELSE 0 END) AS pv`; }

function filters(url) {
  const choice = url.searchParams.get("page") || "current";
  const days = [1, 7, 30].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 7;
  const page = choice === "legacy" ? "(page IS NULL OR page = '')" : choice === "all" ? "1=1" : "page = ?";
  const args = [dayStartTs(days)];
  if (choice !== "legacy" && choice !== "all") args.push("/zss.github.io/");
  return { where: `ts >= ? AND ${page}`, args, days, choice };
}

async function stats(url, env) {
  const { where, args, days, choice } = filters(url);
  const db = env.DB;
  const COUNTS = counts(args[0]);
  const total = db.prepare(`SELECT ${COUNTS} FROM events WHERE ${where}`).bind(...args);
  const daily = db.prepare(`SELECT date(ts/1000 + ${TZ_OFFSET_SEC}, 'unixepoch') AS day, ${counts(args[0], true)} FROM events WHERE ${where} GROUP BY day ORDER BY day`).bind(...args);
  const dims = ["src", "ref", "env", "os", "country", "cmp", "w"];
  const dimQueries = dims.map(col => db.prepare(`SELECT COALESCE(NULLIF(${col},''),'（未知）') AS k, ${COUNTS} FROM events WHERE ${where} GROUP BY k ORDER BY visits DESC LIMIT 20`).bind(...args));
  // Legacy events cannot be assigned to a session. Keep them separate and label them unknown.
  const visits = db.prepare(`SELECT sid, MIN(ts) AS started, MAX(ts) AS last, MAX(vid) AS vid, MAX(src) AS src, MAX(env) AS env, MAX(os) AS os, MAX(country) AS country, MAX(page) AS page, MAX(elapsed_ms) AS elapsed_ms, MAX(scroll_pct) AS scroll_pct, MAX(CASE WHEN e='copy' THEN 1 ELSE 0 END) AS copied FROM events WHERE ${where} AND sid IS NOT NULL AND sid != '' GROUP BY sid ORDER BY last DESC LIMIT 100`).bind(...args);
  const result = await db.batch([total, daily, ...dimQueries, visits]);
  const breakdown = {}; dims.forEach((key, i) => { breakdown[key] = result[i + 2].results; });
  return { days, page: choice, generatedAt: Date.now(), total: result[0].results[0], daily: result[1].results, dims: breakdown, visits: result[result.length - 1].results };
}

async function timeline(url, env) {
  const sid = url.searchParams.get("sid") || "";
  if (!sid || sid.length > 80) return { events: [] };
  const { where, args } = filters(url);
  const rows = await env.DB.prepare(`SELECT ts,e,target,elapsed_ms,scroll_pct FROM events WHERE ${where} AND sid = ? ORDER BY ts,id LIMIT 500`).bind(...args, sid).all();
  return { events: rows.results };
}

/* ---------------- 登录 ---------------- */

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function isAuthed(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const m = (req.headers.get("Cookie") || "").match(new RegExp(COOKIE + "=([0-9]+)\\.([0-9a-f]{64})"));
  if (!m) return false;
  const exp = parseInt(m[1], 10);
  if (!exp || exp < Date.now()) return false;
  return safeEqual(m[2], await hmac(env.ADMIN_PASSWORD, "admin." + exp));
}

async function login(req, env) {
  const form = await req.formData();
  const pw = String(form.get("password") || "");
  if (!env.ADMIN_PASSWORD || !safeEqual(await hmac("pw", pw), await hmac("pw", env.ADMIN_PASSWORD))) {
    await new Promise((r) => setTimeout(r, 800)); // 减慢暴力尝试
    return new Response(null, { status: 303, headers: { Location: "/?err=1" } });
  }
  const exp = Date.now() + 30 * 86400 * 1000;
  const token = exp + "." + (await hmac(env.ADMIN_PASSWORD, "admin." + exp));
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${COOKIE}=${token}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

function logout() {
  return new Response(null, {
    status: 303,
    headers: { Location: "/", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` },
  });
}

/* ---------------- 回应工具 ---------------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/* ---------------- 页面 ---------------- */

const BASE_CSS = `
  :root { --green:#07c160; --green-dark:#06ad56; --green-soft:#e8f8ef; --ink:#1d2129; --muted:#86909c; --line:#eef0f3; --bg:#f4f6f8; --card:#fff; --red:#f53f3f; --amber:#ff9a2e; --blue:#3b82f6; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Helvetica Neue",Arial,sans-serif; -webkit-font-smoothing:antialiased; font-size:14px; }
  button, input, select { font-family:inherit; font-size:inherit; }
`;

function setupPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>统计后台</title><style>${BASE_CSS} .box{max-width:420px;margin:15vh auto;padding:28px;background:#fff;border-radius:16px;text-align:center;line-height:1.8}</style></head>
  <body><div class="box"><h2>尚未设置后台密码</h2><p>请在 Cloudflare 中执行<br><code>npx wrangler secret put ADMIN_PASSWORD</code></p></div></body></html>`;
}

function loginPage(err) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>统计后台 · 登录</title>
  <style>${BASE_CSS}
    .box { max-width:360px; margin:16vh auto 0; padding:32px 24px; background:var(--card); border-radius:18px; box-shadow:0 8px 30px rgba(15,35,25,.08); text-align:center; }
    .logo { width:56px; height:56px; margin:0 auto 14px; border-radius:16px; background:var(--green); display:flex; align-items:center; justify-content:center; }
    h1 { font-size:20px; margin-bottom:6px; } p { color:var(--muted); margin-bottom:22px; }
    input { width:100%; height:46px; padding:0 14px; border:1px solid #dfe3e8; border-radius:12px; outline:none; }
    input:focus { border-color:var(--green); box-shadow:0 0 0 3px rgba(7,193,96,.15); }
    button { width:100%; height:46px; margin-top:14px; border:0; border-radius:23px; background:var(--green); color:#fff; font-weight:600; cursor:pointer; }
    .err { color:var(--red); margin:10px 0 0; font-size:13px; }
  </style></head><body>
  <form class="box" method="post" action="/login">
    <div class="logo"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg></div>
    <h1>落地页统计后台</h1><p>请输入密码查看数据</p>
    <input type="password" name="password" placeholder="密码" autocomplete="current-password" autofocus required>
    ${err ? '<div class="err">密码错误，请重试</div>' : ""}
    <button type="submit">登录</button>
  </form></body></html>`;
}

function dashboardPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>落地页统计后台</title><style>${BASE_CSS}
  header{background:#07c160;color:#fff;padding:24px 16px 56px} .wrap{max-width:1080px;margin:auto} h1{font-size:21px} .controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px} select,button{border:1px solid #dce5df;border-radius:8px;padding:9px;background:#fff;color:#1d2129;cursor:pointer} a{color:inherit} main{padding:0 16px 40px;margin-top:-36px} .card{background:#fff;border-radius:16px;padding:20px;margin-bottom:12px;box-shadow:0 6px 24px rgba(15,35,25,.06)} .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px} .kpis .card{margin:0} .label{color:#667085} .value{font-size:26px;font-weight:700;margin-top:6px} h2{font-size:16px;margin-bottom:14px} .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px} .grid .card{margin:0} .scroll{overflow:auto} table{width:100%;border-collapse:collapse;font-size:13px} th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #eef0f3;white-space:nowrap} th{color:#667085;font-weight:500} .muted{color:#667085;font-size:12px;line-height:1.6} .full{margin-top:12px} .link{border:0;background:none;color:#087e43;text-decoration:underline;padding:0} @media(max-width:700px){.kpis{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}
  </style></head><body><header><div class="wrap"><h1>落地页统计后台</h1><p id="updated">加载中…</p><div class="controls"><label>日期 <select id="days"><option value="1">今天</option><option value="7" selected>近 7 天</option><option value="30">近 30 天</option></select></label><label>页面 <select id="page"><option value="current">/zss.github.io/</option><option value="legacy">历史未知页面</option><option value="all">全部页面（含历史未知）</option></select></label><button id="refresh">刷新</button><a href="/logout">登出</a></div></div></header>
  <main class="wrap"><section class="kpis"><div class="card"><div class="label">访问次数</div><div id="visits" class="value">–</div></div><div class="card"><div class="label">独立访客 UV</div><div id="views" class="value">–</div></div><div class="card"><div class="label">浏览次数 PV</div><div id="pv" class="value">–</div></div><div class="card"><div class="label">复制访问 / 转化率</div><div id="copies" class="value">–</div></div></section>
  <section class="grid"><div class="card"><h2>每日趋势</h2><div class="scroll"><table id="daily"></table></div></div><div class="card"><h2>来源、设备与地区</h2><select id="dim"><option value="src">来源渠道</option><option value="ref">引荐域名</option><option value="env">浏览环境</option><option value="os">系统</option><option value="country">地区</option><option value="cmp">广告系列</option><option value="w">WeChat ID</option></select><div class="scroll"><table id="breakdown"></table></div></div></section>
  <section class="card full"><h2>访问列表</h2><p class="muted">最近 100 次有会话编号的访问；历史记录缺少会话编号，无法还原访问轨迹，也不计入会话数与会话复制数。</p><div class="scroll"><table id="list"></table></div></section><section class="card"><h2>单次访问时间线</h2><p id="timelineHint" class="muted">选择上方访问以查看事件。</p><div class="scroll"><table id="timeline"></table></div></section><p class="muted">日期按 UTC+8 计算。会话复制率按有浏览记录且完成复制的会话数 / 浏览会话数计算；历史未知记录无会话编号，不参与会话统计。网页无法判断是否实际添加微信好友。</p></main>
  <script>
  (function(){
    var data; function $(id){return document.getElementById(id)}
    var eventNames={view:'页面浏览',copy:'复制成功',copy_fail:'复制失败',dialog_show:'弹窗展示',dialog_close:'弹窗关闭',steps_view:'查看步骤',scroll:'滚动',engagement:'可见停留更新',leave:'离开页面',open_ok:'旧版跳转（页面切换）',open_fail:'旧版跳转未确认',return:'返回页面'};
    var targetNames={modal:'弹窗',page:'页面',button:'点击按钮关闭',escape:'按 Escape 关闭',copy:'点击复制关闭'};
    function label(map,value){return Object.prototype.hasOwnProperty.call(map,value) ? map[value] : (value || '–')}
    function esc(s){return String(s == null ? '' : s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
    function n(v){return Number(v || 0).toLocaleString('en-US')}
    function pct(a,b){return b ? (a/b*100).toFixed(1)+'%' : '–'}
    function params(){return 'days='+encodeURIComponent($('days').value)+'&page='+encodeURIComponent($('page').value)}
    function table(id,headers,rows){ $(id).innerHTML='<thead><tr>'+headers.map(function(h){return '<th>'+esc(h)+'</th>'}).join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody>' }
    function cells(values){return '<tr>'+values.map(function(v){return '<td>'+esc(v)+'</td>'}).join('')+'</tr>'}
    function date(ts){return new Date(ts).toLocaleString('zh-HK',{timeZone:'Asia/Hong_Kong',hour12:false})}
    function dimensions(){table('breakdown',['分类','访问','访客','复制'],(data.dims[$('dim').value]||[]).map(function(r){return cells([r.k,n(r.visits),n(r.views),n(r.copies)])}))}
    function render(){var t=data.total;$('visits').textContent=n(t.visits);$('views').textContent=n(t.views);$('pv').textContent=n(t.pv);$('copies').textContent=n(t.copies)+' / '+pct(t.copies,t.visits);$('updated').textContent='更新于 '+date(data.generatedAt);
      table('daily',['日期','访问','访客','浏览','当日浏览并复制'],data.daily.map(function(r){return cells([r.day,n(r.visits),n(r.views),n(r.pv),n(r.copies)])}));dimensions();
      table('list',['开始时间','访客','来源','环境','系统','地区','可见停留秒','滚动','复制','轨迹'],data.visits.map(function(r,i){return '<tr>'+[date(r.started),r.vid,r.src||'未知',r.env,r.os,r.country,Math.round((r.elapsed_ms||0)/1000),n(r.scroll_pct)+'%',r.copied?'是':'否'].map(function(v){return '<td>'+esc(v)+'</td>'}).join('')+'<td><button class="link" data-index="'+i+'">查看</button></td></tr>'}));
      $('timeline').innerHTML='';$('timelineHint').textContent='选择上方访问以查看事件。';
    }
    function load(){ $('updated').textContent='加载中…';fetch('/api/stats?'+params(),{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error('request');return r.json()}).then(function(d){data=d;render()}).catch(function(){$('updated').textContent='加载失败，请重新登录或刷新'}) }
    $('list').addEventListener('click',function(e){var b=e.target.closest('button[data-index]');if(!b)return;var visit=data.visits[Number(b.dataset.index)];fetch('/api/timeline?'+params()+'&sid='+encodeURIComponent(visit.sid),{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error('request');return r.json()}).then(function(d){$('timelineHint').textContent='访问 '+visit.sid+'（最多 500 条事件）';table('timeline',['时间','事件','入口 / 关闭原因','可见停留秒','滚动'],d.events.map(function(r){return cells([date(r.ts),label(eventNames,r.e),label(targetNames,r.target),r.elapsed_ms==null?'–':Math.round(r.elapsed_ms/1000),r.scroll_pct==null?'–':r.scroll_pct+'%'])}))}).catch(function(){$('timelineHint').textContent='加载失败，请重试'})});
    $('days').addEventListener('change',load);$('page').addEventListener('change',load);$('refresh').addEventListener('click',load);$('dim').addEventListener('change',function(){if(data)dimensions()});load();
  })();
  </script></body></html>`;
}
