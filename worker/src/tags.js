// Alta de etiquetas por fotógrafos (por ahora solo deportes). Evita duplicados ignorando
// mayúsculas, acentos y espacios, y actualiza el snapshot settings/tags que lee el sitio.
import { adminGet, adminSet } from './admin.js';
import { requireUser } from './firebase.js';
import { json, httpError } from './http.js';

const ALLOWED_TYPES = ['deporte'];

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const slugify = s => norm(s).replace(/ /g, '-').slice(0, 40);

// POST /tags  (Bearer fotógrafo aprobado o superadmin)  { type: 'deporte', name } -> { tag, created }
export async function createTag(req, env) {
  const claims = await requireUser(req, env);
  const isSuper = claims.email === 'lautarom87@gmail.com' && claims.email_verified === true;
  if (!isSuper) {
    const u = await adminGet(env, `users/${claims.sub}`);
    if (!u || u.status !== 'approved') throw httpError(403, 'Tu cuenta no está aprobada');
  }
  const { type, name } = await req.json().catch(() => ({}));
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!ALLOWED_TYPES.includes(norm(type))) throw httpError(400, 'Tipo de etiqueta no permitido');
  if (clean.length < 2 || clean.length > 30 || !/^[\p{L}\p{N} .'-]+$/u.test(clean)) {
    throw httpError(400, 'Usá entre 2 y 30 letras o números');
  }
  const pretty = clean.charAt(0).toUpperCase() + clean.slice(1);

  const snap = (await adminGet(env, 'settings/tags')) || { types: [], tags: [] };
  const typeObj = (snap.types || []).find(t => norm(t.name) === norm(type) || t.id === norm(type));
  if (!typeObj) throw httpError(409, 'No existe el tipo de etiqueta');
  const tags = snap.tags || [];
  const existing = tags.find(t => t.typeId === typeObj.id && norm(t.name) === norm(pretty));
  if (existing) return json({ tag: existing, created: false });

  let id = slugify(pretty);
  if (tags.some(t => t.id === id) || await adminGet(env, `tags/${id}`)) id = `${typeObj.id}-${id}`.slice(0, 60);
  const tag = { id, typeId: typeObj.id, name: pretty, slug: slugify(pretty) };
  await adminSet(env, `tags/${id}`, { typeId: tag.typeId, name: tag.name, slug: tag.slug, createdBy: claims.sub, createdAt: new Date() });
  await adminSet(env, 'settings/tags', {
    types: snap.types || [],
    tags: [...tags.map(({ id: i, typeId, name: n, slug }) => ({ id: i, typeId, name: n, slug })), tag],
    updatedAt: new Date(),
  });
  return json({ tag, created: true });
}
