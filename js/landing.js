// Página "Soy fotógrafo": explica cómo funciona la plataforma para fotógrafos, con animaciones.
import { $$, esc, fmtMoney } from './util.js';
import { loadSettings } from './data.js';

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
  { ic: '🕒', t: 'Fácil de encontrarse', d: 'Filtro por horario, favoritas y sub-álbumes: el que busca su foto la encuentra rápido y compra más.' },
  { ic: '👥', t: 'Seguidores', d: 'La gente puede seguirte y activar el aviso de un evento: cuando subís las fotos, les llega la notificación.' },
  { ic: '📅', t: 'Eventos futuros', d: 'Cargá el evento antes de que pase: aparece en el calendario y la gente ya puede pedir el aviso.' },
  { ic: '🖼️', t: 'Perfil y portfolio', d: 'Tu perfil con tu trabajo, tu equipo y un botón de WhatsApp para pedirte presupuesto.' },
  { ic: '🌐', t: 'Tu propia web', d: 'Con el plan Profesional: tunombre.quieromisfotos.com.ar o tu dominio, con tus fotos sin marca.' },
];

export async function renderPhotographerLanding(app) {
  document.title = 'Vendé tus fotos de eventos · Quiero Mis Fotos';
  const st = await loadSettings();
  const v2 = !!st.plansV2;
  const free = v2 ? st.freeFeePercent ?? 5 : st.feePercent ?? 3;

  app.innerHTML = `
  <div class="lp">
    <section class="lp-hero">
      <div class="lp-hero-txt reveal">
        <span class="lp-kicker">Para fotógrafos</span>
        <h1>Vos sacá fotos.<br><span>Nosotros nos encargamos del resto.</span></h1>
        <p>Subí las fotos de tus partidos, torneos y carreras, y vendelas en alta calidad. Sin armar una web, sin mandar fotos una por una por WhatsApp y sin perseguir a nadie para cobrar.</p>
        <div class="row">
          <a class="btn primary lp-cta" href="panel.html">Empezar gratis</a>
          <a class="btn" href="#como-funciona" data-scroll>Ver cómo funciona</a>
        </div>
        <p class="muted small">Sin costo fijo para arrancar: solo una comisión del ${esc(String(free))}% cuando vendés.</p>
      </div>
      <div class="lp-stage" aria-hidden="true">
        <div class="lp-card">
          <img src="demo/lp-clean.jpg" alt="">
          <div class="lp-wm"></div>
          <div class="lp-up"><span>Subiendo 120 fotos…</span><i></i></div>
          <span class="lp-chip c1">✓ Marca de agua</span>
          <span class="lp-chip c2">🔗 Link listo para compartir</span>
        </div>
        <div class="lp-toast">💰 <b>¡Vendiste 3 fotos!</b><small>Torneo Apertura · $6.000</small></div>
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
        <ul><li>Guardar tus fotos y los originales</li><li>La marca de agua en cada foto</li><li>La galería, los filtros y el carrito</li><li>El cobro y las descargas del comprador</li><li>Tu perfil, tu portfolio y tu web</li><li>Avisarle a tus seguidores</li></ul>
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

    <section class="lp-sec">
      <h2 class="reveal">Planes</h2>
      ${v2 ? `<div class="lp-plans">
        <div class="lp-plan reveal"><h3>Gratis</h3><div class="lp-price">$0</div><ul><li>1 álbum activo a la vez</li><li>Hasta ${st.freeAlbumLimitGB ?? 3} GB por álbum</li><li>Perfil y portfolio de ${st.freePortfolioLimit ?? 12} fotos</li><li>Comisión ${st.freeFeePercent ?? 5}% por venta</li></ul></div>
        <div class="lp-plan hot reveal" style="--d:120ms"><span class="lp-tag">Más elegido</span><h3>Profesional</h3><div class="lp-price">${fmtMoney(st.webPrice)}<small>/mes</small></div><ul><li>Álbumes ilimitados</li><li>${st.albumLimitGB > 0 ? `${st.albumLimitGB} GB por álbum (ampliable)` : 'Más espacio por álbum'}</li><li>Portfolio de ${st.proPortfolioLimit ?? 80} fotos</li><li>Tu web: tunombre.quieromisfotos.com.ar</li><li>Comisión ${st.feePercent ?? 3}% por venta</li></ul></div>
        <div class="lp-plan reveal" style="--d:240ms"><h3>Profesional + Dominio</h3><div class="lp-price">${fmtMoney(st.webDomainPrice)}<small>/mes</small></div>
          ${st.webDomainFirstPrice > st.webDomainPrice ? `<p class="muted small">Primer mes ${fmtMoney(st.webDomainFirstPrice)} (incluye el dominio)</p>` : ''}
          <ul><li>Todo lo de Profesional</li><li>Tu propio dominio (tunombre.com.ar)</li></ul></div>
      </div>` : `<div class="lp-box us reveal" style="text-align:center"><p class="lp-big" style="margin:0">Empezás gratis.</p><p>Solo pagás una comisión del ${esc(String(st.feePercent ?? 3))}% cuando vendés. Si querés tu propia web, tenés planes desde ${fmtMoney(st.webPrice)}/mes.</p></div>`}
    </section>

    <section class="lp-sec lp-faq">
      <h2 class="reveal">Preguntas frecuentes</h2>
      <details class="reveal"><summary>¿Cuándo cobro?</summary><p>Cada venta se paga con Mercado Pago y entra directo a tu cuenta. El plazo de acreditación lo elegís vos en Mercado Pago (al instante o más adelante, con menos comisión de MP).</p></details>
      <details class="reveal"><summary>¿Las fotos pierden calidad?</summary><p>No. El comprador descarga la foto en alta resolución y sin marca de agua. Las muestras de la galería son livianas y llevan la marca para que nadie se las lleve sin pagar.</p></details>
      <details class="reveal"><summary>¿Cuánto tiempo quedan las fotos?</summary><p>Cada álbum se vende ${st.retentionDays || 14} días desde que subís la primera foto. Si querés seguir vendiendo, lo extendés desde el panel.</p></details>
      <details class="reveal"><summary>¿Puedo subir desde el celular?</summary><p>Sí. La marca de agua se aplica en tu dispositivo y la subida se retoma sola si se corta la conexión.</p></details>
      <details class="reveal"><summary>¿Y si en el evento hay más fotógrafos?</summary><p>Pueden estar todos en el mismo evento: cada uno con su álbum, sus precios y sus ventas.</p></details>
    </section>

    <section class="lp-final reveal">
      <h2>¿Arrancamos?</h2>
      <p>Creá tu cuenta en un minuto. Subí tu primer evento y compartí el link hoy mismo.</p>
      <a class="btn primary lp-cta" href="panel.html">Crear mi cuenta gratis</a>
      <p class="small" style="margin-top:12px"><a href="panel.html">Ya tengo cuenta</a></p>
    </section>
  </div>`;

  $$('[data-scroll]', app).forEach(a => a.onclick = e => { e.preventDefault(); document.getElementById('como-funciona')?.scrollIntoView({ behavior: 'smooth' }); });
  // Aparición al hacer scroll.
  const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.15 });
  $$('.reveal', app).forEach(el => io.observe(el));
}
