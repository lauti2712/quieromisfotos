# Quiero Mis Fotos

Marketplace de fotografía deportiva: fotógrafos suben fotos de eventos, el público las compra y la plataforma cobra una comisión. Objetivo: cero costo fijo mensual.

- **Sitio:** https://solucionescotidianas.com.ar/quieromisfotos/
- **Panel (fotógrafos y superadmin):** https://solucionescotidianas.com.ar/quieromisfotos/panel.html
- **Firebase:** proyecto `quieromisfotos-71629` (Spark): Auth y Firestore (`southamerica-east1`)

## Estructura

```
index.html          sitio público (hash routing: #/evento/{id}, #/f/{slug})
panel.html          panel de fotógrafos y superadmin
css/app.css         estilos (responsive, modo claro/oscuro)
js/fb.js            inicialización de Firebase y re-export del SDK (CDN, sin build)
js/util.js          helpers compartidos
js/data.js          taxonomía de etiquetas y settings
js/watermark.js     dibujo de la marca de agua (canvas/OffscreenCanvas)
js/public.js        sitio público
js/panel.js         panel
firestore.rules     reglas de seguridad
tests/              tests de reglas contra el emulador
```

## Modelo de datos (además del spec)

- `slugs/{slug}` → `{ uid }`: garantiza que los slugs sean únicos.
- `userPrivate/{uid}` → `{ email }`: datos no públicos del fotógrafo.
- `settings/tags`: snapshot desnormalizado de `tagTypes` + `tags`. El sitio público lo lee con una sola lectura y el panel lo regenera cada vez que el superadmin edita etiquetas.
- `events.kind`: `general` (lo crea el superadmin) u `own` (lo crea un fotógrafo).
- `events.openToJoin`: permite que otros fotógrafos se sumen. Los eventos generales siempre están abiertos.
- `events.searchTokens`: palabras y prefijos para la búsqueda por nombre.
- El superadmin se define por el email verificado `lautarom87@gmail.com` en las reglas.

## Desarrollo local

```bash
python3 -m http.server 5175
```

Con emuladores (Auth y Firestore locales, sin tocar producción):

```bash
export JAVA_HOME="/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home"
firebase emulators:start --only auth,firestore
python3 tests/emu-seed.py
```

Después abrí `http://localhost:5175/panel.html?emu`. Los usuarios de prueba están en `tests/emu-users.json`.

Tests de reglas:

```bash
cd tests && npm install && npm test
```

## Worker (Cloudflare) — `worker/`

API para subir y borrar fotos (y más adelante pagos, descargas y cron). El navegador procesa las imágenes y las sube **a través del Worker**, que escribe en R2 con un binding: no hacen falta credenciales S3 ni CORS en el bucket. Para validar al fotógrafo, el Worker lee Firestore con el ID token del usuario, así que aplican las reglas.

- `qmf-public`: muestras y miniaturas con marca de agua, más avatares, logos y portadas. Se sirve por dominio público (`PUBLIC_BASE_URL`) o por `GET /public/*` del Worker.
- `qmf-private`: originales en `e/{eventId}/{uid}/{photoId}`. Nunca son públicos.

Desarrollo: `cd worker && npm run dev` (R2 simulado). Usa `.dev.vars` con `UPLOAD_SECRET` y `FIREBASE_EMULATOR=1`.

Puesta en producción (una vez):

```bash
cd worker
npx wrangler login
npx wrangler r2 bucket create qmf-public
npx wrangler r2 bucket create qmf-private
npx wrangler secret put UPLOAD_SECRET
npx wrangler deploy
```

## Logo

`assets/`: `logo.svg` (ícono), `logo-horizontal.svg` (ícono + "quieromisfotos"), `favicon.svg`, PNG para celular y `og-image.png` (imagen al compartir links). Los PNG se regeneran con `python3 tools/make-logo.py`.

## Ejemplo (demo)

Hay un fotógrafo y un evento de ejemplo (`demo: true`) para que quien entre vea cómo funciona. Las imágenes están en `demo/`, se generan con `tools/make-demo.py` y se sirven desde GitHub Pages.

```bash
python3 tools/seed-demo.py prod            # cargar
python3 tools/seed-demo.py prod --delete   # borrar
```

## Deploy

- Frontend: push a `main` y GitHub Pages lo publica solo.
- Reglas e índices: `firebase deploy --only firestore`.

## Fases

1. ✅ Base: auth, roles, alta y aprobación de fotógrafos, etiquetas, eventos, sets y sub-álbumes, sitio público con filtros.
2. ✅ Fotos: Worker (qmf-api.solucionescotidianas.com.ar), R2 (fotos públicas en qmf-fotos.solucionescotidianas.com.ar), marca de agua en el navegador, subida masiva, galería con visor.
3. ✅ Carrito: agrupado por fotógrafo + evento, packs (combinación más barata, `js/pricing.js` compartido con el Worker), comisión y sugerencia de pack.
4. ✅ Pagos (en modo prueba): vinculación OAuth de MP, checkout con marketplace_fee, webhook verificado contra la API de MP, página del pedido con sincronización, descargas con links firmados de 15 min, ventas del fotógrafo. Sin mail: el comprador tiene cuenta y ve todo en Mis compras.
5. Retención: cron, avisos, borrado y extensiones pagas.
6. Superadmin: métricas.

Extra: perfil con especialidades y botón "Pedir presupuesto" por WhatsApp, portfolio freemium (12 fotos gratis, 200 con Pro; precio configurable, por defecto $3.000) y directorio `#/fotografos` con los Pro destacados. Por ahora el superadmin da el Pro a mano; el cobro por suscripción de Mercado Pago llega con la Fase 4.
