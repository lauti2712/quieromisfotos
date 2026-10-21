// Tests de firestore.rules contra el emulador. Correr: npm test (desde tests/).
import { test, before, beforeEach, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, collection, query, where,
  arrayUnion, arrayRemove,
} from 'firebase/firestore';

let env;
const SUPER = { uid: 'lauti', token: { email: 'lautarom87@gmail.com', email_verified: true } };
const FAKE_SUPER = { uid: 'fake', token: { email: 'lautarom87@gmail.com', email_verified: false } };

const photographer = (status, extra = {}) => ({
  role: 'photographer', status, displayName: 'X', slug: 'x', mpConnected: false, ...extra,
});

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-qmf',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8085 },
  });
});
after(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/ana'), photographer('approved', { slug: 'ana' }));
    await setDoc(doc(db, 'slugs/ana'), { uid: 'ana' });
    await setDoc(doc(db, 'users/beto'), photographer('approved', { slug: 'beto' }));
    await setDoc(doc(db, 'users/pepe'), photographer('pending', { slug: 'pepe' }));
    await setDoc(doc(db, 'userPrivate/ana'), { email: 'ana@x.com' });
    await setDoc(doc(db, 'events/pub'), { name: 'P', status: 'published', kind: 'own', createdBy: 'ana', photographerUids: ['ana'], openToJoin: true, date: '2026-10-01' });
    await setDoc(doc(db, 'events/closed'), { name: 'C', status: 'published', kind: 'own', createdBy: 'ana', photographerUids: ['ana'], openToJoin: false, date: '2026-10-01' });
    await setDoc(doc(db, 'events/draft'), { name: 'D', status: 'draft', kind: 'own', createdBy: 'ana', photographerUids: ['ana'], openToJoin: false, date: '2026-10-01' });
    await setDoc(doc(db, 'events/pub/sets/ana'), { price: 100, photoCount: 0 });
  });
});

const as = a => (a ? env.authenticatedContext(a.uid, a.token).firestore() : env.unauthenticatedContext().firestore());
const user = uid => as({ uid, token: { email: `${uid}@x.com`, email_verified: true } });

// ---------- lecturas públicas
test('público lee eventos publicados pero no borradores', async () => {
  await assertSucceeds(getDoc(doc(as(), 'events/pub')));
  await assertFails(getDoc(doc(as(), 'events/draft')));
  await assertSucceeds(getDocs(query(collection(as(), 'events'), where('status', '==', 'published'))));
  await assertFails(getDocs(collection(as(), 'events')));
});

test('público lee perfiles aprobados, no pendientes; nunca userPrivate', async () => {
  await assertSucceeds(getDoc(doc(as(), 'users/ana')));
  await assertFails(getDoc(doc(as(), 'users/pepe')));
  await assertFails(getDoc(doc(as(), 'userPrivate/ana')));
  await assertFails(getDoc(doc(user('beto'), 'userPrivate/ana')));
});

// ---------- alta y perfil
test('alta de fotógrafo: solo pending, con slug propio', async () => {
  const db = user('nuevo');
  const ok = writeBatch(db);
  ok.set(doc(db, 'slugs/nuevo'), { uid: 'nuevo' });
  ok.set(doc(db, 'users/nuevo'), photographer('pending', { slug: 'nuevo' }));
  await assertSucceeds(ok.commit());

  const db2 = user('tramposo');
  const bad = writeBatch(db2);
  bad.set(doc(db2, 'slugs/tramposo'), { uid: 'tramposo' });
  bad.set(doc(db2, 'users/tramposo'), photographer('approved', { slug: 'tramposo' }));
  await assertFails(bad.commit());

  const b3 = writeBatch(db2);
  b3.set(doc(db2, 'slugs/tramposo'), { uid: 'tramposo' });
  b3.set(doc(db2, 'users/tramposo'), { ...photographer('pending', { slug: 'tramposo' }), role: 'superadmin' });
  await assertFails(b3.commit());

  // el alta no puede traer plan, cortesía, dominio ni cuenta de MP
  for (const extra of [{ plan: 'webdomain', proUntil: new Date('2099-01-01') }, { courtesy: true }, { domainActive: true, siteDomain: 'x.com' }, { trial: true }, { mpUserId: '123' }]) {
    const b4 = writeBatch(db2);
    b4.set(doc(db2, 'slugs/tramposo'), { uid: 'tramposo' });
    b4.set(doc(db2, 'users/tramposo'), { ...photographer('pending', { slug: 'tramposo' }), ...extra });
    await assertFails(b4.commit());
  }
});

test('no se puede usar el slug de otro', async () => {
  const db = user('nuevo');
  await assertFails(setDoc(doc(db, 'users/nuevo'), photographer('pending', { slug: 'ana' })));
});

test('fotógrafo no puede cambiarse status/role/mpConnected', async () => {
  const db = user('pepe');
  await assertSucceeds(updateDoc(doc(db, 'users/pepe'), { bio: 'hola' }));
  await assertFails(updateDoc(doc(db, 'users/pepe'), { status: 'approved' }));
  await assertFails(updateDoc(doc(db, 'users/pepe'), { role: 'superadmin' }));
  await assertFails(updateDoc(doc(db, 'users/pepe'), { mpConnected: true }));
  await assertFails(updateDoc(doc(db, 'users/ana'), { bio: 'hack' }));
});

test('superadmin aprueba; email sin verificar no es superadmin', async () => {
  await assertSucceeds(updateDoc(doc(as(SUPER), 'users/pepe'), { status: 'approved' }));
  await assertFails(updateDoc(doc(as(FAKE_SUPER), 'users/beto'), { status: 'suspended' }));
});

// ---------- etiquetas y settings
test('solo superadmin escribe etiquetas y settings', async () => {
  await assertSucceeds(setDoc(doc(as(SUPER), 'tags/t1'), { name: 'Fútbol', typeId: 'd' }));
  await assertFails(setDoc(doc(user('ana'), 'tags/t2'), { name: 'X', typeId: 'd' }));
  await assertFails(setDoc(doc(user('ana'), 'settings/platform'), { feePercent: 0 }));
  await assertSucceeds(getDoc(doc(as(), 'settings/platform')));
});

// ---------- eventos
test('fotógrafo aprobado crea evento propio con su set; pendiente no', async () => {
  const db = user('beto');
  const b = writeBatch(db);
  b.set(doc(db, 'events/nb'), { name: 'N', status: 'draft', kind: 'own', createdBy: 'beto', photographerUids: ['beto'], openToJoin: true });
  b.set(doc(db, 'events/nb/sets/beto'), { price: 1, photoCount: 0 });
  await assertSucceeds(b.commit());

  await assertFails(setDoc(doc(user('pepe'), 'events/np'), { name: 'N', status: 'draft', kind: 'own', createdBy: 'pepe', photographerUids: ['pepe'] }));
  await assertFails(setDoc(doc(user('beto'), 'events/ng'), { name: 'G', status: 'draft', kind: 'general', createdBy: 'beto', photographerUids: [] }));
  await assertSucceeds(setDoc(doc(as(SUPER), 'events/ng'), { name: 'G', status: 'draft', kind: 'general', createdBy: 'lauti', photographerUids: [], openToJoin: true }));
});

test('sumarse: solo a eventos abiertos, solo a sí mismo', async () => {
  const db = user('beto');
  const b = writeBatch(db);
  b.update(doc(db, 'events/pub'), { photographerUids: arrayUnion('beto') });
  b.set(doc(db, 'events/pub/sets/beto'), { price: 1, photoCount: 0 });
  await assertSucceeds(b.commit());

  await assertFails(updateDoc(doc(db, 'events/closed'), { photographerUids: arrayUnion('beto') }));
  await assertFails(updateDoc(doc(user('pepe'), 'events/pub'), { photographerUids: arrayUnion('pepe') }));
  await assertFails(updateDoc(doc(db, 'events/pub'), { photographerUids: ['beto'] }));
  await assertFails(updateDoc(doc(db, 'events/pub'), { name: 'hack' }));
});

test('set: no se crea sin ser miembro; no se tocan campos de retención', async () => {
  await assertFails(setDoc(doc(user('beto'), 'events/closed/sets/beto'), { price: 1 }));
  await assertFails(setDoc(doc(user('beto'), 'events/pub/sets/ana'), { price: 1 }));
  await assertSucceeds(updateDoc(doc(user('ana'), 'events/pub/sets/ana'), { price: 200 }));
  await assertFails(updateDoc(doc(user('ana'), 'events/pub/sets/ana'), { extendedUntil: new Date() }));
  await assertFails(updateDoc(doc(user('ana'), 'events/pub/sets/ana'), { soldPhotos: 99 }));
  await assertFails(updateDoc(doc(user('beto'), 'events/pub/sets/ana'), { price: 1 }));
});

test('salir de un evento ajeno; el creador no sale', async () => {
  await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), 'events/pub'), { photographerUids: ['ana', 'beto'] }));
  await assertSucceeds(updateDoc(doc(user('beto'), 'events/pub'), { photographerUids: arrayRemove('beto') }));
  await assertFails(updateDoc(doc(user('ana'), 'events/pub'), { photographerUids: arrayRemove('ana') }));
});

test('borrador visible para su miembro, no para otros fotógrafos', async () => {
  await assertSucceeds(getDoc(doc(user('ana'), 'events/draft')));
  await assertFails(getDoc(doc(user('beto'), 'events/draft')));
  await assertSucceeds(getDocs(query(collection(user('beto'), 'events'), where('openToJoin', '==', true))));
});

// ---------- órdenes
test('orders/extensions: nadie escribe desde el cliente', async () => {
  await assertFails(setDoc(doc(user('ana'), 'orders/o1'), { photographerUid: 'ana' }));
  await assertFails(setDoc(doc(as(SUPER), 'orders/o1'), { photographerUid: 'ana' }));
  await assertFails(setDoc(doc(as(), 'extensions/e1'), { photographerUid: 'ana' }));
});

// ---------- fotos
const photo = (uid, pid, extra = {}) => ({
  eventId: 'pub', photographerUid: uid, subalbumId: '', hidden: false, originalDeleted: false,
  previewUrl: `https://x/e/pub/${uid}/${pid}_p.jpg`, thumbUrl: `https://x/e/pub/${uid}/${pid}_t.jpg`, ...extra,
});

test('fotos: las crea y las borra solo el Worker (ni el fotógrafo dueño)', async () => {
  await assertFails(setDoc(doc(user('ana'), 'photos/p1'), photo('ana', 'p1')));
  await assertFails(setDoc(doc(user('beto'), 'photos/p4'), photo('beto', 'p4')));
  await assertSucceeds(setDoc(doc(as(SUPER), 'photos/p5'), photo('ana', 'p5')));
});

test('fotos: ocultas no son públicas; dueño mueve/oculta; otro no', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'photos/v'), photo('ana', 'v'));
    await setDoc(doc(db, 'photos/h'), photo('ana', 'h', { hidden: true }));
  });
  await assertSucceeds(getDoc(doc(as(), 'photos/v')));
  await assertFails(getDoc(doc(as(), 'photos/h')));
  await assertSucceeds(getDoc(doc(user('ana'), 'photos/h')));
  await assertSucceeds(getDocs(query(collection(as(), 'photos'), where('eventId', '==', 'pub'), where('hidden', '==', false))));
  await assertSucceeds(updateDoc(doc(user('ana'), 'photos/v'), { hidden: true, subalbumId: 's1' }));
  await assertFails(updateDoc(doc(user('ana'), 'photos/v'), { previewUrl: 'https://evil' }));
  await assertFails(updateDoc(doc(user('beto'), 'photos/v'), { hidden: true }));
  await assertFails(deleteDoc(doc(user('beto'), 'photos/v')));
  await assertFails(deleteDoc(doc(user('ana'), 'photos/v'))); // se borra por el Worker (controla ventas)
  await assertSucceeds(updateDoc(doc(user('ana'), 'photos/v'), { bibs: ['123', '45'] }));
  await assertFails(updateDoc(doc(user('ana'), 'photos/v'), { bibs: Array.from({ length: 21 }, (_, i) => String(i)) }));
  await assertSucceeds(updateDoc(doc(user('ana'), 'photos/v'), { price: 5000, noPack: true }));
  await assertFails(updateDoc(doc(user('ana'), 'photos/v'), { price: -1 }));
  await assertFails(updateDoc(doc(user('ana'), 'photos/v'), { noPack: 'si' }));
  await assertFails(updateDoc(doc(user('beto'), 'photos/v'), { price: 1 }));
});

test('set: contador, bytes, conteo por hora y vencimiento solo los escribe el Worker', async () => {
  const ref = doc(user('ana'), 'events/pub/sets/ana');
  await assertFails(updateDoc(ref, { expiresAt: new Date(Date.now() + 14 * 86400000) }));
  await assertFails(updateDoc(ref, { photoCount: 7 }));
  await assertFails(updateDoc(ref, { bytesOriginal: 0 }));
  await assertFails(updateDoc(ref, { hourCounts: {} }));
  await assertFails(updateDoc(ref, { bibPhotos: 99 }));
  // crear el set con contador en cero sí; con fotos o vencimiento, no
  await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), 'events/pub'), { photographerUids: ['ana', 'beto'] }));
  await assertFails(setDoc(doc(user('beto'), 'events/pub/sets/beto'), { price: 1, photoCount: 5 }));
  await assertFails(setDoc(doc(user('beto'), 'events/pub/sets/beto'), { price: 1, photoCount: 0, expiresAt: new Date() }));
  await assertSucceeds(setDoc(doc(user('beto'), 'events/pub/sets/beto'), { price: 1, photoCount: 0, bytesOriginal: 0 }));
  // no se borra un set con fotos (así no se reinicia el vencimiento)
  await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), 'events/pub/sets/ana'), { photoCount: 3 }));
  await assertFails(deleteDoc(ref));
});

// ---------- portfolio
test('portfolio: slot dentro del límite del plan', async () => {
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'settings/platform'), { freePortfolioLimit: 12, webDomainPortfolioLimit: 100 }));
  const pf = (uid, slot) => ({ photographerUid: uid, slot, url: `https://x/u/${uid}/a_p.jpg`, thumbUrl: `https://x/u/${uid}/a_t.jpg` });
  await assertSucceeds(setDoc(doc(user('ana'), 'portfolio/ana_11'), pf('ana', 11)));
  await assertFails(setDoc(doc(user('ana'), 'portfolio/ana_12'), pf('ana', 12)));       // gratis: máximo 12
  await assertFails(setDoc(doc(user('ana'), 'portfolio/ana_3'), pf('ana', 4)));         // id ≠ slot
  await assertFails(setDoc(doc(user('ana'), 'portfolio/beto_1'), pf('beto', 1)));       // ajeno
  await assertSucceeds(setDoc(doc(user('pepe'), 'portfolio/pepe_0'), pf('pepe', 0)));   // pendiente: puede armar su portfolio
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'users/susi'), photographer('suspended', { slug: 'susi' })));
  await assertFails(setDoc(doc(user('susi'), 'portfolio/susi_0'), pf('susi', 0)));      // suspendido
  await assertFails(updateDoc(doc(user('ana'), 'users/ana'), { plan: 'webdomain' }));   // no se da un plan sola
  await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), 'users/ana'), { plan: 'webdomain', proUntil: new Date(Date.now() + 86400000) }));
  await assertSucceeds(setDoc(doc(user('ana'), 'portfolio/ana_99'), pf('ana', 99)));   // Premium: hasta 100
  await assertFails(setDoc(doc(user('ana'), 'portfolio/ana_100'), pf('ana', 100)));
  await assertSucceeds(getDoc(doc(as(), 'portfolio/ana_99')));
});

// ---------- compradores
test('comprador lee sus pedidos y no los ajenos', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'orders/o1'), { buyerUid: 'cliente1', photographerUid: 'ana', status: 'approved' });
    await setDoc(doc(db, 'orders/o2'), { buyerUid: 'cliente2', photographerUid: 'ana', status: 'approved' });
  });
  await assertSucceeds(getDoc(doc(user('cliente1'), 'orders/o1')));
  await assertFails(getDoc(doc(user('cliente1'), 'orders/o2')));
  await assertSucceeds(getDocs(query(collection(user('cliente1'), 'orders'), where('buyerUid', '==', 'cliente1'))));
  await assertFails(getDocs(query(collection(user('cliente1'), 'orders'), where('buyerUid', '==', 'cliente2'))));
  await assertSucceeds(getDoc(doc(user('ana'), 'orders/o2')));  // el fotógrafo ve sus ventas
  await assertFails(setDoc(doc(user('cliente1'), 'orders/o3'), { buyerUid: 'cliente1', status: 'approved' }));
});

// ---------- planes web
test('plan Profesional amplía el portfolio; pedidos de plan solo propios', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'settings/platform'), { freePortfolioLimit: 12, webPortfolioLimit: 60 });
    await updateDoc(doc(db, 'users/beto'), { plan: 'web', proUntil: new Date(Date.now() + 86400000) });
  });
  const pf = (uid, slot) => ({ photographerUid: uid, slot, url: `https://x/u/${uid}/a.jpg`, thumbUrl: `https://x/u/${uid}/a_t.jpg`, cleanUrl: `https://x/u/${uid}/c.jpg` });
  await assertSucceeds(setDoc(doc(user('beto'), 'portfolio/beto_59'), pf('beto', 59)));
  await assertFails(setDoc(doc(user('beto'), 'portfolio/beto_60'), pf('beto', 60)));
  await assertFails(setDoc(doc(user('beto'), 'portfolio/beto_58'), { ...pf('beto', 58), cleanUrl: 'https://x/u/ana/c.jpg' }));
  await assertSucceeds(updateDoc(doc(user('beto'), 'portfolio/beto_59'), { album: 'Rugby' }));
  await assertSucceeds(setDoc(doc(user('pepe'), 'planRequests/pepe'), { plan: 'web', displayName: 'Pepe' }));
  await assertFails(setDoc(doc(user('pepe'), 'planRequests/ana'), { plan: 'web' }));
  await assertFails(setDoc(doc(user('pepe'), 'planRequests/pepe'), { plan: 'gratis-para-siempre' }));
  await assertFails(updateDoc(doc(user('beto'), 'users/beto'), { domainActive: true, siteDomain: 'x.com' }));
  await assertFails(setDoc(doc(user('beto'), 'domains/x.com'), { uid: 'beto' }));
});

test('ventas por álbum y alertas: privadas', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'salesStats/pub_ana'), { eventId: 'pub', photographerUid: 'ana', soldPhotos: 3, soldOrders: 1 });
    await setDoc(doc(db, 'alerts/a1'), { type: 'x', text: 'y' });
  });
  await assertSucceeds(getDoc(doc(user('ana'), 'salesStats/pub_ana')));
  await assertFails(getDoc(doc(user('beto'), 'salesStats/pub_ana')));
  await assertFails(getDoc(doc(as(), 'salesStats/pub_ana')));
  await assertFails(setDoc(doc(user('ana'), 'salesStats/pub_ana'), { soldPhotos: 99 }));
  await assertSucceeds(getDoc(doc(as(SUPER), 'alerts/a1')));
  await assertFails(getDoc(doc(user('ana'), 'alerts/a1')));
});

test('botón de arrepentimiento: cualquiera envía, solo el superadmin lee', async () => {
  const { serverTimestamp } = await import('firebase/firestore');
  const ok = { name: 'Juan Pérez', email: 'juan@x.com', orderRef: 'abc', reason: 'me equivoqué', uid: '', createdAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(as(), 'cancelRequests/c1'), ok));
  await assertFails(setDoc(doc(as(), 'cancelRequests/c2'), { ...ok, email: 'no-es-email' }));
  await assertFails(setDoc(doc(as(), 'cancelRequests/c3'), { ...ok, extra: 1 }));
  await assertFails(setDoc(doc(as(), 'cancelRequests/c4'), { ...ok, uid: 'ana' }));   // no puede firmar como otro
  await assertFails(getDoc(doc(as(), 'cancelRequests/c1')));
  await assertSucceeds(getDoc(doc(as(SUPER), 'cancelRequests/c1')));
});

test('plan Empresas: el equipo lo maneja el Worker; el colaborador ve eventos de la empresa y sus fotos', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'teams/ana'), { members: ['beto'], memberInfo: { beto: { name: 'Beto' } } });
    await setDoc(doc(db, 'photos/tb'), { ...photo('ana', 'tb'), hidden: true, uploadedBy: 'beto' });
    await setDoc(doc(db, 'photos/ta'), { ...photo('ana', 'ta'), hidden: true, uploadedBy: 'ana' });
    await setDoc(doc(db, 'teamSales/pub_ana_beto'), { eventId: 'pub', teamUid: 'ana', memberUid: 'beto', soldPhotos: 4 });
  });
  // equipo: lo leen la empresa y el colaborador; nadie lo escribe desde el navegador
  await assertSucceeds(getDoc(doc(user('ana'), 'teams/ana')));
  await assertSucceeds(getDoc(doc(user('beto'), 'teams/ana')));
  await assertFails(getDoc(doc(user('pepe'), 'teams/ana')));
  await assertFails(setDoc(doc(user('beto'), 'teams/ana'), { members: ['beto', 'pepe'] }));
  await assertFails(setDoc(doc(user('pepe'), 'teams/pepe'), { members: ['ana'] }));
  // borrador de la empresa: lo ve el colaborador, no otro fotógrafo
  await assertSucceeds(getDoc(doc(user('beto'), 'events/draft')));
  await assertFails(getDoc(doc(user('pepe'), 'events/draft')));
  // fotos: el colaborador ve y oculta las suyas, no las de otro
  await assertSucceeds(getDoc(doc(user('beto'), 'photos/tb')));
  await assertFails(getDoc(doc(user('beto'), 'photos/ta')));
  await assertSucceeds(updateDoc(doc(user('beto'), 'photos/tb'), { hidden: false }));
  await assertFails(updateDoc(doc(user('beto'), 'photos/tb'), { price: 100 })); // el colaborador no pone precios
  await assertFails(updateDoc(doc(user('beto'), 'photos/ta'), { hidden: false }));
  await assertFails(updateDoc(doc(user('beto'), 'photos/tb'), { photographerUid: 'beto' }));
  await assertSucceeds(getDocs(query(collection(user('beto'), 'photos'), where('eventId', '==', 'pub'), where('photographerUid', '==', 'ana'), where('uploadedBy', '==', 'beto'))));
  // ventas del colaborador
  await assertSucceeds(getDoc(doc(user('beto'), 'teamSales/pub_ana_beto')));
  await assertSucceeds(getDoc(doc(user('ana'), 'teamSales/pub_ana_beto')));
  await assertFails(getDoc(doc(user('pepe'), 'teamSales/pub_ana_beto')));
  // nadie se da lugares extra
  await assertFails(updateDoc(doc(user('ana'), 'users/ana'), { teamExtraSeats: 10 }));
  // la copia pública del equipo la escribe solo el Worker
  await assertFails(updateDoc(doc(user('ana'), 'users/ana'), { teamPublic: [{ uid: 'x', name: 'Falso' }] }));
  await assertFails(updateDoc(doc(user('beto'), 'users/beto'), { teamOf: [{ uid: 'ana', name: 'Empresa famosa' }] }));
});

test('estadísticas: nadie las escribe desde el navegador (las cuenta el Worker); subdominios reservados; lugares pagos', async () => {
  await assertFails(setDoc(doc(as(), 'stats/pub'), { views: 1 }));
  await assertFails(setDoc(doc(user('ana'), 'stats/pub'), { views: 1 }));
  await assertSucceeds(getDoc(doc(user('ana'), 'stats/pub')));
  await assertFails(setDoc(doc(user('nuevo'), 'slugs/ver'), { uid: 'nuevo' }));
  await assertFails(setDoc(doc(user('nuevo'), 'slugs/api'), { uid: 'nuevo' }));
  await assertSucceeds(setDoc(doc(user('nuevo'), 'slugs/vero-fotos'), { uid: 'nuevo' }));
  await assertFails(updateDoc(doc(user('ana'), 'users/ana'), { teamPaidSeats: 20 }));
});
