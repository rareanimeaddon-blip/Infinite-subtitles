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

var http = require('http');
var engine = require('./engine');

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

module.exports = { handleRequest: handleRequest };

// Plain Node server (Northflank / Render / local). Only listens when this
// file is run directly — requiring it from api/index.js does not start it.
if (require.main === module) {
  var server = http.createServer(handleRequest);
  var port = parseInt(process.env.PORT, 10) || 3000;
  server.listen(port, function () {
    console.log('Infinite Streams Subtitles addon listening on port ' + port);
    console.log('Manifest: http://localhost:' + port + '/manifest.json');
  });
}
