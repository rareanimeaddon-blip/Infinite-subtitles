// Infinite Streams Subtitles — Vercel serverless entry (SELF-CONTAINED).
// All engine + handler code is inlined here so Vercel bundles a single
// file with no cross-directory requires. vercel.json rewrites every
// request to /api/index?__path=<original path>; this restores the
// original path and hands it to the shared handler.
'use strict';

// Infinite Streams Subtitles — shared subtitle engine.
// Reuses the proven provider logic from the Nuvio plugin's subtitle helper
// (test/subtitle_attach.js) and the XPass subtitle code, restructured for a
// Stremio-compatible subtitle addon: it returns a RANKED LIST of subtitles
// for a title (not one best pick per stream row), so the player can show
// the list and the user can pick — and the best one is first.
//
// Sources, in order of quality:
//   0. Sunsync (pre-synced, exact) — only for 4 titles, hardcoded IMDb map.
//   1. SubDL (api.subdl.com v2) — direct .srt via unpack_files[0].url.
//   2. Wyzie (sub.wyzie.io) — direct sub.wyzie.io/c/... links.
//   3. OpenSubtitles mirror (opensubtitles-v3.strem.io) — no key, no quota.
//
// Keys come from the caller (server reads env vars). They are never logged
// and never written to disk by this module.
'use strict';

var SD_API = 'https://api.subdl.com/api/v2/subtitles/search';
var SD_DL = 'https://dl.subdl.com';
var WZ_API = 'https://sub.wyzie.io/search';
var OS_MIRROR = 'https://opensubtitles-v3.strem.io';
var SUNSYNC_INDEX = 'https://raw.githubusercontent.com/rareanimeaddon-blip/Sunsync/main/index.json';
var SUNSYNC_BASE = 'https://raw.githubusercontent.com/rareanimeaddon-blip/Sunsync/main/';

// IMDb id -> TMDB id for the 4 Sunsync titles (avoids a TMDB lookup).
var SUNSYNC_IMDB = {
  'tt0133093': 603,     // The Matrix
  'tt12042730': 687163, // Project Hail Mary
  'tt1375666': 27205,   // Inception
  'tt0903747': 1396     // Breaking Bad
};

// ---- release-name parsing / scoring (from the plugin helper) ----
function osTokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(function (t) { return t.length > 0; });
}
function osGroup(name) {
  var s = String(name || '');
  var groups = s.match(/\(([^)]+)\)/g) || [];
  for (var gi = groups.length - 1; gi >= 0; gi--) {
    var g = groups[gi].replace(/[()]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s*4khdhub\s*$/, '').trim();
    if (!g) continue;
    if (/^\d{4}$/.test(g) || /^\d+$/.test(g)) continue;
    return g;
  }
  var m = s.match(/[-.]([A-Za-z][A-Za-z0-9]{1,})\s*$/);
  if (m) return m[1].toLowerCase();
  return '';
}
function osReleaseFeatures(name) {
  var toks = osTokens(name);
  var set = {};
  for (var i = 0; i < toks.length; i++) set[toks[i]] = true;
  var squashed = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  var source = '';
  if (squashed.indexOf('bluray') !== -1) source = 'bluray';
  else if (squashed.indexOf('webdl') !== -1) source = 'webdl';
  else if (squashed.indexOf('webrip') !== -1) source = 'webrip';
  else if (squashed.indexOf('hdtv') !== -1) source = 'hdtv';
  else if (squashed.indexOf('dvdrip') !== -1) source = 'dvdrip';
  else if (set['ts'] || set['telesync']) source = 'ts';
  return {
    group: osGroup(name),
    source: source,
    res: set['2160p'] ? '2160p' : set['1080p'] ? '1080p' : set['720p'] ? '720p' : set['480p'] ? '480p' : '',
    codec: (set['x265'] || set['hevc'] || squashed.indexOf('h265') !== -1) ? 'hevc' : (set['x264'] || set['avc'] || squashed.indexOf('h264') !== -1) ? 'avc' : '',
    imax: !!set['imax'],
    remux: !!set['remux']
  };
}

// Quality score for ranking a subtitle list (no target release to match
// against — the player shows the list and the user picks). Higher = better.
function qualityScore(sub) {
  var f = osReleaseFeatures(sub.release || '');
  var s = 0;
  if (sub.format === 'srt' || sub.format === 'vtt') s += 2;
  if (!sub.hi) s += 1;
  if (f.source === 'bluray') s += 3;
  else if (f.source === 'webdl') s += 2;
  else if (f.source === 'webrip') s += 1;
  if (f.res === '2160p') s += 2;
  else if (f.res === '1080p') s += 1;
  if (f.group) s += 1;
  if (typeof sub.downloadCount === 'number' && sub.downloadCount > 0) {
    s += Math.min(3, Math.floor(Math.log10(sub.downloadCount + 1)));
  }
  return s;
}

function osStripApiKey(u) {
  try {
    var s = String(u || '');
    var k = s.indexOf('api_key=');
    if (k === -1) return s;
    var start = k;
    if (start > 0 && (s.charAt(start - 1) === '?' || s.charAt(start - 1) === '&')) start--;
    var end = s.indexOf('&', k);
    var tail = (end === -1) ? '' : s.slice(end + 1);
    var head = s.slice(0, start);
    if (tail && head.charAt(head.length - 1) !== '?' && head.charAt(head.length - 1) !== '&') head += (head.indexOf('?') === -1 ? '?' : '&');
    return head + tail;
  } catch (e) { return String(u || ''); }
}

// ---- Sunsync (pre-synced subtitles, 4 titles) ----
var _sunsyncIndex = null;
var _sunsyncPromise = null;
function loadSunsyncIndex() {
  if (_sunsyncIndex) return Promise.resolve(_sunsyncIndex);
  if (_sunsyncPromise) return _sunsyncPromise;
  _sunsyncPromise = fetch(SUNSYNC_INDEX).then(function (r) {
    return (r && r.ok) ? r.json() : null;
  }).then(function (j) {
    _sunsyncIndex = j || {};
    return _sunsyncIndex;
  }).catch(function () { _sunsyncIndex = {}; return _sunsyncIndex; });
  return _sunsyncPromise;
}
function sunsyncSub(imdbId, isSeries, season, episode) {
  var tmdbId = SUNSYNC_IMDB[imdbId];
  if (!tmdbId) return Promise.resolve(null);
  var key = isSeries
    ? tmdbId + ':s' + season + 'e' + episode + ':en'
    : tmdbId + ':en';
  return loadSunsyncIndex().then(function (idx) {
    var entry = idx && idx[key];
    if (!entry || !entry.file) return null;
    return {
      id: 'sunsync-' + key.replace(/:/g, '-'),
      url: SUNSYNC_BASE + entry.file,
      lang: 'en',
      release: 'Sunsync pre-synced',
      source: 'sunsync',
      format: 'srt',
      hi: false
    };
  }).catch(function () { return null; });
}

// ---- SubDL ----
function sdSearchSubs(imdbId, isSeries, season, episode, keys) {
  if (!keys || !keys.length) return Promise.resolve([]);
  var u = SD_API + '?imdb_id=' + encodeURIComponent(imdbId) + '&languages=en';
  if (isSeries) u += '&type=tv&season_number=' + season + '&episode_number=' + episode;
  else u += '&type=movie';
  var idx = 0;
  var attempt = function () {
    if (idx >= keys.length) return Promise.resolve([]);
    var key = keys[idx++];
    return fetch(u, { headers: { 'Authorization': 'Bearer ' + key } }).then(function (r) {
      if (!r.ok) return attempt();
      return r.json().then(function (j) {
        var list = (j && j.subtitles) || [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var it = list[i] || {};
          if (String(it.language || '').toLowerCase() !== 'en') continue;
          var rel = it.release_name || '';
          if (!rel) continue;
          var direct = '';
          try {
            var uf = it.unpack_files;
            if (Array.isArray(uf)) {
              for (var k = 0; k < uf.length; k++) {
                var f = uf[k] || {};
                var fname = String(f.name || '').toLowerCase();
                var fmt = String(f.format || '').toLowerCase();
                if (f.url && (fmt === 'srt' || fname.indexOf('.srt') !== -1)) { direct = f.url; break; }
                if (f.url && !direct) direct = f.url;
              }
            }
          } catch (e) {}
          if (!direct) continue;
          var cleanUrl = osStripApiKey(SD_DL + direct);
          var sid = it.id ? String(it.id) : ('sd-' + cleanUrl.split('/').pop().split('?')[0]);
          out.push({ id: sid, url: cleanUrl, release: rel, source: 'subdl', format: 'srt', hi: false });
        }
        if (!out.length) return attempt();
        return out;
      }).catch(function () { return attempt(); });
    }).catch(function () { return attempt(); });
  };
  return attempt();
}

// ---- Wyzie ----
function wzSearchSubs(imdbId, isSeries, season, episode, keys) {
  if (!keys || !keys.length) return Promise.resolve([]);
  var u = WZ_API + '?id=' + encodeURIComponent(imdbId) + '&language=en';
  if (isSeries) u += '&season=' + season + '&episode=' + episode;
  var idx = 0;
  var attempt = function () {
    if (idx >= keys.length) return Promise.resolve([]);
    var key = keys[idx++];
    return fetch(u + '&key=' + encodeURIComponent(key)).then(function (r) {
      if (!r.ok) return attempt();
      return r.json().then(function (j) {
        var list = Array.isArray(j) ? j : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var it = list[i] || {};
          if (it.ai) continue;
          var lang = String(it.language || '').toLowerCase();
          if (lang !== 'en' && lang !== 'eng') continue;
          var url = it.url || '';
          if (url.indexOf('https://sub.wyzie.io/') !== 0) continue;
          var rel = it.release || '';
          var rels = Array.isArray(it.releases) ? it.releases : [];
          if (!rel && !rels.length) continue;
          var dc = 0;
          try { if (typeof it.downloadCount === 'number') dc = it.downloadCount; } catch (e) {}
          out.push({
            id: String(it.id),
            url: url,
            release: rel || rels[0] || '',
            source: 'wyzie',
            format: String(it.format || '').toLowerCase(),
            hi: !!it.isHearingImpaired,
            downloadCount: dc
          });
        }
        if (!out.length) return attempt();
        return out;
      }).catch(function () { return attempt(); });
    }).catch(function () { return attempt(); });
  };
  return attempt();
}

// ---- OpenSubtitles mirror ----
function osMirrorSubs(imdbId, isSeries, season, episode) {
  var path = isSeries
    ? '/subtitles/series/' + imdbId + ':' + season + ':' + episode + '.json'
    : '/subtitles/movie/' + imdbId + '.json';
  return fetch(OS_MIRROR + path).then(function (r) {
    if (!r.ok) return [];
    return r.json();
  }).then(function (j) {
    var list = (j && j.subtitles) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      var lang = String(it.lang || '').toLowerCase();
      if (lang !== 'eng' && lang !== 'en') continue;
      var url = it.url || '';
      if (url.indexOf('https://') !== 0) continue;
      var host = '';
      try { host = new URL(url).hostname; } catch (e) {}
      if (host.indexOf('strem.io') === -1) continue;
      var rel = it.movieReleaseName || it.subtitleFileName || '';
      if (!rel) continue;
      out.push({ id: String(it.id), url: url, release: rel, source: 'mirror', format: 'srt', hi: false });
    }
    return out;
  }).catch(function () { return []; });
}

// Does a subtitle's release name refer to the requested episode?
// SubDL/Wyzie return series-wide results (season packs, other seasons),
// so for TV we must keep only subtitles that name this episode.
// The mirror endpoint is already episode-specific by URL and Sunsync by
// index key, so this filter only applies to SubDL + Wyzie.
function episodeMatches(release, season, episode) {
  var orig = String(release || '').toLowerCase();
  var norm = orig.replace(/[^a-z0-9]+/g, '');
  var se = 's' + String(season).padStart(2, '0') + 'e' + String(episode).padStart(2, '0');
  var se2 = 's' + season + 'e' + episode;
  var x = season + 'x' + String(episode).padStart(2, '0');
  var x2 = season + 'x' + episode;
  // (?!\d) so S01E01 does not match S01E010, and S1E1 does not match S1E10.
  var pat = new RegExp('(?:' + se + '|' + se2 + '|' + x + '|' + x2 + ')(?!\\d)');
  if (pat.test(norm)) return true;
  var pat2 = new RegExp('season\\s*0*' + season + '\\b.{0,30}?episode\\s*0*' + episode + '\\b');
  if (pat2.test(orig)) return true;
  return false;
}

// ---- main search: ranked, deduplicated list ----
// opts: { imdbId, type ('movie'|'series'|'anime'), season, episode,
//         subdlKeys: [], wyzieKeys: [] }
// Returns: [{ id, url, lang, release, source, format, hi, score }]
var _cache = new Map();
var CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
function searchSubtitles(opts) {
  var imdbId = String(opts.imdbId || '').trim();
  if (!/^tt\d+$/.test(imdbId)) return Promise.resolve([]);
  var type = String(opts.type || 'movie').toLowerCase();
  var isSeries = (type === 'series' || type === 'anime');
  var season = parseInt(opts.season, 10) || 1;
  var episode = parseInt(opts.episode, 10) || 1;
  var cacheKey = imdbId + '|' + (isSeries ? (season + ':' + episode) : 'movie');
  var cached = _cache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) return Promise.resolve(cached.list);

  var jobs = [
    sunsyncSub(imdbId, isSeries, season, episode),
    sdSearchSubs(imdbId, isSeries, season, episode, opts.subdlKeys || []),
    wzSearchSubs(imdbId, isSeries, season, episode, opts.wyzieKeys || []),
    osMirrorSubs(imdbId, isSeries, season, episode)
  ];
  return Promise.all(jobs.map(function (p) { return p.catch(function () { return null; }); })).then(function (results) {
    var all = [];
    var seenUrl = {};
    var push = function (sub, sourceRank) {
      if (!sub || !sub.url) return;
      var url = String(sub.url);
      if (seenUrl[url]) return;
      seenUrl[url] = true;
      sub.lang = 'en';
      sub.score = qualityScore(sub) + (sourceRank || 0);
      all.push(sub);
    };
    // Sunsync first (pre-synced, exact) — big rank bonus so it stays on top.
    // Mirror is episode-specific by URL; SubDL/Wyzie are filtered to this
    // episode for series so season packs / other seasons never rank.
    var sdList = results[1] || [];
    var wzList = results[2] || [];
    if (isSeries) {
      sdList = sdList.filter(function (s) { return episodeMatches(s.release, season, episode); });
      wzList = wzList.filter(function (s) { return episodeMatches(s.release, season, episode); });
    }
    if (results[0]) push(results[0], 20);
    sdList.forEach(function (s) { push(s, 6); });
    wzList.forEach(function (s) { push(s, 4); });
    (results[3] || []).forEach(function (s) { push(s, 0); });
    // If the episode filter emptied everything (providers only returned
    // packs), fall back to the unfiltered ranked list so the user still
    // gets options to pick from instead of nothing.
    if (!all.length) {
      (results[1] || []).forEach(function (s) { push(s, 6); });
      (results[2] || []).forEach(function (s) { push(s, 4); });
      (results[3] || []).forEach(function (s) { push(s, 0); });
    }
    all.sort(function (a, b) { return b.score - a.score; });
    // Cap the list so the player gets a usable set, not hundreds.
    var list = all.slice(0, 30);
    _cache.set(cacheKey, { at: Date.now(), list: list });
    return list;
  });
}



// ---- engine handle (the inlined engine functions above) ----
var engine = { searchSubtitles: searchSubtitles, qualityScore: qualityScore, osReleaseFeatures: osReleaseFeatures };

// Infinite Streams Subtitles — Stremio-compatible subtitle addon server.
// No dependencies: built-in http only. Node 18+ (global fetch).
//
// How keys work (per-user, saved in the manifest link):
//   1. Each user opens the landing page (/) and enters their OWN SubDL and
//      Wyzie API keys (free keys from subdl.com / wyzie.io).
//   2. The page encodes those keys into a config string and gives them a
//      personal manifest link: https://<host>/<config>/manifest.json
//   3. They paste that link into Nuvio / Stremio. Every subtitle request
//      carries the config in the URL, so each user uses their own keys.
//   No keys are stored on the server. Env vars (SUBDL_API_KEY etc.) are an
//   optional server-side fallback for the host operator.
//   The manifest link contains the keys — keep it private.
//
// Endpoints:
//   GET /                              (landing page + key setup form)
//   GET /manifest.json                 (no-config manifest)
//   GET /<config>/manifest.json        (configured manifest)
//   GET /subtitles/:type/:id.json
//   GET /<config>/subtitles/:type/:id.json
//   GET /subtitles/:type/:id/:extra.json
// Port via PORT (default 3000).
'use strict';

var ADDON_ID = 'com.infinite.streams.subtitles';
var ADDON_VERSION = '1.1.0';

function manifest() {
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: 'Infinite Streams Subtitles',
    description: 'Subtitles for Infinite Streams — SubDL, Wyzie and OpenSubtitles, ranked with the best first. Works in Nuvio and Stremio.',
    resources: ['subtitles'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: false }
  };
}

// ---- per-user config: keys encoded in the manifest URL ----
function b64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  var b = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return Buffer.from(b, 'base64').toString('utf8');
}
function encodeConfig(k) {
  var o = {};
  if (k.subdlKeys[0]) o.s = k.subdlKeys[0];
  if (k.subdlKeys[1]) o.s2 = k.subdlKeys[1];
  if (k.wyzieKeys[0]) o.w = k.wyzieKeys[0];
  if (k.wyzieKeys[1]) o.w2 = k.wyzieKeys[1];
  return b64urlEncode(JSON.stringify(o));
}
function decodeConfig(str) {
  try {
    var o = JSON.parse(b64urlDecode(str));
    var subdl = [], wyzie = [];
    if (typeof o.s === 'string' && o.s.trim()) subdl.push(o.s.trim());
    if (typeof o.s2 === 'string' && o.s2.trim() && o.s2.trim() !== (o.s || '').trim()) subdl.push(o.s2.trim());
    if (typeof o.w === 'string' && o.w.trim()) wyzie.push(o.w.trim());
    if (typeof o.w2 === 'string' && o.w2.trim() && o.w2.trim() !== (o.w || '').trim()) wyzie.push(o.w2.trim());
    return { subdlKeys: subdl, wyzieKeys: wyzie };
  } catch (e) { return { subdlKeys: [], wyzieKeys: [] }; }
}

function keysFromEnv() {
  var subdl = [];
  var wyzie = [];
  if (process.env.SUBDL_API_KEY) subdl.push(String(process.env.SUBDL_API_KEY).trim());
  if (process.env.SUBDL_API_KEY2 && process.env.SUBDL_API_KEY2 !== process.env.SUBDL_API_KEY) subdl.push(String(process.env.SUBDL_API_KEY2).trim());
  if (process.env.WYZIE_API_KEY) wyzie.push(String(process.env.WYZIE_API_KEY).trim());
  if (process.env.WYZIE_API_KEY2 && process.env.WYZIE_API_KEY2 !== process.env.WYZIE_API_KEY) wyzie.push(String(process.env.WYZIE_API_KEY2).trim());
  return { subdlKeys: subdl, wyzieKeys: wyzie };
}

// Config keys first (the user's own), env keys as fallback.
function getKeys(config) {
  var env = keysFromEnv();
  var subdl = (config ? config.subdlKeys : []).concat(env.subdlKeys);
  var wyzie = (config ? config.wyzieKeys : []).concat(env.wyzieKeys);
  subdl = subdl.filter(function (v, i, a) { return a.indexOf(v) === i; });
  wyzie = wyzie.filter(function (v, i, a) { return a.indexOf(v) === i; });
  return { subdlKeys: subdl, wyzieKeys: wyzie };
}

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  });
  res.end(body);
}

// Split a pathname into an optional config segment and the rest.
//   /manifest.json              -> { config: null, rest: '/manifest.json' }
//   /<config>/manifest.json     -> { config: '<config>', rest: '/manifest.json' }
//   /subtitles/...              -> { config: null, rest: '/subtitles/...' }
//   /<config>/subtitles/...     -> { config: '<config>', rest: '/subtitles/...' }
//   /                           -> { config: null, rest: '/' }
//   /<config>                   -> { config: '<config>', rest: '/' }
function splitConfig(pathname) {
  var segs = pathname.split('/').filter(function (s) { return s.length > 0; });
  if (segs.length === 0) return { config: null, rest: '/' };
  if (segs[0] === 'manifest.json' || segs[0] === 'subtitles') return { config: null, rest: pathname };
  if (segs.length === 1) return { config: segs[0], rest: '/' };
  if (segs[1] === 'manifest.json' || segs[1] === 'subtitles') return { config: segs[0], rest: '/' + segs.slice(1).join('/') };
  return { config: null, rest: pathname };
}

function parseSubtitlesPath(pathname) {
  // /subtitles/movie/tt12042730.json
  // /subtitles/series/tt0903747:1:1.json
  // /subtitles/anime/tt1234567:1:1.json
  // /subtitles/movie/tt12042730/<extra>.json
  var m = pathname.match(/^\/subtitles\/([^\/]+)\/([^\/]+)(?:\/[^\/]+)?\.json$/);
  if (!m) return null;
  var type = m[1].toLowerCase();
  if (type !== 'movie' && type !== 'series' && type !== 'anime') return null;
  var rawId = decodeURIComponent(m[2]);
  var parts = rawId.split(':');
  var imdbId = parts[0];
  if (!/^tt\d+$/.test(imdbId)) return null;
  var season = 1, episode = 1;
  if (parts.length >= 3) {
    season = parseInt(parts[1], 10) || 1;
    episode = parseInt(parts[2], 10) || 1;
  }
  return { type: type, imdbId: imdbId, season: season, episode: episode };
}

function landingPage(origin, configStr) {
  var pre = configStr ? ('<p>Your configured manifest link:</p><p><code id="cfgLink">' + origin + '/' + configStr + '/manifest.json</code></p><p><button onclick="copyLink()">Copy manifest link</button></p>') : '';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Infinite Streams Subtitles</title></head>'
    + '<body style="font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 16px">'
    + '<h1>Infinite Streams Subtitles</h1>'
    + '<p>A subtitle addon for Nuvio and Stremio. It searches SubDL, Wyzie and OpenSubtitles and returns the best subtitles first.</p>'
    + '<h2>Set up your own API keys</h2>'
    + '<p>Each user sets up their own keys. Get free keys: <a href="https://subdl.com" target="_blank" rel="noopener">SubDL</a> (2000 searches/day) and <a href="https://wyzie.io" target="_blank" rel="noopener">Wyzie</a> (1000 requests/day). Your keys are saved in your manifest link only — nothing is stored on this server.</p>'
    + '<label>SubDL API key<br><input id="s" type="password" style="width:100%" placeholder="SubDL key"></label><br><br>'
    + '<label>SubDL API key 2 (optional)<br><input id="s2" type="password" style="width:100%" placeholder="Second SubDL key"></label><br><br>'
    + '<label>Wyzie API key<br><input id="w" type="password" style="width:100%" placeholder="Wyzie key"></label><br><br>'
    + '<label>Wyzie API key 2 (optional)<br><input id="w2" type="password" style="width:100%" placeholder="Second Wyzie key"></label><br><br>'
    + '<button onclick="makeLink()">Get my manifest link</button>'
    + '<div id="out">' + pre + '</div>'
    + '<p style="color:#666">Keep your manifest link private — it contains your keys, and anyone with it can use them.</p>'
    + '<p><a href="/manifest.json">View manifest.json</a> (no keys — OpenSubtitles + pre-synced only)</p>'
    + '<script>'
    + 'function enc(o){var s=JSON.stringify(o);return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");}'
    + 'function makeLink(){var o={};var s=document.getElementById("s").value.trim();var s2=document.getElementById("s2").value.trim();var w=document.getElementById("w").value.trim();var w2=document.getElementById("w2").value.trim();if(s)o.s=s;if(s2&&s2!==s)o.s2=s2;if(w)o.w=w;if(w2&&w2!==w)o.w2=w2;var cfg=enc(o);var url=location.origin+"/"+cfg+"/manifest.json";document.getElementById("out").innerHTML="<p>Your manifest link:</p><p><code id=\\"cfgLink\\">"+url+"</code></p><p><button onclick=\\"copyLink()\\">Copy manifest link</button></p><p>Paste this link in Nuvio / Stremio under Addons to install it.</p>";}'
    + 'function copyLink(){var t=document.getElementById("cfgLink");if(!t)return;var r=document.createRange();r.selectNode(t);var sel=getSelection();sel.removeAllRanges();sel.addRange(r);try{document.execCommand("copy");}catch(e){}sel.removeAllRanges();}'
    + '</script>'
    + '</body></html>';
}

// Shared request handler — used by the plain Node server below and by
// the Vercel serverless function in api/index.js.
function handleRequest(req, res) {
  try {
    var u = new URL(req.url, 'http://localhost');
    var pathname = u.pathname;
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }

    var split = splitConfig(pathname);
    var config = split.config ? decodeConfig(split.config) : null;
    var rest = split.rest;

    if (rest === '/manifest.json') { sendJson(res, 200, manifest()); return; }

    if (rest === '/' || rest === '/index.html') {
      var origin = (req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(landingPage(origin, split.config));
      return;
    }

    if (rest.indexOf('/subtitles/') === 0) {
      var parsed = parseSubtitlesPath(rest);
      if (!parsed) { sendJson(res, 404, { subtitles: [] }); return; }
      var k = getKeys(config);
      engine.searchSubtitles({
        imdbId: parsed.imdbId,
        type: parsed.type,
        season: parsed.season,
        episode: parsed.episode,
        subdlKeys: k.subdlKeys,
        wyzieKeys: k.wyzieKeys
      }).then(function (list) {
        var out = list.map(function (s) {
          return {
            id: String(s.id),
            url: s.url,
            lang: 'en',
            movieReleaseName: s.release || undefined,
            subtitleFileName: s.release || undefined
          };
        });
        sendJson(res, 200, { subtitles: out });
      }).catch(function () {
        sendJson(res, 200, { subtitles: [] });
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { subtitles: [] });
  }
}


// Plain Node server (Northflank / Render / local). Only listens when this
// file is run directly — requiring it from api/index.js does not start it.


// ---- Vercel handler ----
module.exports = function (req, res) {
  try {
    var u = new URL(req.url, 'http://localhost');
    var orig = u.searchParams.get('__path');
    if (orig !== null && orig !== undefined) {
      var p = '/' + String(orig);
      try { p = decodeURIComponent(p); } catch (e) { /* keep as-is */ }
      req.url = p;
    }
    handleRequest(req, res);
  } catch (e) {
    try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ subtitles: [] })); } catch (e2) {}
  }
};
