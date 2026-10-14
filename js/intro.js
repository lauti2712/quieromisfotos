// Intro del sitio: la primera vez que alguien entra al inicio elige si busca sus fotos o es fotógrafo.
// No aparece si llega por un link directo (evento, perfil, pedido) ni si ya eligió antes.
import { $ } from './util.js';

const KEY = 'qmf.intro.v1';

function seen() {
  try { return !!localStorage.getItem(KEY); } catch { return false; }
}
function remember(choice) {
  try { localStorage.setItem(KEY, choice); } catch { /* modo privado */ }
}

export function maybeShowIntro() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash || seen() || new URLSearchParams(location.search).has('nointro')) return;
  showIntro();
}

export function showIntro() {
  const el = document.createElement('div');
  el.className = 'intro';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Bienvenida');
  el.innerHTML = `
    <div class="intro-flash" aria-hidden="true"></div>
    <div class="intro-glow" aria-hidden="true"></div>
    <div class="intro-content">
      <div class="intro-viewfinder" aria-hidden="true">
        <span class="c tl"></span><span class="c tr"></span><span class="c bl"></span><span class="c br"></span>
        <img src="assets/logo.svg" alt="" class="intro-logo">
        <span class="intro-rec"><i></i> REC</span>
      </div>
      <h1 class="intro-title">quiero<span>mis</span>fotos</h1>
      <p class="intro-sub">Encontrá tu foto. Reviví tu momento.</p>
      <div class="intro-choices">
        <button class="intro-card" data-choice="buscar">
          <span class="ic">🔍</span>
          <strong>Busco mis fotos</strong>
          <span>Encontrá las fotos de tu partido, carrera o evento y descargalas en alta calidad.</span>
        </button>
        <button class="intro-card" data-choice="fotografo">
          <span class="ic">📸</span>
          <strong>Soy fotógrafo</strong>
          <span>Vendé tus fotos, mostrá tu trabajo y conseguí nuevos clientes.</span>
        </button>
      </div>
      <button class="intro-skip" data-choice="buscar">Entrar al sitio</button>
    </div>`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';

  const close = () => {
    el.classList.add('out');
    document.body.style.overflow = '';
    setTimeout(() => el.remove(), 450);
  };
  el.querySelectorAll('[data-choice]').forEach(b => b.addEventListener('click', () => {
    remember(b.dataset.choice);
    if (b.dataset.choice === 'fotografo') { location.href = 'panel.html'; return; }
    close();
    setTimeout(() => $('#f-q')?.focus(), 500);
  }));
  el.addEventListener('keydown', e => { if (e.key === 'Escape') { remember('buscar'); close(); } });
  setTimeout(() => el.querySelector('.intro-card')?.focus({ preventScroll: true }), 1600);
}
