'use strict';
/*
 * Deep Space Cinema · 影院内部音画接入服务
 * 纯 Node 标准库实现：授权校验 / 会话 / 媒体库 / 流式 Range / SSE 实时插入。
 * 不依赖第三方 npm 包，方便开源部署。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const SECRET = process.env.LICENSE_SECRET || 'change-this-secret-before-production';
const DATA_DIR = path.join(__dirname, 'data');
const MEDIA_DIR = path.join(__dirname, 'media');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const MEDIA_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.jpg': 'image/jpeg', '.png': 'image/png'
};
const sessions = new Map();
for (const d of [DATA_DIR, MEDIA_DIR, path.join(__dirname, 'public')]) fs.mkdirSync(d, {recursive:true});
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');

function b64url(buf){ return Buffer.from(buf).toString('base64url'); }
function signPayload(payload){
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyLicense(key){
  if (!key || typeof key !== 'string' || key.indexOf('.') < 0) return null;
  const parts = key.trim().split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || typeof p !== 'object' || !p.plan || !p.exp) return null;
    if (Number(p.exp) < Math.floor(Date.now()/1000)) return null;
    return p;
  } catch (_) { return null; }
}
function cors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-License-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function json(res, code, obj){
  cors(res); res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(obj));
}
function readBody(req, max=1024*1024){
  return new Promise((resolve,reject)=>{
    let n=0; const chunks=[];
    req.on('data', d=>{ n+=d.length; if(n>max){ reject(new Error('body too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', ()=> resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function tokenOf(req, url){
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return url.searchParams.get('token') || '';
}
function licenseOf(req, url){
  return url.searchParams.get('license') || req.headers['x-license-key'] || '';
}
function authSession(req, url){
  const token = tokenOf(req, url);
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(token); return null; }
  return s;
}
function safeName(name){
  return String(name || '').replace(/[^\w.\-()\u4e00-\u9fa5]+/g, '_').slice(0,180) || 'media_' + Date.now();
}
function listMedia(){
  return fs.readdirSync(MEDIA_DIR).filter(f=>MEDIA_TYPES[path.extname(f).toLowerCase()]).map(f=>{
    const st=fs.statSync(path.join(MEDIA_DIR,f));
    return {id:f, name:f, size:st.size, type:MEDIA_TYPES[path.extname(f).toLowerCase()]||'application/octet-stream', mtime:st.mtimeMs};
  }).sort((a,b)=>b.mtime-a.mtime);
}
const clients = new Set();
function broadcast(sessionId, event, data){
  const payload = 'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n';
  for (const c of clients) {
    if (!sessionId || c.sessionId === sessionId) {
      try { c.res.write(payload); } catch (_) {}
    }
  }
}
function serveFile(req,res,name){
  const file = path.join(MEDIA_DIR, path.basename(name));
  if (!fs.existsSync(file)) return json(res,404,{error:'media_not_found'});
  const st=fs.statSync(file); const size=st.size; const type=MEDIA_TYPES[path.extname(file).toLowerCase()]||'application/octet-stream';
  const range=req.headers.range;
  cors(res);
  res.setHeader('Accept-Ranges','bytes');
  res.setHeader('Content-Type',type);
  res.setHeader('Cache-Control','no-store');
  if (!range) { res.writeHead(200, {'Content-Length':size}); return fs.createReadStream(file).pipe(res); }
  const m=/bytes=(\d*)-(\d*)/.exec(range);
  if(!m) return json(res,416,{error:'bad_range'});
  let start = m[1] ? parseInt(m[1],10) : 0;
  let end = m[2] ? parseInt(m[2],10) : size-1;
  if (start >= size || end >= size || start > end) return json(res,416,{error:'range_not_satisfiable'});
  res.writeHead(206, {'Content-Range':`bytes ${start}-${end}/${size}`, 'Content-Length':end-start+1, 'Accept-Ranges':'bytes'});
  fs.createReadStream(file,{start,end}).pipe(res);
}
function serveStatic(req,res,url){
  const rel=url.pathname.replace(/^\/public\//,'').replace(/^\/+/,'');
  const file=path.join(__dirname,'public',path.basename(rel));
  if (!fs.existsSync(file)) return false;
  const ext=path.extname(file).toLowerCase();
  res.writeHead(200, {'Content-Type': MEDIA_TYPES[ext] || (ext==='.html'?'text/html; charset=utf-8':'text/plain; charset=utf-8')});
  fs.createReadStream(file).pipe(res); return true;
}
const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url, `http://${req.headers.host||'127.0.0.1'}`);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  try {
    if (url.pathname === '/api/health') return json(res,200,{ok:true,service:'cinema-av-service',version:'1.0.0',time:Date.now()});

    if (url.pathname === '/api/license/verify' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8')||'{}');
      const p = verifyLicense(body.licenseKey || '');
      if (!p) return json(res,401,{valid:false,error:'invalid_or_expired_license'});
      return json(res,200,{valid:true,plan:p.plan,sub:p.sub||'',exp:p.exp,expires:new Date(p.exp*1000).toISOString()});
    }

    if (url.pathname === '/api/orders' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8')||'{}');
      if (!body.contact || !body.plan) return json(res,400,{error:'contact_and_plan_required'});
      const orders = JSON.parse(fs.readFileSync(ORDERS_FILE,'utf8')||'[]');
      const order = {id:'DS-'+Date.now().toString(36).toUpperCase(), plan:String(body.plan), contact:String(body.contact).slice(0,120), note:String(body.note||'').slice(0,400), status:'pending_payment', ts:Date.now()};
      orders.unshift(order); fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders.slice(0,2000),null,2));
      return json(res,201,{ok:true,order:order,message:'购买申请已记录；完成授权付款后由管理员发放 licenseKey。'});
    }

    if (url.pathname === '/api/session' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8')||'{}');
      const lic = verifyLicense(body.licenseKey || licenseOf(req,url));
      if (!lic) return json(res,401,{error:'invalid_license',message:'需要先购买授权并在官网服务区获取 licenseKey'});
      const token = crypto.randomBytes(28).toString('base64url');
      const session = {token, sessionId:'cs_'+crypto.randomBytes(8).toString('hex'), plan:lic.plan, exp:Date.now()+8*3600*1000, created:Date.now()};
      sessions.set(token, session);
      return json(res,200,{ok:true,session,baseUrl:`http://${req.headers.host}`, sse:`/api/events?token=${encodeURIComponent(token)}`});
    }

    if (url.pathname === '/api/library' && req.method === 'GET') {
      const s=authSession(req,url); if(!s) return json(res,401,{error:'invalid_session'});
      return json(res,200,{ok:true,items:listMedia()});
    }

    if (url.pathname === '/api/upload' && req.method === 'PUT') {
      const s=authSession(req,url); if(!s) return json(res,401,{error:'invalid_session'});
      const name=safeName(url.searchParams.get('name')||'upload.bin');
      const ext=path.extname(name).toLowerCase();
      if(!MEDIA_TYPES[ext]) return json(res,415,{error:'unsupported_media_type'});
      const out=path.join(MEDIA_DIR,name);
      const ws=fs.createWriteStream(out);
      let bytes=0;
      await new Promise((resolve,reject)=>{
        req.on('data',d=>{bytes+=d.length; if(bytes>4*1024*1024*1024){ reject(new Error('media too large')); req.destroy(); }});
        req.pipe(ws);
        ws.on('finish',resolve); ws.on('error',reject); req.on('error',reject);
      });
      broadcast(s.sessionId,'library',{name,size:bytes,type:MEDIA_TYPES[ext]});
      return json(res,201,{ok:true,item:{id:name,name,size:bytes,type:MEDIA_TYPES[ext]}});
    }

    if (url.pathname.startsWith('/api/stream/') && req.method === 'GET') {
      const s=authSession(req,url); if(!s) return json(res,401,{error:'invalid_session'});
      return serveFile(req,res,decodeURIComponent(url.pathname.slice('/api/stream/'.length)));
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      const s=authSession(req,url); if(!s) return json(res,401,{error:'invalid_session'});
      cors(res); res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.write('event: hello\ndata: '+JSON.stringify({sessionId:s.sessionId,plan:s.plan})+"\n\n");
      const c={res,sessionId:s.sessionId}; clients.add(c);
      const ka=setInterval(()=>{try{res.write(': keepalive\n\n');}catch(_){}},20000);
      req.on('close',()=>{clearInterval(ka);clients.delete(c);});
      return;
    }

    if (url.pathname === '/api/insert' && req.method === 'POST') {
      const s=authSession(req,url); if(!s) return json(res,401,{error:'invalid_session'});
      const body=JSON.parse((await readBody(req)).toString('utf8')||'{}');
      const action=String(body.action||'play');
      if(!['play','pause','seek','load','stop'].includes(action)) return json(res,400,{error:'bad_action'});
      const ev={action,mediaId:body.mediaId||'',time:Number(body.time||0),by:body.by||'remote',ts:Date.now()};
      broadcast(s.sessionId,'insert',ev);
      return json(res,200,{ok:true,event:ev});
    }

    if (url.pathname.startsWith('/public/') && req.method === 'GET') {
      if (serveStatic(req,res,url)) return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const file=path.join(__dirname,'public','index.html');
      if(fs.existsSync(file)){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return fs.createReadStream(file).pipe(res);}
      return json(res,200,{service:'cinema-av-service',docs:'/public/index.html'});
    }
    return json(res,404,{error:'not_found',path:url.pathname});
  } catch (e) {
    console.error('[cinema-av]',e);
    return json(res,500,{error:'server_error',message:e.message});
  }
});
server.listen(PORT,HOST,()=>{
  console.log(`[cinema-av] listening on http://${HOST}:${PORT}`);
  console.log(`[cinema-av] license secret = ${SECRET==='change-this-secret-before-production'?'DEV_DEFAULT (change before production)':'configured'}`);
});
