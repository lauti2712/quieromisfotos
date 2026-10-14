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

## Deploy

- Frontend: push a `main` y GitHub Pages lo publica solo.
- Reglas e índices: `firebase deploy --only firestore`.

## Fases

1. ✅ Base: auth, roles, alta y aprobación de fotógrafos, etiquetas, eventos, sets y sub-álbumes, sitio público con filtros.
2. Fotos: Worker `/upload-urls`, R2, marca de agua en el navegador, subida masiva, galería.
3. Carrito: agrupado por fotógrafo, packs (combinación más barata) y comisión.
4. Pagos: OAuth de Mercado Pago, checkout, webhook, descargas firmadas, mail.
5. Retención: cron, avisos, borrado y extensiones pagas.
6. Superadmin: métricas.
