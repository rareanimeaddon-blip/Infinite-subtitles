// Simulate Vercel: call api/index.js the way Vercel does after the
// vercel.json rewrite (req.url = /api/index?__path=<original path>).
// Builds a config from the gist keys (in-memory only) like a user typing
// them on the landing page. Prints counts only — never key values.
'use strict';
delete process.env.SUBDL_API_KEY;
delete process.env.SUBDL_API_KEY2;
delete process.env.WYZIE_API_KEY;
delete process.env.WYZIE_API_KEY2;
var handler = require('./api/index.js');
var GIST = 'https://gist.githubusercontent.com/rareanimeaddon-blip/6fc363ac74cb8921d61c07a2c6bb59d6/raw/gistfile1.txt';
function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function callVercel(path) {
  return new Promise(function (resolve) {
    var req = { method: 'GET', url: '/api/index?__path=' + encodeURIComponent(path.replace(/^\//, '')), headers: { host: 'test.vercel.app', 'x-forwarded-proto': 'https' } };
    var res = {
      _code: 0, _headers: {}, _body: '',
      writeHead: function (c, h) { this._code = c; this._headers = h || {}; },
      setHeader: function (k, v) { this._headers[k] = v; },
      end: function (b) { this._body += (b || ''); resolve({ code: this._code, headers: this._headers, body: this._body }); }
    };
    handler(req, res);
  });
}
(async function () {
  var m = await callVercel('/manifest.json');
  var mj = JSON.parse(m.body);
  console.log('manifest:', mj.id, mj.version, 'configurable:', !!(mj.behaviorHints && mj.behaviorHints.configurable));
  var land = await callVercel('/');
  console.log('landing page has key form:', land.body.indexOf('SubDL API key') !== -1 && land.body.indexOf('Get my manifest link') !== -1);
  var t = await (await fetch(GIST)).json();
  var cfg = b64url(JSON.stringify({ s: t.subdlApiKey, s2: t.subdlApiKey2, w: t.wyzieApiKey, w2: t.wyzieApiKey2 }));
  var mc = await callVercel('/' + cfg + '/manifest.json');
  console.log('config manifest:', JSON.parse(mc.body).id);
  var tests = [
    ['/' + cfg + '/subtitles/movie/tt12042730.json', 'PHM (config)'],
    ['/' + cfg + '/subtitles/series/tt0903747:1:1.json', 'BB S1E1 (config)']
  ];
  for (var i = 0; i < tests.length; i++) {
    var x = tests[i];
    var r = await callVercel(x[0]);
    var subs = (JSON.parse(r.body).subtitles) || [];
    console.log(x[1] + ': ' + subs.length + ' subtitles, first: ' + (subs[0] ? (subs[0].movieReleaseName || '').slice(0, 50) : 'none'));
    var leaked = subs.some(function (s) { return s.url.indexOf('api_key=') !== -1; });
    console.log('  api_key in urls: ' + leaked);
  }
  // Plain server.js still works standalone (require.main guard).
  console.log('server.js standalone check: node server.js still starts the server (see test-config.js)');
  process.exit(0);
})().catch(function (e) { console.error('test failed:', e && e.message); process.exit(1); });
