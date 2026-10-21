// Inicialización de Firebase y re-export del SDK modular (CDN, sin build step).
// Firestore "lite": cada lectura es un pedido HTTP directo, en paralelo. El SDK completo abre un canal en tiempo real
// que en celulares tarda varios segundos en arrancar y manda las consultas en fila. Sin tiempo real: watchDoc consulta cada tanto.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getFirestore, connectFirestoreEmulator, getDoc, getCount } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-lite.js';
import { getAuth, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

export * from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-lite.js';
export { getCount as getCountFromServer };
export * from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyD8-421zYevgPvfuS9mvF_6LYE3GdALzLA',
  authDomain: 'quieromisfotos-71629.firebaseapp.com',
  projectId: 'quieromisfotos-71629',
  storageBucket: 'quieromisfotos-71629.firebasestorage.app',
  messagingSenderId: '566210366600',
  appId: '1:566210366600:web:0f11be04fce5a0e66ae33d',
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Desarrollo: http://localhost:PORT/?emu usa los emuladores locales (firebase emulators:start).
export const EMULATOR = location.hostname === 'localhost' && new URLSearchParams(location.search).has('emu');
if (EMULATOR) {
  connectFirestoreEmulator(db, '127.0.0.1', 8085);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
}

// Reemplazo de onSnapshot para un documento: lo relee cada `every` ms y avisa solo cuando cambia. Devuelve la función para cortar.
export function watchDoc(ref, onNext, onError = () => {}, every = 3000) {
  let stop = false, last, timer;
  const tick = async () => {
    try {
      const snap = await getDoc(ref);
      const key = JSON.stringify(snap.exists() ? snap.data() : null);
      if (!stop && key !== last) { last = key; onNext(snap); }
    } catch (e) { if (!stop) onError(e); }
    if (!stop) timer = setTimeout(tick, document.visibilityState === 'visible' ? every : every * 4);
  };
  tick();
  return () => { stop = true; clearTimeout(timer); };
}

export const SUPERADMIN_EMAIL = 'lautarom87@gmail.com';

// Sitio de prueba (prueba.quieromisfotos.com.ar): mismo backend y datos reales, cambios todavía no publicados.
export const STAGING = /^prueba\./.test(location.hostname);
if (STAGING) {
  document.body.insertAdjacentHTML('afterbegin', '<div class="staging-bar">🧪 SITIO DE PRUEBA · estos cambios todavía no están en el sitio oficial · los datos y los pagos SÍ son reales</div>');
}
