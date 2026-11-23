const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- reveal on view ---------- */
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.18 });
$$('.reveal').forEach((el) => io.observe(el));

/* ---------- story: words light up as you scroll ---------- */
const storyEl = $('#story-text');
const keyWords = new Set(['Smansa', 'Jalan', 'Merbabu', 'fasad', 'lobi', 'terbuka']);
storyEl.innerHTML = storyEl.textContent.trim().split(/\s+/).map((w) => `<span class="${keyWords.has(w.replace(/[.,]/g, '')) ? 'key' : ''}">${w}</span>`).join(' ');
const words = $$('span', storyEl);

/* ---------- scroll-driven scenes ---------- */
const hero = $('.hero'), story = $('#story'), gallery = $('#gallery'), track = $('#track'), finale = $('#finale');
const storyBar = $('#story-bar'), galBar = $('#gallery-bar');
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
function section(el) { const r = el.getBoundingClientRect(); const total = el.offsetHeight - innerHeight; return clamp(-r.top / total); }
let ticking = false;
function onScroll() {
  const y = scrollY;
  hero.style.setProperty('--p', clamp(y / innerHeight).toFixed(3));
  const sp = section(story); const lit = Math.floor(clamp(sp * 1.12) * words.length);
  words.forEach((w, i) => w.classList.toggle('lit', i < lit)); storyBar.style.width = sp * 100 + '%';
  const gp = section(gallery); const max = track.scrollWidth - innerWidth + innerWidth * 0.12;
  track.style.transform = `translate3d(${-gp * Math.max(0, max)}px,0,0)`; galBar.style.width = gp * 100 + '%';
  $$('.card', track).forEach((c, i) => { const img = $('img', c); img.style.transform = `translateY(${Math.sin((gp * 3 + i) * 1.4) * 14}px) scale(${1.02 + Math.abs(Math.sin(gp * 3 + i)) * .03})`; });
  const fr = finale.getBoundingClientRect(); finale.style.setProperty('--enter', clamp(1 - (fr.top - innerHeight * 0.1) / (innerHeight * 0.7)).toFixed(3));
  ticking = false;
}
addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
addEventListener('resize', onScroll); onScroll();

/* ---------- pop card tilt ---------- */
const pop = $('#pop');
pop.addEventListener('pointermove', (e) => {
  const r = pop.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
  pop.style.setProperty('--ry', (x * 14).toFixed(2) + 'deg'); pop.style.setProperty('--rx', (-y * 10).toFixed(2) + 'deg');
  pop.style.setProperty('--tx', (-x * 18).toFixed(1) + 'px'); pop.style.setProperty('--ty', (-y * 12).toFixed(1) + 'px');
});
pop.addEventListener('pointerleave', () => ['--rx', '--ry', '--tx', '--ty'].forEach((k) => pop.style.removeProperty(k)));

/* ---------- enter 3D ---------- */
let entering = false;
async function enter(x = innerWidth / 2, y = innerHeight / 2) {
  if (entering) return; entering = true;
  const curtain = $('#curtain'); curtain.style.setProperty('--cx', x + 'px'); curtain.style.setProperty('--cy', y + 'px'); curtain.classList.add('go');
  await new Promise((r) => setTimeout(r, 750));
  const loader = $('#loader'); loader.hidden = false; loader.classList.remove('done');
  document.body.classList.add('in3d'); scrollTo(0, 0);
  $('#app').hidden = false; curtain.classList.remove('go');
  const bar = $('#loader-bar'), msg = $('#loader-msg');
  try {
    await Promise.all(['800 60px "Bricolage Grotesque"', '600 40px Manrope', '800 40px Manrope', 'italic 600 40px Fraunces', '900 60px "Bricolage Grotesque"'].map((f) => document.fonts.load(f).catch(() => {})));
    const { startViewer } = await import('./viewer.js');
    await startViewer({
      onProgress: (p, m) => { bar.style.width = (p * 100).toFixed(0) + '%'; msg.textContent = m; },
      onReady: () => { loader.classList.add('done'); setTimeout(() => (loader.hidden = true), 900); },
    });
  } catch (err) {
    console.error(err); msg.textContent = 'Gagal memuat 3D: ' + (err && err.message ? err.message : err); bar.style.background = '#d4562a';
  }
}
$$('[data-enter]').forEach((b) => b.addEventListener('click', (e) => enter(e.clientX || innerWidth / 2, e.clientY || innerHeight / 2)));
$('#btn-home').addEventListener('click', () => { history.replaceState(null, '', location.pathname); location.reload(); });
if (location.hash === '#3d' || location.search.includes('enter')) enter();
