// Página "Soy fotógrafo": explica cómo funciona la plataforma para fotógrafos, con animaciones.
import { $, $$, esc, fmtMoney } from './util.js';
import { loadSettings, DEFAULT_SETTINGS, planSpec, rulesFor, planFeatures, TRANSFER_FEATURE } from './data.js';
import { sellerNet } from './pricing.js';

// Fotos de la animación (Pexels, licencia libre): una disciplina por ciclo.
const SLIDES = [
  { img: 'demo/lp-futbol.jpg', n: 120, ev: 'Liga Amateur · Fecha 8', sold: 3, total: 6000 },
  { img: 'demo/lp-rugby.jpg', n: 340, ev: 'Torneo de Rugby · Semifinal', sold: 5, total: 8500 },
  { img: 'demo/lp-hockey.jpg', n: 210, ev: 'Hockey · Final Sub-16', sold: 4, total: 7600 },
  { img: 'demo/lp-running.jpg', n: 860, ev: 'Maratón 10K', sold: 2, total: 4000 },
];

const STEPS = [
  { ic: '📸', t: 'Subís las fotos', d: 'Desde la compu o el celular, de a cientos. Se ordenan solas por hora y las podés separar en sub-álbumes.' },
  { ic: '🪄', t: 'Nosotros las preparamos', d: 'Les ponemos la marca de agua, armamos la galería y guardamos los originales seguros. Vos no tocás nada.' },
  { ic: '🔗', t: 'Compartís el link', d: 'Un link por evento para el grupo del club, Instagram o WhatsApp. Se ve con la portada del evento.' },
  { ic: '💰', t: 'Cobrás directo', d: 'Cada venta entra a tu Mercado Pago. El comprador descarga sus fotos en alta calidad, sin marca, al instante.' },
];

const FEATURES = [
  { ic: '💲', t: 'Tus precios', d: 'Precio por foto y packs (ej: 5 fotos x $8.500). Al comprador se le aplica solo la combinación más barata.' },
  { ic: '📊', t: 'Ventas claras', d: 'Ves cuánto vendiste, cuánto te queda neto y qué álbumes venden más.' },
  { ic: '🔔', t: 'Aviso de cada venta', d: 'Te llega una notificación al celular cada vez que alguien compra.' },
  { ic: '🕒', t: 'Fácil de encontrar', d: 'Filtro por horario, favoritas y sub-álbumes: el que busca su foto la encuentra rápido y compra más.' },
  { ic: '👥', t: 'Seguidores', d: 'La gente puede seguirte y activar el aviso de un evento: cuando subís las fotos, les llega la notificación.' },
  { ic: '📅', t: 'Eventos futuros', d: 'Cargá el evento antes de que pase: aparece en el calendario y la gente ya puede pedir el aviso.' },
  { ic: '🖼️', t: 'Perfil y portfolio', d: 'Tu perfil con tu trabajo, tu equipo y un botón de WhatsApp para pedirte presupuesto.' },
  { ic: '🌐', t: 'Tu propia web', d: 'Con el plan Profesional: tunombre.quieromisfotos.com.ar o tu dominio, con tus fotos sin marca.' },
];

export async function renderPhotographerLanding(app) {
  document.title = 'Vendé tus fotos de eventos · Quiero Mis Fotos';
  const st = await loadSettings();
  const free = rulesFor({}, st).fee; // comisión del plan Gratis
  const mpPlans = st.mpFeePlans?.length ? st.mpFeePlans : DEFAULT_SETTINGS.mpFeePlans;

  const sp = id => planSpec(id, st);
  const PLAN_NAMES = { lite: 'Profesional Lite', web: 'Profesional', webdomain: 'Profesional Premium', empresa: 'Empresas' };
  const trPlans = (st.transfer?.plans || []).filter(id => PLAN_NAMES[id]).map(id => PLAN_NAMES[id]);
  const plans = [
    { id: 'free', name: 'Gratis', price: 0, cta: 'Empezar gratis', items: planFeatures('free', st) },
    { id: 'lite', name: 'Profesional Lite', price: sp('lite').price, year: sp('lite').year, cta: 'Quiero este plan', items: planFeatures('lite', st) },
    { id: 'web', name: 'Profesional', price: sp('web').price, year: sp('web').year, hot: true, cta: 'Quiero este plan', items: planFeatures('web', st) },
    { id: 'webdomain', name: 'Profesional Premium', price: sp('webdomain').price, year: sp('webdomain').year, cta: 'Quiero este plan',
      first: sp('webdomain').first > sp('webdomain').price ? sp('webdomain').first : 0, items: planFeatures('webdomain', st) },
    // Empresas: tarjeta ancha abajo (productoras o fotógrafos con equipo).
    { id: 'empresa', name: 'Empresas · para equipos de fotógrafos', price: sp('empresa').price, year: sp('empresa').year, cta: 'Quiero este plan', wide: true,
      first: sp('empresa').first > sp('empresa').price ? sp('empresa').first : 0, items: planFeatures('empresa', st) },
  ];
  const planCard = (p, i) => `
        <div class="lp-plan ${p.hot ? 'hot' : ''} ${p.wide ? 'wide' : ''} reveal" style="--d:${i * 120}ms">
          ${p.hot ? '<span class="lp-tag">Más elegido</span>' : ''}
          <h3>${esc(p.name)}</h3>
          <div class="lp-price">${p.price ? `${fmtMoney(p.price)}<small>/mes</small>` : '$0'}</div>
          ${p.first ? `<p class="muted small">Primer mes ${fmtMoney(p.first)} (incluye el dominio)</p>` : ''}
          ${p.year ? `<p class="muted small">o ${fmtMoney(p.year)}/año (2 meses gratis)</p>` : ''}
          <ul>${p.items.map(t => t === TRANSFER_FEATURE ? `<li class="plan-hl">🏦 <strong>${esc(t)}</strong></li>` : `<li>${esc(t)}</li>`).join('')}</ul>
          <a class="btn ${p.hot ? 'primary' : ''} lp-plan-cta" href="panel.html?plan=${p.id}">${esc(p.cta)}</a>
        </div>`;

  app.innerHTML = `
  <div class="lp">
    <nav class="lp-quick reveal">
      <a class="btn sm" href="#planes" data-goto="planes">💲 Ver planes</a>
      <a class="btn sm" href="#/f/fotografo-ejemplo">👀 Ver un portfolio de ejemplo</a>
    </nav>
    <section class="lp-hero">
      <div class="lp-hero-txt reveal">
        <span class="lp-kicker">Para fotógrafos</span>
        <h1>Vos sacá fotos.<br><span>Nosotros nos encargamos del resto.</span></h1>
        <p>Subí las fotos de tus partidos, torneos y carreras, y vendelas en alta calidad. Sin armar una web, sin mandar fotos una por una por WhatsApp y sin perseguir a nadie para cobrar.</p>
        <div class="row">
          <a class="btn primary lp-cta" href="panel.html?plan=free">Empezar gratis</a>
          <a class="btn" href="#como-funciona" data-scroll>Ver cómo funciona</a>
        </div>
        <p class="muted small">Sin costo fijo para arrancar: solo una comisión del ${esc(String(free))}% cuando vendés, más la comisión de Mercado Pago.</p>
      </div>
      <div class="lp-stage" aria-hidden="true">
        <div class="lp-card">
          ${SLIDES.map((s, i) => `<img src="${s.img}" alt="" class="${i ? '' : 'on'}" ${i ? 'loading="lazy"' : ''}>`).join('')}
          <div class="lp-wm"></div>
          <div class="lp-up"><span id="lp-up-t">Subiendo ${SLIDES[0].n} fotos…</span><i></i></div>
          <span class="lp-chip c1">✓ Marca de agua</span>
          <span class="lp-chip c2">🔗 Link listo para compartir</span>
        </div>
        <div class="lp-toast">💰 <b id="lp-t1">¡Vendiste ${SLIDES[0].sold} fotos!</b><small id="lp-t2">${esc(SLIDES[0].ev)} · ${fmtMoney(SLIDES[0].total)}</small></div>
      </div>
    </section>

    <section id="como-funciona" class="lp-sec">
      <h2 class="reveal">Así de simple</h2>
      <div class="lp-steps">${STEPS.map((s, i) => `
        <div class="lp-step reveal" style="--d:${i * 120}ms">
          <span class="lp-n">${i + 1}</span><span class="lp-ic">${s.ic}</span>
          <h3>${s.t}</h3><p>${s.d}</p>
        </div>`).join('')}</div>
    </section>

    <section class="lp-sec lp-split">
      <div class="lp-box us reveal">
        <h3>🧰 De esto nos encargamos nosotros</h3>
        <ul><li>Guardar tus fotos y los originales</li><li>La marca de agua en cada foto</li><li>La galería y el carrito</li><li>El cobro y las descargas del comprador</li><li>Tu perfil, tu portfolio y tu web</li><li>Avisarle a tus seguidores</li></ul>
      </div>
      <div class="lp-box you reveal" style="--d:150ms">
        <h3>📷 Vos hacés lo que te apasiona</h3>
        <ul><li>Sacar fotos</li><li>Vincular tu Mercado Pago <small>(una sola vez)</small></li><li>Subirlas y compartir el link</li></ul>
        <p class="lp-big">Y listo. ☕</p>
      </div>
    </section>

    <section class="lp-sec">
      <h2 class="reveal">Todo lo que tenés</h2>
      <div class="lp-feats">${FEATURES.map((f, i) => `
        <div class="lp-feat reveal" style="--d:${(i % 4) * 90}ms"><span>${f.ic}</span><h3>${f.t}</h3><p>${f.d}</p></div>`).join('')}</div>
    </section>

    <section id="planes" class="lp-sec">
      <h2 class="reveal">Planes</h2>
      <div class="lp-plans four">${plans.map(planCard).join('')}
      </div>
      <p class="muted small lp-note reveal">A la comisión de cada plan se suma la de Mercado Pago, que depende del plazo de cobro que elijas en tu cuenta de MP. En todos los planes elegís quién paga la comisión de Quiero Mis Fotos: la absorbés vos o se le suma al comprador como costo de servicio. Los planes pagos se cobran por Mercado Pago y los cancelás cuando quieras.</p>
    </section>

    <section id="cuanto-te-queda" class="lp-sec">
      <h2 class="reveal">¿Cuánto te queda?</h2>
      <div class="lp-calc reveal">
        <div class="lp-calc-in">
          <label class="field">Precio por foto<input type="number" id="lc-price" min="0" step="100" value="2000" inputmode="numeric"></label>
          <label class="field">Fotos vendidas<input type="number" id="lc-count" min="0" step="1" value="10" inputmode="numeric"></label>
          <label class="field">¿Quién paga la comisión?
            <select id="lc-mode"><option value="buyer">El comprador (costo de servicio)</option><option value="absorb">La absorbo yo</option></select></label>
          <label class="field">¿Cuándo cobrás en Mercado Pago?
            <select id="lc-mp">${mpPlans.map(p => `<option value="${esc(String(p.percent))}">${esc(p.label)} · ${esc(String(p.percent).replace('.', ','))}%</option>`).join('')}</select></label>
          <label class="field">Plan
            <select id="lc-plan">${plans.map(p => `<option value="${esc(String(sp(p.id).fee))}">${esc(p.name)} · ${esc(String(sp(p.id).fee).replace('.', ','))}%</option>`).join('')}</select></label>
        </div>
        <div class="lp-calc-out">
          <div class="lp-calc-row"><span>El comprador paga</span><strong id="lc-total"></strong></div>
          <div class="lp-calc-row"><span id="lc-fee-l"></span><span id="lc-fee"></span></div>
          <div class="lp-calc-row"><span>Comisión Mercado Pago</span><span id="lc-mpfee"></span></div>
          <div class="lp-calc-net"><span>Te queda</span><strong id="lc-net"></strong></div>
          <p class="muted small" style="margin:0">La comisión de Mercado Pago depende del plazo de acreditación que elijas. Son valores de referencia con tarjeta de crédito, IVA incluido.</p>
        </div>
      </div>
    </section>

    <section class="lp-sec lp-faq">
      <h2 class="reveal">Preguntas frecuentes</h2>
      <details class="reveal"><summary>¿Cuándo cobro?</summary><p>Cada venta se paga con Mercado Pago y entra directo a tu cuenta. El plazo de acreditación lo elegís vos en Mercado Pago (al instante o más adelante, con menos comisión de MP).</p></details>
      ${trPlans.length ? `<details class="reveal"><summary>¿Puedo cobrar por transferencia?</summary><p>Sí, en ${trPlans.join(', ')}. Tus clientes te transfieren a tu alias de Mercado Pago y la venta se acredita sola: <strong>no pagás la comisión de Mercado Pago</strong>. La comisión de Quiero Mis Fotos se acumula y la pagás aparte por transferencia.</p></details>` : ''}
      <details class="reveal"><summary>¿Las fotos pierden calidad?</summary><p>No. El comprador descarga la foto en alta resolución y sin marca de agua. Las muestras de la galería son livianas y llevan la marca para que nadie se las lleve sin pagar.</p></details>
      <details class="reveal"><summary>¿Cuánto tiempo quedan las fotos?</summary><p>Cada álbum se vende entre ${planSpec('free', st).days} y ${planSpec('webdomain', st).days} días, según tu plan, desde que subís la primera foto. Si querés seguir vendiendo, lo extendés desde el panel.</p></details>
      <details class="reveal"><summary>¿Puedo subir desde el celular?</summary><p>Sí. La marca de agua se aplica en tu dispositivo y la subida se retoma sola si se corta la conexión.</p></details>
      <details class="reveal"><summary>¿Y si en el evento hay más fotógrafos?</summary><p>Pueden estar todos en el mismo evento: cada uno con su álbum, sus precios y sus ventas.</p></details>
    </section>

    <section class="lp-final reveal">
      <h2>¿Arrancamos?</h2>
      <p>Creá tu cuenta en un minuto. Subí tu primer evento y compartí el link hoy mismo.</p>
      <a class="btn primary lp-cta" href="panel.html?plan=free">Crear mi cuenta gratis</a>
      <p class="small" style="margin-top:12px"><a href="panel.html">Ya tengo cuenta</a></p>
    </section>
  </div>`;

  // Cada vuelta de la animación cambia de disciplina (se cambia al reiniciar, cuando no hay marca ni carteles).
  let k = 0;
  app.querySelector('.lp-up')?.addEventListener('animationiteration', e => {
    if (e.animationName !== 'lpUp') return; // la barra de progreso también reinicia: se ignora
    k = (k + 1) % SLIDES.length;
    const s = SLIDES[k];
    app.querySelectorAll('.lp-card > img').forEach((im, i) => im.classList.toggle('on', i === k));
    app.querySelector('#lp-up-t').textContent = `Subiendo ${s.n} fotos…`;
    app.querySelector('#lp-t1').textContent = `¡Vendiste ${s.sold} fotos!`;
    app.querySelector('#lp-t2').textContent = `${s.ev} · ${fmtMoney(s.total)}`;
  });
  // Calculadora: mismo cálculo que el panel (sellerNet).
  const calc = () => {
    const price = Math.max(0, Math.round(Number($('#lc-price', app).value) || 0));
    const count = Math.max(0, Math.floor(Number($('#lc-count', app).value) || 0));
    const pct = Number($('#lc-plan', app).value);
    const r = sellerNet(price * count, { feeMode: $('#lc-mode', app).value, feePercent: pct, mpPercent: Number($('#lc-mp', app).value) });
    $('#lc-total', app).textContent = fmtMoney(r.total);
    $('#lc-fee-l', app).textContent = `Comisión Quiero Mis Fotos (${String(pct).replace('.', ',')}%)`;
    $('#lc-fee', app).textContent = `−${fmtMoney(r.platformFee)}`;
    $('#lc-mpfee', app).textContent = `−${fmtMoney(r.mpFee)}`;
    $('#lc-net', app).textContent = fmtMoney(r.net);
  };
  $$('.lp-calc input, .lp-calc select', app).forEach(el => el.addEventListener('input', calc));
  calc();
  $$('[data-scroll]', app).forEach(a => a.onclick = e => { e.preventDefault(); document.getElementById('como-funciona')?.scrollIntoView({ behavior: 'smooth' }); });
  $$('[data-goto]', app).forEach(a => a.onclick = e => { e.preventDefault(); document.getElementById(a.dataset.goto)?.scrollIntoView({ behavior: 'smooth' }); });
  // Aparición al hacer scroll.
  const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.15 });
  $$('.reveal', app).forEach(el => io.observe(el));
}
