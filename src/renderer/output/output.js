/**
 * Output renderer. Shows whichever source the main process tells it to, cropped
 * to the source's region and scaled to fill this window (letterboxed). This is
 * the window the user shares in their meeting.
 *
 * Switching sources can be animated: a "layer" holds one live capture, and when
 * a new source arrives we keep the outgoing layer on screen and composite it
 * with the incoming one over `transition.duration` ms (crossfade or slide),
 * then promote the incoming layer to be the current one.
 */

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const placeholder = document.getElementById('placeholder');
const banner = document.getElementById('banner');

// A "layer" = { video, stream, crop }. `cur` is what's shown when idle; `anim`
// holds an in-flight transition between two layers.
let cur = null;
let anim = null;
let bannerTimer = null;

function fitCanvasToWindow() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
}
window.addEventListener('resize', fitCanvasToWindow);
fitCanvasToWindow();

function showBanner(text, isError = false) {
  banner.textContent = text;
  banner.classList.toggle('error', isError);
  banner.classList.remove('hidden');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => banner.classList.add('hidden'), 1600);
}

// --- Layer lifecycle -------------------------------------------------------

/** Start capturing a desktopCapturer source into a fresh, playing layer. */
async function startLayer(sourceId, crop) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 3840,
          maxHeight: 2160,
          maxFrameRate: 30,
        },
      },
    });
  } catch (err) {
    console.error('[output] getUserMedia failed:', err);
    return null;
  }
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play().catch(() => {});
  await waitForFirstFrame(video);
  return { video, stream, crop: crop || null };
}

/** Resolve once the video has a decodable frame (so we never animate from black). */
function waitForFirstFrame(video) {
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('loadeddata', done); resolve(); };
    video.addEventListener('loadeddata', done);
    setTimeout(done, 700); // fail-safe so a stubborn source can't hang the switch
  });
}

function stopLayer(layer) {
  if (layer && layer.stream) layer.stream.getTracks().forEach((t) => t.stop());
}

// --- Drawing ---------------------------------------------------------------

/** Draw one layer's cropped frame, optionally offset (slides) and faded (fade). */
function drawLayer(layer, { dx = 0, dy = 0, alpha = 1 } = {}) {
  const v = layer && layer.video;
  if (!v || v.readyState < 2) return;
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  if (!vw || !vh) return;

  const c = layer.crop;
  const sx = c ? Math.round(c.x * vw) : 0;
  const sy = c ? Math.round(c.y * vh) : 0;
  const sw = c ? Math.round(c.w * vw) : vw;
  const sh = c ? Math.round(c.h * vh) : vh;

  const cw = canvas.width;
  const ch = canvas.height;
  const scale = Math.min(cw / sw, ch / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const px = (cw - dw) / 2 + dx;
  const py = (ch - dh) / 2 + dy;

  ctx.globalAlpha = alpha;
  ctx.drawImage(v, sx, sy, sw, sh, px, py, dw, dh);
  ctx.globalAlpha = 1;
}

const EASINGS = {
  linear: (p) => p,
  'ease-in-out': (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
};

/** Composite the outgoing + incoming layers for transition progress p (0..1). */
function drawTransition(a, p) {
  const cw = canvas.width;
  const ch = canvas.height;
  const { prev, next, type } = a;
  switch (type) {
    case 'fade':
      drawLayer(prev, { alpha: 1 - p });
      drawLayer(next, { alpha: p });
      break;
    case 'slide-left':
      drawLayer(prev, { dx: -p * cw });
      drawLayer(next, { dx: (1 - p) * cw });
      break;
    case 'slide-right':
      drawLayer(prev, { dx: p * cw });
      drawLayer(next, { dx: -(1 - p) * cw });
      break;
    case 'slide-up':
      drawLayer(prev, { dy: -p * ch });
      drawLayer(next, { dy: (1 - p) * ch });
      break;
    case 'slide-down':
      drawLayer(prev, { dy: p * ch });
      drawLayer(next, { dy: -(1 - p) * ch });
      break;
    default:
      drawLayer(next);
  }
}

// One persistent render loop drives both live video and transitions.
function frame(now) {
  requestAnimationFrame(frame);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (anim) {
    const ease = EASINGS[anim.easing] || EASINGS.linear;
    let p = (now - anim.start) / anim.duration;
    if (p >= 1) p = 1;
    drawTransition(anim, ease(p));
    if (p >= 1) {
      stopLayer(anim.prev);
      cur = anim.next;
      anim = null;
    }
  } else if (cur) {
    drawLayer(cur);
  }
}
requestAnimationFrame(frame);

// --- Source switching ------------------------------------------------------

async function show({ sourceId, crop, name, transition }) {
  const incoming = await startLayer(sourceId, crop);
  if (!incoming) {
    placeholder.classList.remove('hidden');
    showBanner('Could not capture "' + (name || 'source') + '"', true);
    return;
  }

  placeholder.classList.add('hidden');

  // The currently visible layer becomes the outgoing one. If a transition is
  // already running, its target is the freshest visible layer; discard its old
  // source so rapid switching never leaks streams.
  let prev;
  if (anim) {
    stopLayer(anim.prev);
    prev = anim.next;
    anim = null;
  } else {
    prev = cur;
  }

  const t = transition || { type: 'none', duration: 0 };
  const animate = prev && t.type && t.type !== 'none' && t.duration > 0;

  if (!animate) {
    if (prev && prev !== incoming) stopLayer(prev);
    cur = incoming;
  } else {
    cur = null;
    anim = {
      prev,
      next: incoming,
      type: t.type,
      duration: t.duration,
      easing: t.easing || 'linear',
      start: performance.now(),
    };
  }
  showBanner(name || 'Source');
}

function unbound({ name }) {
  if (anim) { stopLayer(anim.prev); stopLayer(anim.next); anim = null; }
  stopLayer(cur);
  cur = null;
  placeholder.classList.remove('hidden');
  showBanner('"' + (name || 'source') + '" not found — rebind it in Control', true);
}

window.screendeck.onShow(show);
window.screendeck.onUnbound(unbound);
