// Superadmin → 📣 Instagram → "Marcar como subido a IG": le avisa al fotógrafo (push + mail) que publicamos su álbum
// en el Instagram de Quiero Mis Fotos, para que lo comparta.
//   POST /admin/ig/posted  { eventId, uid }  (Bearer superadmin)
import { requireUser, isSuperadmin } from './firebase.js';
import { adminGetMany, adminUpdate } from './admin.js';
import { notifyUser } from './push.js';
import { sendMail, mailLayout, authEmails } from './mail.js';
import { esc } from '../../js/text-core.js';
import { json, httpError } from './http.js';

const QMF_IG = 'https://www.instagram.com/quieromisfotos/';

export async function igPostedRequest(req, env) {
  const c = await requireUser(req, env);
  if (!isSuperadmin(c)) throw httpError(403, 'Solo superadmin');
  const { eventId, uid } = await req.json().catch(() => ({}));
  const ID = /^[A-Za-z0-9_-]{6,128}$/;
  if (!ID.test(eventId || '') || !ID.test(uid || '')) throw httpError(400, 'Pedido inválido');
  const [ev, ph] = await adminGetMany(env, [`events/${eventId}`, `users/${uid}`]);
  if (!ev || !(ev.photographerUids || []).includes(uid)) throw httpError(404, 'Álbum no encontrado');
  const name = ev.name || 'tu álbum';
  const body = `Compartí la publicación en tus historias: así llega a más gente y vendés más.`;
  await notifyUser(env, uid, { title: '📣 Publicamos tu álbum en Instagram', body: `${name}. ${body}`, link: QMF_IG }).catch(e => console.error('push ig', e));
  const to = (await authEmails(env, [uid]))[uid];
  if (to) {
    const hola = ph?.displayName ? `Hola ${esc(ph.displayName.split(' ')[0])}, ` : 'Hola, ';
    await sendMail(env, {
      to, subject: `📣 Publicamos "${name}" en Instagram`,
      html: mailLayout({
        title: 'Publicamos tu álbum en Instagram',
        intro: `${hola}subimos <strong>${esc(name)}</strong> al Instagram de Quiero Mis Fotos y te etiquetamos. ${esc(body)}`,
        cta: { label: 'Ver en Instagram', url: QMF_IG },
        foot: 'Tip: cuando cargues un álbum, sumá el Instagram de los equipos o la carrera; los etiquetamos y lo ven sus seguidores.',
      }),
    });
  }
  await adminUpdate(env, `igPosts/${eventId}_${uid}`, { notifiedAt: new Date() }).catch(e => console.error('igPosts', e));
  return json({ ok: true, mailed: !!to });
}
