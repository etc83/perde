// Perde yerel sunucusu. Node 18+ ve (MKV için) ffmpeg gerekir: brew install ffmpeg
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const PORT = process.env.PORT || 7777;
const LOCAL = !!process.env.LOCAL && process.env.LOCAL !== '0';   // LOCAL=1: yalnızca bu bilgisayara açık (varsayılan: ağdaki her cihaza açık, giriş yok)
const FFMPEG = process.env.FFMPEG || 'ffmpeg', FFPROBE = process.env.FFPROBE || 'ffprobe';
const SEG = 2;                                        // hedef parça süresi (sn): küçük parça = ilk görüntü daha çabuk
const EXT_START = process.env.EXT_START === '1';          // deneysel: listeye başlangıç noktası ekler. Safari'de videoyu dondurdu, varsayılan kapalı
const PREROLL_SEGS = process.env.PREROLL_SEGS === undefined ? 3 : +process.env.PREROLL_SEGS;   // ilk listede en az bu kadar parça olsun (0 = kapalı)
const PREROLL_WAIT_MS = +process.env.PREROLL_WAIT_MS || 3000;                                   // ilk parçadan sonra bunun için en çok bu kadar bekle
const PREROLL = +process.env.PREROLL || 0;               // başlamadan önce hazırlanacak en az süre (sn); varsayılan 0
const DEBUG = !!process.env.PERDE_DEBUG;             // PERDE_DEBUG=1 node server.js : ayrıntılı ölçüm
const AHEAD = (+process.env.AHEAD_MIN || 10) * 60;    // izleme noktasının en fazla bu kadar ilerisi hazırlanır
const TMP = path.join(os.tmpdir(), 'perde-hls');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const rd = (n, d) => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, n), 'utf8')); } catch { return d; } };
const wr = (n, o) => { const f = path.join(__dirname, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2), { mode: 0o600 }); };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => {
  const ct = String(req.headers['content-type'] || '');
  const isForm = /application\/x-www-form-urlencoded/i.test(ct);   // sendBeacon bu tiple gönderir
  let b = '';
  req.on('data', d => { b += d; if (b.length > 5e6) req.destroy(); });
  req.on('end', () => {
    if (!isForm) { try { r(JSON.parse(b || '{}')); } catch { r({}); } return; }
    try {
      const p = new URLSearchParams(b), o = {};
      for (const [k, v] of p) { try { o[k] = JSON.parse(v); } catch { o[k] = v; } }
      r(o);
    } catch { r({}); }
  });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isHttp = u => /^https?:\/\//i.test(u || '');
const MAX_STREAMS = +process.env.MAX_STREAMS || 6;   // aynı anda en çok bu kadar yeniden paketleme oturumu

// ---------- Kullanıcılar, oturumlar ----------
let U = (() => { const d = rd('users.json', null); return d && d.secret ? d : { secret: crypto.randomBytes(32).toString('hex'), users: [] }; })();
const saveUsers = () => wr('users.json', U);
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
const checkPw = (pw, stored) => {
  const [salt, h] = String(stored).split(':'); if (!salt || !h) return false;
  const x = Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex')), y = Buffer.from(h);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const DUMMY = hashPw('perde-dummy');                  // kullanıcı yokken de aynı süreyi harcamak için
const pubUser = u => ({ id: u.id, name: u.name, role: u.role });
const findByName = n => U.users.find(u => u.name.toLowerCase() === String(n).trim().toLowerCase());
const validName = n => typeof n === 'string' && /^[^\x00-\x1f<>"'&]{2,32}$/.test(n.trim());
const validPw = p => typeof p === 'string' && p.length >= 6 && p.length <= 200;
const dataFile = id => `data/${id}.json`;
const sign = p => crypto.createHmac('sha256', U.secret).update(p).digest('base64url');
const makeSession = u => { const p = Buffer.from(JSON.stringify({ u: u.id, pv: u.pv || 0, e: Date.now() + 30 * 864e5 })).toString('base64url'); return p + '.' + sign(p); };
const cookie = v => `perde=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${v ? 2592000 : 0}`;
function sessionUser(req) {
  const m = /(?:^|;\s*)perde=([\w.-]+)/.exec(req.headers.cookie || ''); if (!m) return null;
  const [p, sig] = m[1].split('.'); if (!p || !sig) return null;
  const x = Buffer.from(sign(p)), y = Buffer.from(sig); if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return null;
  let d; try { d = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
  const u = U.users.find(z => z.id === d.u);
  return u && (u.pv || 0) === d.pv && d.e > Date.now() ? u : null;     // parola değişince / kullanıcı silinince oturum geçersiz olur
}
const fails = new Map();
const recent = k => (fails.get(k) || []).filter(t => Date.now() - t < 15 * 60e3);
const tooMany = (k, n) => recent(k).length >= n;
const addFail = k => { fails.set(k, [...recent(k), Date.now()]); if (fails.size > 2000) fails.delete(fails.keys().next().value); };
// Kaynak adresleri (içinde AllDebrid anahtarı olabilir) tarayıcıya gitmez; yalnızca kullanıcıya özel, süreli bir bilet gider.
const toks = new Map();
function mkTok(url, uid) {
  const t = crypto.randomBytes(12).toString('hex'); toks.set(t, { url, uid, e: Date.now() + 6 * 36e5 });
  if (toks.size > 5000) { for (const [k, v] of toks) if (v.e < Date.now()) toks.delete(k); while (toks.size > 5000) toks.delete(toks.keys().next().value); }
  return t;
}
function tokUrl(t, uid) {
  const v = toks.get(String(t));
  if (!v || v.uid !== uid || v.e < Date.now()) throw new Error('Kaynağın süresi doldu. Kaynağı listeden yeniden seçin.');
  return v.url;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/mp4', '.mp4': 'video/mp4' };

// ---------- Yeniden paketleme: MKV -> parça parça HLS (görüntü kopyalanır, yeniden kodlanmaz) ----------
const sessions = new Map();
const genSeconds = dir => { try { let t = 0; for (const m of fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8').matchAll(/#EXTINF:([\d.]+)/g)) t += +m[1]; return t; } catch { return 0; } };

// Torrentio/AllDebrid bağlantısı her açılışta yönlendirme zinciri çalıştırır (yavaş). Nihai adresi bir kez çözüp saklarız.
const urlCache = new Map();
async function finalUrl(url) {
  const hit = urlCache.get(url);
  if (hit && Date.now() - hit.t < 20 * 60e3) return hit.v;
  let cur = url;
  try {
    for (let i = 0; i < 6; i++) {
      const r = await fetch(cur, { headers: { 'User-Agent': UA, Range: 'bytes=0-0' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      r.body?.cancel().catch(() => {});
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) { cur = new URL(loc, cur).href; continue; }
      if (!r.ok) return url;
      break;
    }
  } catch { return url; }
  urlCache.set(url, { t: Date.now(), v: cur });
  if (urlCache.size > 30) urlCache.delete(urlCache.keys().next().value);
  return cur;
}
const probeCache = new Map();
function probe(url, key = url) {
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.t < 6 * 3600e3) return Promise.resolve(hit.v);
  return new Promise((ok, no) => execFile(FFPROBE, ['-v', 'error', '-user_agent', UA, '-show_entries', 'format=duration,bit_rate:stream=index,codec_type,codec_name,channels:stream_tags=language,title', '-of', 'json', url],
    { timeout: 45000, maxBuffer: 4e6 }, (e, out) => {
      if (e) return no(new Error(e.code === 'ENOENT' ? 'ffprobe bulunamadı. Terminalde “brew install ffmpeg” çalıştırın.' : 'Dosya okunamadı (ffprobe).'));
      try { const v = JSON.parse(out); probeCache.set(key, { t: Date.now(), v }); if (probeCache.size > 20) probeCache.delete(probeCache.keys().next().value); ok(v); }
      catch { no(new Error('Dosya bilgisi okunamadı.')); }
    }));
}
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
function trackInfo(info) {
  const st = info.streams || [], m = s => ({ index: s.index, lang: s.tags?.language || '', title: s.tags?.title || '', codec: s.codec_name, ch: s.channels });
  return { duration: +info.format?.duration || 0, bitrate: +info.format?.bit_rate || 0, audios: st.filter(s => s.codec_type === 'audio').map(m), subs: st.filter(s => s.codec_type === 'subtitle' && TEXT_SUBS.has(s.codec_name)).map(m) };
}
// Gömülü altyazıyı WebVTT'ye çıkarır. from/dur verilirse yalnızca o pencere okunur (hızlı); zaman damgaları mutlak olur.
const subCache = new Map();
function shiftVtt(text, d) {
  const rx = /(?:(\d+):)?(\d\d):(\d\d)[.,](\d{3})/g;
  return text.split('\n').map(l => l.includes('-->') ? l.replace(rx, (m, h, mi, sec, ms) => {
    const t = Math.max(0, (+(h || 0)) * 3600 + +mi * 60 + +sec + +ms / 1000 + d), H = Math.floor(t / 3600), M = Math.floor(t % 3600 / 60), S = t % 60;
    return `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}:${S.toFixed(3).padStart(6, '0')}`;
  }) : l).join('\n');
}
function extractSub(url, idx, from = 0, dur = 0) {
  const k = [url, idx, from, dur].join('|');
  if (!subCache.has(k)) {
    const p = finalUrl(url).then(src => new Promise((ok, no) => {
      const args = ['-v', 'error', '-user_agent', UA, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
      if (from > 0) args.push('-ss', String(from));
      args.push('-i', src, '-map', '0:' + idx);
      if (dur > 0) args.push('-t', String(dur));
      args.push('-c:s', 'webvtt', '-f', 'webvtt', '-');
      execFile(FFMPEG, args, { timeout: 20 * 60e3, maxBuffer: 30e6 }, (e, out) => e ? no(new Error(e.code === 'ENOENT' ? 'ffmpeg bulunamadı. Terminalde “brew install ffmpeg” çalıştırın.' : 'Altyazı çıkarılamadı.')) : ok(from > 0 ? shiftVtt(out, from) : out));
    }));
    p.catch(() => subCache.delete(k));
    subCache.set(k, p);
    if (subCache.size > 60) subCache.delete(subCache.keys().next().value);
  }
  return subCache.get(k);
}
// ---------- OpenSubtitles ----------
async function osApi(p, { method = 'GET', body, auth, base } = {}) {
  const c = rd('config.json', {});
  const h = { 'Api-Key': c.osKey || '', 'User-Agent': 'Perde v1.0', 'Content-Type': 'application/json', Accept: 'application/json' };
  if (auth && c.osToken) h.Authorization = 'Bearer ' + c.osToken;
  const r = await fetch((base || c.osBase || 'https://api.opensubtitles.com/api/v1') + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function osLogin() {
  const c = rd('config.json', {});
  const r = await osApi('/login', { method: 'POST', body: { username: c.osUser, password: c.osPass }, base: 'https://api.opensubtitles.com/api/v1' });
  if (r.status !== 200) throw new Error('OpenSubtitles girişi başarısız. Kullanıcı adı, parola ve API anahtarını kontrol edin.');
  const n = rd('config.json', {}); n.osToken = r.data.token;
  if (r.data.base_url) n.osBase = 'https://' + r.data.base_url + '/api/v1';
  wr('config.json', n);
}
const toVtt = t => t.replace(/^\uFEFF/, '').startsWith('WEBVTT') ? t.replace(/^\uFEFF/, '') : 'WEBVTT\n\n' + t.replace(/^\uFEFF/, '').replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2');
function decodeText(buf, lang) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder(/^tr/i.test(lang) ? 'windows-1254' : 'windows-1252').decode(buf); }   // eski Türkçe altyazılar
}

async function speedTest(src) {
  const t = Date.now(); let n = 0;
  try { const r = await fetch(src, { headers: { Range: 'bytes=0-20971519', 'User-Agent': UA }, signal: AbortSignal.timeout(30000) }); for await (const c of r.body) n += c.length; } catch {}
  const sec = (Date.now() - t) / 1000;
  console.log(`[debug] ağ hızı (tek bağlantı, ${(n / 1e6).toFixed(0)} MB): ${(n / 1e6 / sec).toFixed(1)} MB/s = ${(n * 8 / 1e6 / sec).toFixed(0)} Mbit/s`);
}
// -ss kopyalama modunda bir önceki anahtar kareye oturur; gerçek başlangıç noktasını (K) öğreniriz
function keyframeBefore(src, ss) {
  return new Promise(ok => execFile(FFPROBE, ['-v', 'error', '-user_agent', UA, '-select_streams', 'v:0', '-read_intervals', `${ss}%+#1`, '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', src],
    { timeout: 20000 }, (e, out) => { const k = parseFloat(String(out || '').split(',')[0]); ok(!e && isFinite(k) && k <= ss + 0.5 ? k : ss); }));
}
function stopHls(id) {
  const s = sessions.get(id); if (!s) return;
  try { s.proc.kill('SIGKILL'); } catch {}
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
  sessions.delete(id);
}
async function startHls1(url, ss = 0, aidx, t0 = Date.now(), uid = '', key = url) {
  const info = await probe(url, key), ti = trackInfo(info), tProbe = Date.now();
  const v = (info.streams || []).find(s => s.codec_type === 'video');
  if (!v) throw new Error('Videoda görüntü akışı bulunamadı.');
  const a = ti.audios.find(x => x.index === aidx) || ti.audios.find(x => /^(tur|tr)$/i.test(x.lang)) || ti.audios[0];   // seçilen, yoksa Türkçe, yoksa ilk ses
  const mine = [...sessions.values()].filter(x => x.uid === uid);
  while (mine.length >= 2) stopHls(mine.shift().id);                 // kullanıcı başına en çok 2 oturum
  if (sessions.size >= MAX_STREAMS) throw new Error('Sunucu şu an çok meşgul. Biraz sonra tekrar deneyin.');
  const id = crypto.randomBytes(6).toString('hex'), dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });
  const args = ['-hide_banner', '-loglevel', DEBUG ? 'info' : 'error', '-user_agent', UA, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-reconnect_on_network_error', '1'];   // hız sınırı yok: ne kadar ilerisi hazırlanacağını aşağıdaki bekletme belirler
  if (ss > 0) args.push('-ss', String(ss), '-noaccurate_seek');   // ses ve görüntü aynı anahtar kareden başlar (boşluk/kayma olmaz)                                   // istenen noktadan başla (hızlı sarma)
  args.push('-i', url, '-map', '0:' + v.index);
  if (a) args.push('-map', '0:' + a.index);
  args.push('-sn', '-dn', '-c:v', 'copy');
  if (v.codec_name === 'hevc') args.push('-tag:v', 'hvc1');                 // Safari için gerekli
  if (a) args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');              // yalnızca ses AAC'ye çevrilir (hafif)
  args.push('-f', 'hls', '-hls_time', String(SEG), '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(dir, 'seg%05d.m4s'), '-hls_flags', 'independent_segments+temp_file', path.join(dir, 'index.m3u8'));
  const kP = ss > 0 ? keyframeBefore(url, ss) : Promise.resolve(0);   // ffmpeg ile paralel çalışır
  const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const s = { id, dir, proc, uid, err: '', last: Date.now(), pos: 0, paused: false, done: false };
  const tStart = Date.now();
  proc.stderr.on('data', d => {
    s.err = (s.err + d).slice(-500);
    if (DEBUG) for (const l of String(d).split(/[\r\n]+/)) if (/Input #|Stream #|Output #|speed=|Opening/.test(l)) console.log(`[ffmpeg +${Date.now() - tStart} ms] ${l.trim().slice(0, 140)}`);
  });
  proc.on('exit', () => { s.done = true; });
  proc.on('error', e => { s.err = e.code === 'ENOENT' ? 'ffmpeg bulunamadı. Terminalde “brew install ffmpeg” çalıştırın.' : e.message; s.done = true; });
  sessions.set(id, s);
  const ready = () => fs.existsSync(path.join(dir, 'index.m3u8')) && fs.existsSync(path.join(dir, 'seg00000.m4s'));
  const segs = () => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.m4s')).length; } catch { return 0; } };
  const tWait = Date.now(); let tReady = 0;
  for (let i = 0; i < 400; i++) {
    if (s.done) break;
    if (ready()) {
      tReady = tReady || Date.now();
      if ((segs() >= PREROLL_SEGS && genSeconds(dir) >= PREROLL) || Date.now() - tReady > PREROLL_WAIT_MS) break;   // yeterli parça var ya da bekleme süresi doldu
    }
    await sleep(100);
  }
  if (!ready()) { const msg = s.err.trim() || 'Hazırlık zaman aşımına uğradı.'; stopHls(id); throw new Error('ffmpeg: ' + msg); }
  const mbps = ti.bitrate ? ` · dosya ${(ti.bitrate / 1e6).toFixed(0)} Mbit/s` : '';
  if (DEBUG) speedTest(url);
  console.log(`[hls] ss=${ss}s${mbps}  ffprobe ${tProbe - t0} ms · ffmpeg ilk parça+ön tampon ${Date.now() - tProbe} ms (${segs()} parça) · toplam ${Date.now() - t0} ms`);
  const k0 = await kP; s.want = Math.max(0, ss - k0);       // anahtar kare ile istenen nokta arasındaki fark (sn)
  return { id, start: k0, gen: genSeconds(dir), duration: ti.duration, audios: ti.audios, subs: ti.subs, aidx: a ? a.index : null };
}
async function startHls(url, ss = 0, aidx, uid = '') {
  const t0 = Date.now(), src = await finalUrl(url);
  console.log(`[hls] bağlantı çözümleme ${Date.now() - t0} ms${src === url ? ' (yönlendirme yok/başarısız)' : ''}`);
  try { return await startHls1(src, ss, aidx, t0, uid, url); }
  catch (e) {                                          // süresi dolmuş olabilir: taze çözümle, bir kez daha dene
    if (!urlCache.has(url)) throw e;
    urlCache.delete(url);
    return await startHls1(await finalUrl(url), ss, aidx, Date.now(), uid, url);
  }
}
// Boşta kalanları temizle; izleme noktasının çok ilerisine geçildiyse ffmpeg'i beklet (disk ve bant genişliği tasarrufu)
setInterval(() => {
  for (const s of sessions.values()) {
    if (Date.now() - s.last > 5 * 60e3) { stopHls(s.id); continue; }
    if (s.done) continue;
    const gen = genSeconds(s.dir);
    try {
      if (!s.paused && gen > s.pos + AHEAD) { s.proc.kill('SIGSTOP'); s.paused = true; }
      else if (s.paused && gen < s.pos + AHEAD * 0.6) { s.proc.kill('SIGCONT'); s.paused = false; }
    } catch {}
  }
}, 1000).unref();
const cleanup = () => { for (const id of [...sessions.keys()]) stopHls(id); };
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0); });

function sendFile(req, res, f, type) {
  const st = fs.statSync(f), h = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const a = m[1] === '' ? Math.max(0, st.size - +m[2]) : +m[1], b = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(+m[2], st.size - 1);
    if (a > b) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...h, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
    return fs.createReadStream(f, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { ...h, 'Content-Length': st.size });
  fs.createReadStream(f).pipe(res);
}

// Parola göster/gizle ikonları (inline SVG — harici bağımlılık yok)
const EYE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7.5 11-7.5S23 12 23 12s-4 7.5-11 7.5S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.6 10.6 0 0 1 12 19.5C5 19.5 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.4 9.4 0 0 1 12 4.5c7 0 11 7.5 11 7.5a18.7 18.7 0 0 1-2.16 3.3"/><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

const LOGIN = mode => `<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Perde</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#f3f3f3;font:16px system-ui,sans-serif}
form,main{width:min(340px,90vw)}h1{font:600 1.8rem ui-serif,Georgia,serif;color:#ffc46b;margin:0 0 .4rem}
p{color:#b3b3b3;margin:.2rem 0 1rem}input,button{width:100%;box-sizing:border-box;font:inherit;padding:.8rem;border-radius:8px;border:1px solid #2e2e2e;background:#141414;color:inherit;margin-bottom:.6rem}
button{background:#ffc46b;color:#000;border-color:#ffc46b;font-weight:600}#m{color:#ff8a8a;min-height:1.4em;margin:0}
.pw{position:relative}.pw input{padding-right:3.2rem;margin-bottom:.6rem}.pw svg{display:block}.pw button{position:absolute;right:.35rem;top:50%;transform:translateY(-50%);width:auto;margin:0;padding:.35rem .45rem;background:transparent;border:none;color:#b3b3b3;font-weight:400;cursor:pointer;line-height:1;display:flex;align-items:center}.pw button:hover,.pw button:focus-visible{color:#fff;background:transparent;border:none}</style>
${mode === 'blocked' ? `<main><h1>Perde</h1><p>İlk kurulum yalnızca sunucunun çalıştığı bilgisayardan yapılır. O bilgisayarda <b>http://localhost:${PORT}</b> adresini açıp yönetici hesabını oluşturun.</p></main>` :
`<form id=f><h1>Perde</h1><p>${mode === 'setup' ? 'İlk kurulum: yönetici hesabı oluşturun.' : 'Giriş yapın.'}</p>
<input id=n placeholder="Kullanıcı adı" autocomplete="username" autofocus>
<div class=pw><input id=p type=password placeholder="Parola" autocomplete="${mode === 'setup' ? 'new-password' : 'current-password'}"><button type=button data-t=p aria-label="Parolayı göster/gizle" title="Parolayı göster/gizle">${EYE}</button></div>
${mode === 'setup' ? '<div class=pw><input id=p2 type=password placeholder="Parola (tekrar)" autocomplete="new-password"><button type=button data-t=p2 aria-label="Parolayı göster/gizle" title="Parolayı göster/gizle">' + EYE + '</button></div>' : ''}<button>${mode === 'setup' ? 'Hesabı oluştur' : 'Giriş'}</button><p id=m></p></form>
<script>var MODE='${mode}';
var EYE='${EYE}',EYE_OFF='${EYE_OFF}';
document.querySelectorAll('.pw button').forEach(function(b){b.onclick=function(){var i=document.getElementById(b.dataset.t),s=i.type==='password';i.type=s?'text':'password';b.innerHTML=s?EYE_OFF:EYE;i.focus()}});
f.onsubmit=async function(e){e.preventDefault();
if(MODE==='setup'&&p.value!==p2.value){m.textContent='Parolalar aynı değil.';return}
var r=await fetch(MODE==='setup'?'/api/setup':'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:n.value,password:p.value})});
if(r.ok)location.href='/';else m.textContent=((await r.json().catch(function(){return{}})).error)||'Bir hata oluştu.'}</script>`}</html>`;

http.createServer(async (req, res) => {
  const host = req.headers.host || '';
  const localHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  let originHost = ''; try { originHost = req.headers.origin ? new URL(req.headers.origin).host : ''; } catch {}
  // Başka sitelerin (CSRF) istek atmasını engelle; yalnızca-yerel modda DNS rebinding'e karşı Host da denetlenir.
  if ((originHost && originHost !== host) || (LOCAL && !localHost)) { res.writeHead(403); return res.end('Yasak'); }
  const url = new URL(req.url, 'http://localhost'), pn = url.pathname, POST = req.method === 'POST';
  const ip = req.socket.remoteAddress || '';
  const loopback = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip) && !req.headers['x-forwarded-for'] && !req.headers['tailscale-user-login'];
  const setCookie = v => ({ 'content-type': 'application/json', 'Set-Cookie': cookie(v) });
  try {
    const user = sessionUser(req);
    const admin = () => user?.role === 'admin' || (json(res, 403, { error: 'Bu işlem için yönetici olmalısınız.' }), false);

    // ---- Herkese açık: giriş ve ilk kurulum ----
    if (pn === '/login') {
      if (user) { res.writeHead(302, { Location: '/' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(LOGIN(U.users.length ? 'login' : loopback && localHost ? 'setup' : 'blocked'));
    }
    if (pn === '/api/setup' && POST) {
      if (U.users.length) return json(res, 403, { error: 'Kurulum zaten yapılmış.' });
      if (!(loopback && localHost)) return json(res, 403, { error: 'İlk kurulum yalnızca sunucu bilgisayarından yapılır.' });
      const b = await readBody(req);
      if (!validName(b.name) || !validPw(b.password)) return json(res, 400, { error: 'Kullanıcı adı 2-32 karakter, parola en az 6 karakter olmalı.' });
      const u = { id: 'u_' + crypto.randomBytes(4).toString('hex'), name: b.name.trim(), role: 'admin', pw: hashPw(b.password), pv: 0 };
      U.users.push(u); saveUsers();
      try { const old = path.join(__dirname, 'data.json'); if (fs.existsSync(old)) { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); fs.renameSync(old, path.join(__dirname, dataFile(u.id))); } } catch {}   // eski kütüphane/ilerleme yöneticiye geçer
      res.writeHead(200, setCookie(makeSession(u))); return res.end('{"ok":true}');
    }
    if (pn === '/api/login' && POST) {
      const b = await readBody(req), name = String(b.name || '').trim().toLowerCase(), k1 = ip + '|' + name;
      if (tooMany(k1, 5) || tooMany(ip, 20)) return json(res, 429, { error: 'Çok fazla deneme. 15 dakika sonra tekrar deneyin.' });
      const u = findByName(name), ok = checkPw(String(b.password || ''), u ? u.pw : DUMMY);
      if (!u || !ok) { addFail(k1); addFail(ip); return json(res, 401, { error: 'Kullanıcı adı veya parola yanlış.' }); }
      res.writeHead(200, setCookie(makeSession(u))); return res.end('{"ok":true}');
    }
    if (pn === '/api/logout' && POST) { res.writeHead(200, setCookie('')); return res.end('{"ok":true}'); }
    if (!user) {
      if (pn.startsWith('/api/') || pn.startsWith('/hls/')) return json(res, 401, { error: 'Giriş gerekli' });
      res.writeHead(302, { Location: '/login' }); return res.end();
    }

    // ---- Hesap ve kullanıcı yönetimi ----
    if (pn === '/api/me') return json(res, 200, pubUser(user));
    if (pn === '/api/me/password' && POST) {
      const b = await readBody(req);
      if (!checkPw(String(b.old || ''), user.pw)) return json(res, 400, { error: 'Mevcut parola yanlış.' });
      if (!validPw(b.pw)) return json(res, 400, { error: 'Yeni parola en az 6 karakter olmalı.' });
      user.pw = hashPw(b.pw); user.pv = (user.pv || 0) + 1; saveUsers();
      res.writeHead(200, setCookie(makeSession(user))); return res.end('{"ok":true}');
    }
    if (pn === '/api/users' && !POST) { if (!admin()) return; return json(res, 200, U.users.map(pubUser)); }
    if (pn === '/api/users' && POST) {
      if (!admin()) return;
      const b = await readBody(req);
      if (!validName(b.name) || !validPw(b.password)) return json(res, 400, { error: 'Kullanıcı adı 2-32 karakter, parola en az 6 karakter olmalı.' });
      if (findByName(b.name)) return json(res, 400, { error: 'Bu kullanıcı adı zaten var.' });
      const u = { id: 'u_' + crypto.randomBytes(4).toString('hex'), name: b.name.trim(), role: b.role === 'admin' ? 'admin' : 'user', pw: hashPw(b.password), pv: 0 };
      U.users.push(u); saveUsers(); return json(res, 200, pubUser(u));
    }
    if (pn === '/api/users/update' && POST) {
      if (!admin()) return;
      const b = await readBody(req), t = U.users.find(x => x.id === b.id);
      if (!t) return json(res, 404, { error: 'Kullanıcı bulunamadı.' });
      if (b.role && b.role !== t.role) {
        if (!['admin', 'user'].includes(b.role)) return json(res, 400, { error: 'Geçersiz rol.' });
        if (t.role === 'admin' && U.users.filter(x => x.role === 'admin').length < 2) return json(res, 400, { error: 'Son yönetici kullanıcıya çevrilemez.' });
        t.role = b.role;
      }
      let headers = { 'content-type': 'application/json' };
      if (b.password) {
        if (!validPw(b.password)) return json(res, 400, { error: 'Parola en az 6 karakter olmalı.' });
        t.pw = hashPw(b.password); t.pv = (t.pv || 0) + 1;
        if (t.id === user.id) headers = setCookie(makeSession(t));
      }
      saveUsers(); res.writeHead(200, headers); return res.end('{"ok":true}');
    }
    if (pn === '/api/users/delete' && POST) {
      if (!admin()) return;
      const b = await readBody(req), t = U.users.find(x => x.id === b.id);
      if (!t) return json(res, 404, { error: 'Kullanıcı bulunamadı.' });
      if (t.role === 'admin' && U.users.filter(x => x.role === 'admin').length < 2) return json(res, 400, { error: 'Son yönetici silinemez.' });
      U.users = U.users.filter(x => x.id !== t.id); saveUsers();
      try { fs.rmSync(path.join(__dirname, dataFile(t.id)), { force: true }); } catch {}
      for (const s of [...sessions.values()]) if (s.uid === t.id) stopHls(s.id);
      return json(res, 200, { ok: true });
    }

    // ---- Ayarlar (yönetici) ----
    if (pn === '/api/config') {
      const c = rd('config.json', {});
      if (POST) {
        if (!admin()) return;
        const b = await readBody(req);
        if (typeof b.addon === 'string') c.addon = b.addon.trim();
        for (const k of ['osKey', 'osUser', 'osPass', 'langs']) if (typeof b[k] === 'string' && b[k].trim()) c[k] = b[k].trim();
        if (b.osKey || b.osUser || b.osPass) { delete c.osToken; delete c.osBase; }
        delete c.adKey; delete c.pin; delete c.secret;
        wr('config.json', c);
      }
      const pub = { addonSet: !!c.addon, osSet: !!(c.osKey && c.osUser && c.osPass), osQuery: !!c.osKey, langs: c.langs || 'tr,en', debug: DEBUG };
      return json(res, 200, user.role === 'admin' ? { ...pub, addon: c.addon || '', osUser: c.osUser || '' } : pub);
    }
    if (pn === '/api/addon/test' && POST) {
      if (!admin()) return;
      const b = await readBody(req), u = String(b.url || rd('config.json', {}).addon || '').replace(/^stremio:\/\//, 'https://');
      if (!isHttp(u)) return json(res, 400, { error: 'Geçersiz adres' });
      const r = await fetch(u, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      const m = await r.json().catch(() => null);
      if (!r.ok || !m) return json(res, 502, { error: 'Eklenti yanıt vermedi (adres doğru mu?).' });
      return json(res, 200, { name: m.name, version: m.version });
    }

    // ---- Kullanıcıya özel veri ----
    if (pn === '/api/data') {
      const f = dataFile(user.id);
      if (POST) {
        const b = await readBody(req);
        if (!Array.isArray(b.library) || typeof b.progress !== 'object' || !b.progress) return json(res, 400, { error: 'Geçersiz veri' });
        const old = rd(f, { library: [], progress: {} });
        // Birleşik yazım: içerik bazında en yeni zaman damgalı kayıt kazanır
        // (iki cihaz aynı anda farklı içerik izlerse eski tam-yazım diğerinin ilerlemesini silerdi)
        const merged = { ...(old.progress || {}) };
        for (const [id, rec] of Object.entries(b.progress)) {
          const prev = merged[id];
          if (!prev || (rec?.u || 0) >= (prev.u || 0)) merged[id] = rec;
        }
        wr(f, { library: b.library, progress: merged, prefs: old.prefs });
      }
      return json(res, 200, rd(f, { library: [], progress: {} }));
    }
    if (pn === '/api/progress' && !POST) {                // tek içeriğin güncel ilerleme kaydı (cihazlar arası çakışmayı önler)
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      if (!id) return json(res, 400, { error: 'id gerekli' });
      const d = rd(dataFile(user.id), { progress: {} });
      return json(res, 200, d.progress?.[id] || null);
    }
    if (pn === '/api/prefs') {                          // içerik filtre tercihi (view'dan bağımsız, cihazlar arası taşınır)
      const f = dataFile(user.id);
      if (POST) {
        const b = await readBody(req), flt = b.filters;
        if (!flt || typeof flt !== 'object') return json(res, 400, { error: 'Geçersiz veri' });
        const d = rd(f, { library: [], progress: {} });
        d.prefs = { ...d.prefs, filters: flt };
        wr(f, d);
      }
      return json(res, 200, rd(f, {}).prefs || {});
    }

    // ---- Kaynaklar: eklentiye sunucu gider; kullanıcı yalnızca anahtarsız bir bilet (tok) görür ----
    if (pn === '/api/streams') {
      const c = rd('config.json', {}), type = url.searchParams.get('type'), sid = url.searchParams.get('sid') || '';
      if (!c.addon) return json(res, 400, { error: 'Kaynak eklentisi ayarlanmamış. Yöneticiden Ayarlar’a eklemesini isteyin.' });
      if (!/^(movie|series)$/.test(type || '') || !/^tt\d+(:\d+:\d+)?$/.test(sid)) return json(res, 400, { error: 'Geçersiz istek' });
      const base = c.addon.replace(/^stremio:\/\//, 'https://').replace(/\/manifest\.json.*$/, '').replace(/\/$/, '');
      const r = await fetch(`${base}/stream/${type}/${sid}.json`, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d) return json(res, 502, { error: 'Eklenti yanıt vermedi.' });
      const streams = (Array.isArray(d.streams) ? d.streams : []).slice(0, 60).map(s => {
        let fname = s.behaviorHints?.filename || (s.url || '').split('?')[0].split('/').pop() || '';
        try { fname = decodeURIComponent(fname); } catch {}
        return { name: s.name, title: s.title || s.description, tok: isHttp(s.url) ? mkTok(s.url, user.id) : null, direct: /\.(mp4|m4v|mov)$/i.test(fname.trim()) };
      });
      return json(res, 200, { streams });
    }
    if (pn === '/api/direct') {                      // bilet -> nihai (anahtarsız) video adresi
      const fin = await finalUrl(tokUrl(url.searchParams.get('t'), user.id));
      if (url.searchParams.get('json')) return json(res, 200, { url: fin });
      res.writeHead(302, { Location: fin, 'Cache-Control': 'no-store' }); return res.end();
    }
    if (pn === '/api/download') {                    // bilet -> dosya içeriği bu cihazın diskiné iner (sunucu köprüsü)
      const fin = await finalUrl(tokUrl(url.searchParams.get('t'), user.id));
      let r;
      try { r = await fetch(fin, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(600000) }); }
      catch { return json(res, 502, { error: 'Kaynağa ulaşılamadı' }); }
      if (!r.ok || !r.body) { r.body?.cancel().catch(() => {}); return json(res, 502, { error: 'İndirme hatası: ' + r.status }); }
      let fname = (url.searchParams.get('name') || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 120) || 'video.mp4';
      if (!/\.[a-z0-9]{2,4}$/i.test(fname)) fname += '.mp4';
      const hdrs = {
        'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
        'Cache-Control': 'no-store',
      };
      const cl = r.headers.get('content-length'); if (cl) hdrs['Content-Length'] = cl;   // boş başlık gönderilirse HTTP parse bozulur
      res.writeHead(200, hdrs);
      // İstemci sekmesini kapatırsa (abort) kaynaktan okumayı durdur
      req.on('close', () => { r.body.cancel().catch(() => {}); });
      const { Readable } = require('node:stream');
      return Readable.fromWeb(r.body).pipe(res);
    }
    if (pn === '/api/proxy') {                       // yalnızca Cinemeta (metadata) için CORS köprüsü
      let t = url.searchParams.get('url'), h = '';
      try { h = new URL(t).hostname; } catch {}
      if (h !== 'v3-cinemeta.strem.io') return json(res, 403, { error: 'İzin verilmeyen adres' });
      // v3-cinemeta.strem.io artık katalog isteklerini cinemeta-catalogs.strem.io'ya 307 ile yönlendiriyor.
      // fetch'in otomatik yönlendirmesi bazen takılıyor/engelleniyor → Location'u elle izliyoruz (en fazla 3 hop).
      let r;
      for (let hop = 0; hop < 4; hop++) {
        r = await fetch(t, { headers: { Accept: 'application/json', 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(25000) });
        const loc = r.headers.get('location');
        if (r.status >= 301 && r.status <= 308 && loc) { t = new URL(loc, t).href; continue; }
        break;
      }
      if (r.status >= 301 && r.status <= 308) return json(res, 502, { error: 'Cinemeta yönlendirme döngüsü' });
      res.writeHead(r.status, { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(await r.text());
    }
    if (pn === '/api/hls/start' && POST) {
      const b = await readBody(req), real = tokUrl(b.tok, user.id);
      return json(res, 200, await startHls(real, Math.max(0, +b.ss || 0), b.aidx == null ? undefined : +b.aidx, user.id));
    }
    if (pn === '/api/probe' && POST) {
      const b = await readBody(req);
      const real = tokUrl(b.tok, user.id);
      return json(res, 200, trackInfo(await probe(await finalUrl(real), real)));
    }
    if (pn === '/api/hls/sub') {
      const real = tokUrl(url.searchParams.get('tok'), user.id), i = +url.searchParams.get('index');
      if (!Number.isInteger(i)) return json(res, 400, { error: 'Geçersiz istek' });
      res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8' });
      return res.end(await extractSub(real, i, Math.max(0, +url.searchParams.get('from') || 0), Math.max(0, +url.searchParams.get('dur') || 0)));
    }
    if (pn === '/api/subs') {
      const q = url.searchParams, p = new URLSearchParams({ languages: q.get('langs') || 'tr,en', order_by: 'download_count', order_direction: 'desc' });
      if (q.get('imdb')) {
        const id = q.get('imdb').replace(/^tt/, '');
        if (q.get('season')) { p.set('parent_imdb_id', id); p.set('season_number', q.get('season')); p.set('episode_number', q.get('episode')); }
        else p.set('imdb_id', id);
      }
      const r = await osApi('/subtitles?' + p);
      if (r.status !== 200) return json(res, r.status, { error: r.data.message || 'OpenSubtitles araması başarısız (API anahtarı?)' });
      return json(res, 200, (r.data.data || []).map(d => ({ file_id: d.attributes.files?.[0]?.file_id, lang: d.attributes.language, release: d.attributes.release, downloads: d.attributes.download_count })).filter(x => x.file_id));
    }
    if (pn === '/api/osmeta' && POST) {                // toplu: IMDb puanı (OpenSubtitles /subtitles/query)
      const b = await readBody(req);
      const ids = [...new Set((b.ids || []).map(x => String(x).replace(/^tt/, '')).filter(x => /^\d+$/.test(x)))].slice(0, 50);
      if (!ids.length) return json(res, 200, { map: {} });
      const out = {};
      await Promise.all(ids.map(async id => {
        out[id] = { rating: null };                    // yanıt gelmese bile "biliniyor" sayılmasın → null
        try {
          const r = await osApi('/subtitles/query?imdb_id=' + id + '&limit=40');
          if (r.status !== 200) return;
          let rating = 0;
          for (const a of (r.data.data || []).map(d => d.attributes || {})) {
            // imdb_stars çoğu yanıtta dolu gelir; yoksa diğer puan alanlarına da bak
            for (const key of ['imdb_stars', 'ratings', 'avg_edit_user_rating']) {
              const v = parseFloat(a[key]); if (v > 0 && v <= 10) rating = Math.max(rating, v);
            }
          }
          out[id] = { rating: rating || null };
        } catch {}
      }));
      return json(res, 200, { map: out });
    }
    if (pn === '/api/cinemeta') {                      // meta eksikse (puan/tür/altyazı) tam meta çek
      const type = url.searchParams.get('type'), id = String(url.searchParams.get('id') || '');
      if (!/^(movie|series)$/.test(type) || !/^tt\d+$/.test(id)) return json(res, 400, { error: 'Geçersiz istek' });
      try {
        const r = await fetch(`${CINE}/meta/${type}/${id}.json`, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
        const d = await r.json().catch(() => ({}));
        const m = d.meta;
        if (!m) return json(res, 404, { error: 'Bulunamadı' });
        return json(res, 200, { imdbRating: m.imdbRating || '', year: m.year || '', genres: m.genres || [], subtitles: m.subtitles || [] });
      } catch (e) { return json(res, 502, { error: 'Meta alınamadı' }); }
    }
    if (pn === '/api/sub') {
      const body = { file_id: +url.searchParams.get('file_id') };
      let r = await osApi('/download', { method: 'POST', body, auth: true });
      if (r.status === 401 || !rd('config.json', {}).osToken) { await osLogin(); r = await osApi('/download', { method: 'POST', body, auth: true }); }
      if (!r.data.link) return json(res, r.status || 500, { error: r.data.message || 'Altyazı indirilemedi (günlük limit?)' });
      const text = decodeText(Buffer.from(await (await fetch(r.data.link, { signal: AbortSignal.timeout(20000) })).arrayBuffer()), url.searchParams.get('lang') || '');
      res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8' });
      return res.end(toVtt(text));
    }
    const mine = id => { const s = sessions.get(id); return s && (s.uid === user.id || user.role === 'admin') ? s : null; };
    if (pn === '/api/hls/pos' && POST) {
      const b = await readBody(req), s = mine(b.id);
      if (s) { s.pos = +b.pos || 0; s.last = Date.now(); }
      return json(res, 200, { ok: !!s, gen: s ? genSeconds(s.dir) : 0 });   // hazırlanan süre: istemci sarmada buna bakar
    }
    if (pn === '/api/hls/stop' && POST) {
      const b = await readBody(req); if (mine(b.id)) stopHls(b.id);
      return json(res, 200, { ok: true });
    }
    if (pn === '/api/log' && POST) {                 // tarayıcı olayları (yalnızca PERDE_DEBUG=1)
      const b = await readBody(req);
      if (DEBUG) console.log(`[tarayıcı ${user.name}] ` + String(b.m).slice(0, 300));
      res.writeHead(204); return res.end();
    }
    const hm = pn.match(/^\/hls\/([a-f0-9]+)\/([\w.]+)$/);
    if (hm) {
      const s = mine(hm[1]), f = s && path.join(s.dir, hm[2]);
      if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end('Bulunamadı'); }
      s.last = Date.now();
      if (DEBUG && !hm[2].endsWith('.m3u8')) { const t0 = Date.now(); res.on('finish', () => console.log(`[sunucu] ${hm[2]} ${res.statusCode} ${req.headers.range || ''} ${Date.now() - t0} ms`)); }
      if (hm[2].endsWith('.m3u8') && EXT_START && s.want > 0.5) {      // liste, kaldığınız noktada başlasın (tarayıcı sonradan atlamak zorunda kalmasın)
        let txt = fs.readFileSync(f, 'utf8');
        if (!txt.includes('#EXT-X-START')) txt = txt.replace('#EXTM3U', `#EXTM3U\n#EXT-X-START:TIME-OFFSET=${s.want.toFixed(3)},PRECISE=YES`);
        if (DEBUG && !s.startLogged) { s.startLogged = true; console.log(`[hls] liste başlangıç noktası: ${s.want.toFixed(1)} sn`); }
        res.writeHead(200, { 'Content-Type': MIME['.m3u8'], 'Cache-Control': 'no-store' }); return res.end(txt);
      }
      return sendFile(req, res, f, MIME[path.extname(f)] || 'application/octet-stream');
    }
    // Statik dosyalar (+ npm ile kurulduysa hls.js)
    const vendor = pn.startsWith('/vendor/hls/');
    const root = vendor ? path.join(__dirname, 'node_modules', 'hls.js', 'dist') : path.join(__dirname, 'public');
    const rel = vendor ? pn.slice('/vendor/hls/'.length) : (pn === '/' ? 'index.html' : pn);
    const f = path.join(root, decodeURIComponent(rel));
    if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Bulunamadı'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (res.headersSent) return res.destroy();
    json(res, e.name === 'TimeoutError' ? 504 : 502, { error: e.name === 'TimeoutError' ? 'Zaman aşımı' : e.message });
  }
}).listen(PORT, LOCAL ? '127.0.0.1' : '0.0.0.0', () => {
  console.log(`Perde hazır: http://localhost:${PORT}`);
  console.log(U.users.length ? `${U.users.length} kullanıcı kayıtlı.` : 'İLK KURULUM: bu bilgisayarda http://localhost:' + PORT + ' adresini açıp yönetici hesabını oluşturun.');
  if (LOCAL) return console.log('Yalnızca bu bilgisayara açık (LOCAL=1).');
  console.log('Ağdaki cihazlardan (giriş gerekir) şu adreslerden biri:');
  for (const [n, list] of Object.entries(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  http://${i.address}:${PORT}   (${n})`);
  console.log('Güvenmediğiniz bir Wi-Fi ağındaysanız: npm run local');
});
