// 배너 템플릿 스튜디오 · 팀 서버 (Cloudflare Pages Functions)
// 연결(바인딩)이 2개 필요해요:
//   DB    → D1 데이터베이스 (목록·작업 내용·팀 현황 기록)
//   FILES → KV 네임스페이스 (이미지 파일)
// 환경 변수 TEAM_PASSWORD 를 정하면 라이브러리·팀 작업함을 바꿀 때 그 비밀번호가 필요해요.
//
//   GET    /api/library              라이브러리 목록          GET /api/library/:id   이미지
//   POST   /api/library?name=&kind=  이미지 올리기 (본문 = 이미지)   DELETE /api/library/:id
//   GET    /api/works                팀 작업함 목록           GET /api/works/:id  (?thumb=1 미리보기)
//   POST   /api/works                새 작업 저장            PUT /api/works/:id 덮어쓰기   DELETE /api/works/:id
//   GET|PUT /api/wimg/:hash, /api/limg/:hash   작업에 쓰인 이미지 (같은 이미지는 한 번만 저장)
//   GET    /api/live                 팀 현황 (작업 세션 + 최근 저장한 소재)
//   GET    /api/live?gallery=1       소재 갤러리 (저장한 소재 전체 + 하트·메모)
//   GET    /api/live/:id             세션 작업 상태   ?thumb=1 미리보기  ?full=1 큰 이미지  ?ev=1 저장한 소재의 작업 상태
//   DELETE /api/live/:key            소재 삭제 (key = 소재 id, 버전 전부 · 팀 비밀번호 필요)
//   POST   /api/live                 작업 상태 보내기   ?ping=1 작업 중 신호   ?event=1 소재 저장 기록   ?fav=1 하트·메모·숨기기
//   PUT    /api/live/:eid/full       저장한 소재의 큰 이미지 올리기     PUT /api/live/:eid/svg  올린 SVG 원본 (?svg=1 로 받기)
//   (소재 갤러리에서 기존 소재를 올릴 때도 ?event=1 에 type:"upload", made(제작일) 로 기록해요)

const KEEP_DAYS = 30;
const MAX_IMG = 5 * 1024 * 1024;
const MAX_FULL = 2 * 1024 * 1024;
const MAX_BODY = 1500 * 1024;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const bin = (data, type, cache) => new Response(data, { headers: { "content-type": type || "image/png", "cache-control": cache || "public, max-age=31536000, immutable" } });
const notFound = () => new Response("not found", { status: 404 });
const clip = (v, n) => String(v || "").slice(0, n);
const okId = (v) => /^[a-z0-9-]{6,64}$/i.test(v || "");
const okHash = (v) => /^[a-f0-9]{64}$/.test(v || "");
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const imgType = (req) => { const t = (req.headers.get("content-type") || "").split(";")[0].trim(); return /^image\/(png|jpeg|webp)$/.test(t) ? t : ""; };
function jpegBytes(d) {
  if (typeof d !== "string" || !d.startsWith("data:image/jpeg;base64,")) return null;
  const s = atob(d.slice(23)), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/* ---------- storage ---------- */
let ready = false;
async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS items (ns TEXT NOT NULL, id TEXT NOT NULL, t INTEGER NOT NULL DEFAULT 0, meta TEXT, body TEXT, bin BLOB, PRIMARY KEY (ns, id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS items_ns_t ON items (ns, t)"),
  ]);
  ready = true;
}
const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
async function metaOf(db, ns, id) { const r = await db.prepare("SELECT meta FROM items WHERE ns=? AND id=?").bind(ns, id).first(); return r ? parse(r.meta) : null; }
async function listMeta(db, ns, since = 0, limit = 5000) {
  const { results } = await db.prepare("SELECT id, meta FROM items WHERE ns=? AND t>? ORDER BY t DESC LIMIT ?").bind(ns, since, limit).all();
  return results.map((r) => ({ id: r.id, ...parse(r.meta) }));
}
function put(db, ns, id, t, meta, body = null, blob = null) {
  return db.prepare("INSERT INTO items (ns,id,t,meta,body,bin) VALUES (?,?,?,?,?,?) ON CONFLICT(ns,id) DO UPDATE SET t=excluded.t, meta=excluded.meta, body=COALESCE(excluded.body, items.body), bin=COALESCE(excluded.bin, items.bin)")
    .bind(ns, id, t, JSON.stringify(meta), body, blob).run();
}
const del = (db, ns, id) => db.prepare("DELETE FROM items WHERE ns=? AND id=?").bind(ns, id).run();
async function file(env, key, cache) {
  const e = await env.FILES.getWithMetadata(key, { type: "arrayBuffer" });
  if (!e || !e.value) return notFound();
  return bin(e.value, e.metadata && e.metadata.type, cache);
}
// content-addressed images: stored once, shared by works, live view and the gallery
async function putHashed(env, req, hash) {
  if (!okHash(hash)) return json({ code: "bad_request" }, 400);
  const type = imgType(req); if (!type) return json({ code: "bad_type" }, 415);
  if (!(await metaOf(env.DB, "img", hash))) {
    const data = await req.arrayBuffer();
    if (!data.byteLength) return json({ code: "empty" }, 400);
    if (data.byteLength > MAX_IMG) return json({ code: "too_large" }, 413);
    await env.FILES.put("img/" + hash, data, { metadata: { type } });
    await put(env.DB, "img", hash, Date.now(), { type, size: data.byteLength });
  }
  return json({ ok: true });
}

/* ---------- 라이브러리 ---------- */
async function library(req, env, id, password) {
  const db = env.DB;
  if (req.method === "GET" && !id) {
    const items = await listMeta(db, "lib");
    return json({ ok: true, needsPassword: Boolean(password), items });
  }
  if (req.method === "GET") return file(env, "lib/" + id);
  if (password && req.headers.get("x-team-password") !== password) return json({ code: "bad_password" }, 401);
  if (req.method === "POST" && !id) {
    const url = new URL(req.url), type = imgType(req);
    if (!type) return json({ code: "bad_type" }, 415);
    const data = await req.arrayBuffer();
    if (!data.byteLength) return json({ code: "empty" }, 400);
    if (data.byteLength > MAX_IMG) return json({ code: "too_large" }, 413);
    const nid = newId(), now = Date.now();
    const item = {
      name: clip(url.searchParams.get("name") || "이미지", 60),
      kind: url.searchParams.get("kind") === "logo" ? "logo" : "product",
      mono: url.searchParams.get("mono") === "1",
      light: url.searchParams.get("light") === "1",
      added: now, type,
    };
    await env.FILES.put("lib/" + nid, data, { metadata: { type } });
    await put(db, "lib", nid, now, item);
    return json({ ok: true, item: { id: nid, ...item } });
  }
  if (req.method === "DELETE" && id) {
    await del(db, "lib", id); await env.FILES.delete("lib/" + id);
    return json({ ok: true });
  }
  return json({ code: "bad_request" }, 400);
}

/* ---------- 팀 작업함 ---------- */
async function works(req, env, id, password) {
  const db = env.DB, url = new URL(req.url);
  if (req.method === "GET" && !id) return json({ ok: true, needsPassword: Boolean(password), items: await listMeta(db, "work") });
  if (req.method === "GET") {
    if (url.searchParams.get("thumb")) {
      const r = await db.prepare("SELECT bin FROM items WHERE ns='work' AND id=?").bind(id).first();
      return r && r.bin ? bin(new Uint8Array(r.bin), "image/jpeg", "no-cache") : file(env, "wt/" + id, "no-cache");
    }
    const r = await db.prepare("SELECT body FROM items WHERE ns='work' AND id=?").bind(id).first();
    return r ? new Response(r.body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }) : json({ code: "not_found" }, 404);
  }
  if (password && req.headers.get("x-team-password") !== password) return json({ code: "bad_password" }, 401);
  if ((req.method === "POST" && !id) || (req.method === "PUT" && id)) {
    const text = await req.text();
    if (text.length > MAX_BODY + 400 * 1024) return json({ code: "too_large" }, 413);
    let body; try { body = JSON.parse(text); } catch { return json({ code: "bad_request" }, 400); }
    if (!body || body.format !== "banner-studio-team-work" || typeof body.state !== "string") return json({ code: "bad_request" }, 400);
    const wid = id || newId(), now = Date.now();
    const meta = { name: clip(body.name || "이름 없는 작업", 60), author: clip(body.author, 30), size: clip(body.size, 12), updated: now };
    const thumb = jpegBytes(body.thumb); delete body.thumb;
    const out = JSON.stringify(body);
    if (out.length > MAX_BODY) return json({ code: "too_large" }, 413);
    // the thumbnail lives next to the work in D1 (auto-save rewrites it often; KV allows few writes a day)
    await put(db, "work", wid, now, meta, out, thumb && thumb.length < 400 * 1024 ? thumb : null);
    return json({ ok: true, item: { id: wid, ...meta } });
  }
  if (req.method === "DELETE" && id) {
    await del(db, "work", id); await env.FILES.delete("wt/" + id);
    return json({ ok: true });
  }
  return json({ code: "bad_request" }, 400);
}

/* ---------- 팀 현황 · 소재 갤러리 ---------- */
async function live(req, env, id, sub, password) {
  const db = env.DB, url = new URL(req.url), q = (k) => url.searchParams.get(k);

  if (req.method === "GET" && !id) {
    if (q("gallery")) {
      const [events, marks] = await Promise.all([listMeta(db, "ev"), listMeta(db, "mark")]);
      return json({ ok: true, now: Date.now(), events, marks: Object.fromEntries(marks.map((m) => [m.id, m])) });
    }
    const since = Date.now() - KEEP_DAYS * 864e5;
    const [sessions, pings, events] = await Promise.all([listMeta(db, "sess", since), listMeta(db, "ping", since), listMeta(db, "ev", since, 300)]);
    const ping = Object.fromEntries(pings.map((p) => [p.id, p.updated]));
    sessions.forEach((s) => { s.seen = Math.max(s.updated || 0, ping[s.id] || 0); });
    sessions.sort((a, b) => b.seen - a.seen);
    return json({ ok: true, now: Date.now(), sessions, events });
  }

  if (req.method === "GET") {
    const isEv = id.startsWith("e-");
    if (q("full")) { const r = await file(env, "ef/" + id, "public, max-age=86400"); return r.status === 404 ? file(env, "et/" + id) : r; }
    if (q("svg")) return file(env, "esvg/" + id, "public, max-age=86400");
    if (q("thumb")) {
      if (isEv) return file(env, "et/" + id);
      const r = await db.prepare("SELECT bin FROM items WHERE ns='sess' AND id=?").bind(id).first();
      return r && r.bin ? bin(new Uint8Array(r.bin), "image/jpeg", "no-cache") : notFound();
    }
    if (q("ev")) {
      const r = await db.prepare("SELECT meta, body FROM items WHERE ns='ev' AND id=?").bind(id).first();
      if (!r || !r.body) return json({ code: "not_found" }, 404);
      return json({ ok: true, meta: parse(r.meta), ...parse(r.body) });
    }
    const r = await db.prepare("SELECT meta, body FROM items WHERE ns='sess' AND id=?").bind(id).first();
    if (!r) return json({ code: "not_found" }, 404);
    return json({ ok: true, meta: parse(r.meta), ...parse(r.body) });
  }

  // 갤러리에서 소재 삭제: 같은 소재의 저장 기록(버전) 전부와 이미지, 하트·메모까지 지워요
  if (req.method === "DELETE" && id) {
    if (password && req.headers.get("x-team-password") !== password) return json({ code: "bad_password" }, 401);
    if (!okId(id)) return json({ code: "bad_request" }, 400);
    const { results } = await db.prepare("SELECT id FROM items WHERE ns='ev' AND (id=? OR json_extract(meta,'$.cid')=?)").bind(id, id).all();
    await db.batch([
      db.prepare("DELETE FROM items WHERE ns='ev' AND (id=? OR json_extract(meta,'$.cid')=?)").bind(id, id),
      db.prepare("DELETE FROM items WHERE ns='mark' AND id=?").bind(id),
    ]);
    await Promise.all(results.flatMap((r) => ["et/", "ef/", "esvg/"].map((p) => env.FILES.delete(p + r.id).catch(() => {}))));
    return json({ ok: true, deleted: results.length });
  }

  // 갤러리에 올린 피그마 SVG 원본 (편집기에서 레이어로 다시 나눌 때 써요)
  if (req.method === "PUT" && id && sub === "svg") {
    const m = await metaOf(db, "ev", id);
    if (!m) return json({ code: "not_found" }, 404);
    if (m.svg) return json({ ok: true });
    const data = await req.arrayBuffer();
    if (!data.byteLength || data.byteLength > 20 * 1024 * 1024) return json({ code: "too_large" }, 413);
    await env.FILES.put("esvg/" + id, data, { metadata: { type: "image/svg+xml" } });
    await db.prepare("UPDATE items SET meta=? WHERE ns='ev' AND id=?").bind(JSON.stringify({ ...m, svg: true }), id).run();
    return json({ ok: true });
  }

  // 저장한 소재의 큰 이미지 (기록을 만든 직후 한 번만)
  if (req.method === "PUT" && id && sub === "full") {
    const m = await metaOf(db, "ev", id);
    if (!m) return json({ code: "not_found" }, 404);
    if (m.full) return json({ ok: true });
    if (imgType(req) !== "image/jpeg") return json({ code: "bad_type" }, 415);
    const data = await req.arrayBuffer();
    if (!data.byteLength || data.byteLength > MAX_FULL) return json({ code: "too_large" }, 413);
    await env.FILES.put("ef/" + id, data, { metadata: { type: "image/jpeg" } });
    await db.prepare("UPDATE items SET meta=? WHERE ns='ev' AND id=?").bind(JSON.stringify({ ...m, full: true }), id).run();
    return json({ ok: true });
  }

  if (req.method !== "POST" || id) return json({ code: "bad_request" }, 400);
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ code: "too_large" }, 413);
  let b; try { b = JSON.parse(text); } catch { return json({ code: "bad_request" }, 400); }
  const now = Date.now();

  if (q("fav")) {
    if (!b || !okId(b.key)) return json({ code: "bad_request" }, 400);
    const prev = (await metaOf(db, "mark", b.key)) || {};
    const next = { ...prev, time: now, by: clip(b.name, 30) || prev.by || "" };
    if ("fav" in b) { next.fav = !!b.fav; if (b.fav) next.favBy = next.by; }
    if ("memo" in b) next.memo = clip(b.memo, 300);
    if ("hidden" in b) next.hidden = !!b.hidden;
    await put(db, "mark", b.key, now, next);
    return json({ ok: true, mark: next });
  }

  if (!b || !okId(b.sid)) return json({ code: "bad_request" }, 400);
  const name = clip(b.name, 30) || "이름 없음";

  if (q("ping")) {
    await put(db, "ping", b.sid, now, { updated: now, name });
    return json({ ok: true });
  }

  const pm = (await metaOf(db, "sess", b.sid)) || null;

  if (q("event")) {
    const eid = "e-" + now.toString(36) + Math.random().toString(36).slice(2, 6);
    const ev = {
      sid: b.sid, name, type: clip(b.type, 8), tid: clip(b.tid, 16), size: clip(b.size, 12), headline: clip(b.headline, 40),
      title: clip(b.title, 40), cid: okId(b.cid) ? b.cid : "", tname: clip(b.tname, 24), time: now,
    };
    // 갤러리에 직접 올린 기존 소재: 제작일을 그대로 써요
    if (ev.type === "upload") { const made = Number(b.made); if (made > 1420070400000 && made <= now) ev.time = made; }
    const thumb = jpegBytes(b.thumb);
    if (thumb && thumb.length < 300 * 1024) await env.FILES.put("et/" + eid, thumb, { metadata: { type: "image/jpeg" } });
    const body = typeof b.state === "string" ? JSON.stringify({ state: b.state, imgs: b.imgs || null }) : null;
    await put(db, "ev", eid, ev.time, ev, body);
    if (pm) await db.prepare("UPDATE items SET meta=? WHERE ns='sess' AND id=?").bind(JSON.stringify({ ...pm, exports: (pm.exports || 0) + 1, updated: now, name }), b.sid).run();
    return json({ ok: true, id: eid });
  }

  if (typeof b.state !== "string") return json({ code: "bad_request" }, 400);
  const p = pm || {};
  const meta = {
    name, started: p.started || now, updated: now, edits: (p.edits || 0) + 1, exports: p.exports || 0,
    tid: clip(b.tid, 16), size: clip(b.size, 12), headline: clip(b.headline, 40),
  };
  const thumb = jpegBytes(b.thumb);
  await put(db, "sess", b.sid, now, meta, JSON.stringify({ state: b.state, imgs: b.imgs || null }), thumb && thumb.length < 200 * 1024 ? thumb : null);
  return json({ ok: true });
}

export async function onRequest({ request, env, params }) {
  if (!env.DB || !env.FILES) return json({ code: "not_configured", message: "DB(D1)와 FILES(KV) 연결이 필요해요" }, 503);
  await init(env.DB);
  const [area, id, sub] = (params.path || []).map((s) => decodeURIComponent(s));
  const password = env.TEAM_PASSWORD || "";
  try {
    if (area === "library") return await library(request, env, id, password);
    if (area === "works") return await works(request, env, id, password);
    if (area === "live") return await live(request, env, id, sub, password);
    if (area === "wimg" || area === "limg") {
      if (request.method === "GET") return okHash(id) ? await file(env, "img/" + id) : json({ code: "bad_request" }, 400);
      if (request.method === "PUT") {
        if (area === "wimg" && password && request.headers.get("x-team-password") !== password) return json({ code: "bad_password" }, 401);
        return await putHashed(env, request, id);
      }
    }
    return json({ code: "not_found" }, 404);
  } catch (e) {
    return json({ code: "server_error", message: String(e && e.message || e) }, 500);
  }
}
