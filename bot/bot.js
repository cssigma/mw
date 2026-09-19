import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

export const PROJECT_ID = 'mediavolnapp';
export const BUCKET = 'mediavolnapp.firebasestorage.app';
const VK_API = 'https://api.vk.com/method';

const REJECT_WORDS = ['-', '−', 'нет', 'не ', 'откло', 'брак', 'фейк', 'не то', 'невер', 'не засчит', 'не засчи', 'незасчит', 'не зачёт', 'не зачет', 'минус', 'спам'];
const APPROVE_WORDS = ['+', 'засчи', 'засчит', 'зачет', 'зачёт', 'верно', 'ок', 'ok', 'да', 'принято', 'гуд', 'супер', 'отлично', 'красава', 'плюс'];

export function parseDecision(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (REJECT_WORDS.some((w) => t.includes(w))) return 'reject';
  if (APPROVE_WORDS.some((w) => t.includes(w))) return 'approve';
  return null;
}

export function buildCaption(sub) {
  const label = sub.mediaType === 'video' ? 'Видео'
    : sub.mediaType === 'mixed' ? 'Фото+видео'
    : 'Фото';
  const teamLine = sub.district ? `\nКоманда · округ «${sub.district}»` : '';
  const lines = [
    `${label} с задания №${sub.taskId} · «${sub.taskText || ''}»` + (sub.noAward ? '' : ` · +${sub.points ?? '?'} б`),
    `Участник: ${sub.name || sub.vkId || sub.uid}${teamLine}`,
    sub.noAward
      ? 'Ответьте реплаем: «+» зачесть участие или «−» отклонить (баллы команде начислит организатор)'
      : 'Ответьте реплаем на это сообщение: «+» засчитать или «−» отклонить',
  ];
  return lines.join('\n');
}

export function buildStatusText(sub, decision) {
  const status = decision === 'approve' ? '✅ Засчитано' : '❌ Отклонено';
  return `${buildCaption(sub)}\n\nСтатус: ${status} другим модератором`;
}

export function findDecisionMessages(history, msgId) {
  const out = [];
  for (const m of history || []) {
    const rm = m.reply_message;
    if (rm && rm.id === msgId && m.text) {
      out.push({ text: m.text, fromId: m.from_id, date: m.date });
    }
  }
  return out;
}

async function vkApi(token, method, params) {
  const body = new URLSearchParams({
    access_token: token,
    v: '5.199',
    ...params,
  });
  const res = await fetch(`${VK_API}/${method}`, { method: 'POST', body });
  const json = await res.json();
  if (json.error) {
    throw new Error(`vk ${method}: [${json.error.error_code}] ${json.error.error_msg}`);
  }
  return json.response;
}

async function uploadPhotosToPeer(token, groupId, peerId, bufs, filenames) {
  const upload = await vkApi(token, 'photos.getMessagesUploadServer', {
    group_id: groupId,
  });
  const attachments = [];
  for (let i = 0; i < bufs.length; i++) {
    const form = new FormData();
    form.append('photo', new Blob([bufs[i]], { type: 'image/jpeg' }), filenames[i] || `photo${i + 1}.jpg`);
    const upRes = await fetch(upload.upload_url, { method: 'POST', body: form });
    const upJson = await upRes.json();
    if (!upJson.photo) throw new Error(`upload photo failed: ${JSON.stringify(upJson).slice(0, 300)}`);
    const saved = await vkApi(token, 'photos.saveMessagesPhoto', {
      server: upJson.server,
      photo: upJson.photo,
      hash: upJson.hash,
    });
    const p = saved[0];
    attachments.push(`photo${p.owner_id}_${p.id}_${p.access_key}`);
  }
  return attachments.join(',');
}

async function uploadVideoToPeer(token, groupId, buf, filename) {
  const save = await vkApi(token, 'video.save', {
    group_id: groupId,
    name: filename || 'video.mp4',
    is_private: 1,
    wallpost: 0,
    no_comments: 1,
  });
  const form = new FormData();
  form.append('video_file', new Blob([buf]), filename || 'video.mp4');
  const upRes = await fetch(save.upload_url, { method: 'POST', body: form });
  const text = await upRes.text();
  let up;
  try { up = JSON.parse(text); } catch (e) { up = { error: text.slice(0, 200) }; }
  if (!up || up.error) throw new Error(`upload video failed: ${JSON.stringify(up).slice(0, 300)}`);
  return `video${save.owner_id}_${up.video_id}_${save.access_key}`;
}

export function filterPeerList(convs) {
  const peers = [];
  for (const it of (convs || [])) {
    const p = it.conversation && it.conversation.peer;
    if (!p) continue;
    const canWrite = it.conversation.can_write && it.conversation.can_write.allowed !== false;
    if (!canWrite) continue;
    peers.push(p.id);
  }
  return peers;
}

async function discoverPeers(token, configured) {
  if (configured && configured.length) {
    return configured.map(Number).filter((n) => Number.isFinite(n));
  }
  const convs = await vkApi(token, 'messages.getConversations', { count: 200 });
  return filterPeerList(convs.items || []);
}

/* Собрать видео из base64-чанков (submissions/{id}/chunks, документы ~850КБ
   base64 каждый — клиент режет так, чтобы не упереться в лимит Firestore 1МБ).
   Каждый чанк декодируем отдельно и склеиваем байты: это не зависит от
   выравнивания base64 по 4 символам и переживает пропущенные чанки. */
export function joinChunks(parts, n) {
  const bufs = [];
  for (let i = 0; i < n; i++) {
    const b64 = parts[i];
    if (!b64) continue;
    bufs.push(Buffer.from(b64, 'base64'));
  }
  return bufs.length ? Buffer.concat(bufs) : null;
}

async function loadVideoBuffer(db, snap, sub) {
  if (sub.videoB64) return Buffer.from(sub.videoB64, 'base64');
  if (sub.videoChunks) {
    const snaps = await db.collection('submissions').doc(snap.id).collection('chunks').orderBy('n').get();
    const parts = [];
    snaps.forEach((d) => {
      const data = d.data() || {};
      if (data.kind === 'photo') return;
      parts[Number(data.n)] = data.b64 || '';
    });
    return joinChunks(parts, Number(sub.videoChunks) || parts.length);
  }
  return null;
}

/* Собрать несколько фото заявки: единичное photoB64 лежит в документе,
   множественные — чанки kind:'photo' в подколлекции (лимит 1МБ документа). */
async function loadPhotoBuffers(db, snap, sub) {
  if (Array.isArray(sub.photoB64s) && sub.photoB64s.length) {
    return sub.photoB64s.map((b64) => Buffer.from(b64, 'base64'));
  }
  if (sub.photoB64) return [Buffer.from(sub.photoB64, 'base64')];
  if (sub.photoCount) {
    const snaps = await db.collection('submissions').doc(snap.id)
      .collection('chunks').where('kind', '==', 'photo').get();
    const byN = [];
    snaps.forEach((d) => {
      const data = d.data() || {};
      byN[Number(data.n)] = data.b64 || '';
    });
    return byN.filter(Boolean).map((b64) => Buffer.from(b64, 'base64'));
  }
  return [];
}

async function sendToPeers(env, db, snap, peers, sub, attachment) {
  const msgIds = {};
  for (const peer of peers) {
    const sent = await vkApi(env.VK_TOKEN, 'messages.send', {
      peer_id: peer,
      random_id: Math.floor(Math.random() * 0x7fffffff),
      message: buildCaption(sub),
      attachment,
    });
    msgIds[peer] = sent;
    console.log(`sent ${snap.id} -> peer ${peer} msgId=${sent}`);
  }
  await snap.ref.update({ sent: true, msgIds, sentAt: FieldValue.serverTimestamp() });
}

async function sendSubmission(env, db, bucket, snap, peers) {
  const sub = snap.data();

  // Видео: чанки в подколлекции → собираем → заливаем в VK как сообщество-видео.
  if (sub.videoChunks || sub.videoB64) {
    const vbuf = await loadVideoBuffer(db, snap, sub);
    if (!vbuf || !vbuf.length) {
      await snap.ref.update({ sent: true, skipped: true, sentAt: FieldValue.serverTimestamp() });
      console.log(`skip ${snap.id} (empty video)`);
      return;
    }
    const attachment = await uploadVideoToPeer(env.VK_TOKEN, env.VK_GROUP_ID, vbuf, sub.videoName || 'video.mp4');
    await sendToPeers(env, db, snap, peers, sub, attachment);
    return;
  }

  const bufs = await loadPhotoBuffers(db, snap, sub);
  if (!bufs.length) {
    await snap.ref.update({ sent: true, skipped: true, sentAt: FieldValue.serverTimestamp() });
    console.log(`skip ${snap.id} (no media)`);
    return;
  }
  const attachment = await uploadPhotosToPeer(env.VK_TOKEN, env.VK_GROUP_ID, peers[0], bufs, []);
  await sendToPeers(env, db, snap, peers, sub, attachment);
}

async function scanAndDecide(env, db, submissions, peers) {
  const decided = new Set();
  for (const peer of peers) {
    const history = await vkApi(env.VK_TOKEN, 'messages.getHistory', { peer_id: peer, count: 100 });
    for (const snap of submissions) {
      if (decided.has(snap.id)) continue;
      const sub = snap.data();
      if (sub.state !== 'pending' || !sub.msgIds || sub.msgIds[peer] == null) continue;
      const replies = findDecisionMessages(history.items, sub.msgIds[peer]);
      let decision = null;
      for (const r of replies) {
        decision = parseDecision(r.text);
        if (decision) {
          console.log(`decision ${snap.id}: ${decision} from ${r.fromId} (peer ${peer})`);
          break;
        }
      }
      if (!decision) continue;
      decided.add(snap.id);
      await snap.ref.update({
        state: decision,
        decidedBy: null,
        decidedAt: FieldValue.serverTimestamp(),
      });
      if (decision === 'approve' && sub.uid) {
        const apply = { updatedAt: FieldValue.serverTimestamp() };
        // Командное с медиа (noAward): баллы всей команде начислит организатор
        // через админку — бот лично участнику не начисляет.
        if (!sub.noAward) apply.score = FieldValue.increment(sub.points || 0);
        // update() трактует точку в ключе как вложенный путь (done.taskId = true),
        // в отличие от set(merge), который создал бы буквальное поле "done.6toZ...".
        try {
          await db.doc(`users/${sub.uid}`).update(
            { ...apply, [`done.${sub.taskId}`]: true }
          );
        } catch (e) {
          await db.doc(`users/${sub.uid}`).set(
            { ...apply, done: { [sub.taskId]: true } },
            { merge: true }
          );
        }
        console.log(`awarded ${sub.noAward ? '(team) ' : ''}${sub.points} to ${sub.uid}`);
      }
      const statusText = buildStatusText(sub, decision);
      for (const other of peers) {
        if (other === peer) continue;
        const msgId = sub.msgIds[other];
        if (msgId == null) continue;
        try {
          await vkApi(env.VK_TOKEN, 'messages.edit', {
            peer_id: other,
            message_id: msgId,
            message: statusText,
          });
          console.log(`status ${snap.id} -> peer ${other} (msgId=${msgId}): ${decision}`);
        } catch (e) {
          console.warn(`status edit fail peer ${other}: ${e.message}`);
        }
      }
      const ack = decision === 'approve'
        ? (sub.noAward
            ? `✅ Принято! Участие «${sub.name || sub.uid}» засчитано. Баллы команде начислит организатор.`
            : `✅ Засчитано! Участнику «${sub.name || sub.uid}» начислено +${sub.points} б. Спасибо за помощь!`)
        : `❌ Отклонено. Участнику «${sub.name || sub.uid}» баллы не начислены. Спасибо за проверку!`;
      try {
        await vkApi(env.VK_TOKEN, 'messages.send', {
          peer_id: peer,
          random_id: Math.floor(Math.random() * 0x7fffffff),
          message: ack,
        });
        console.log(`ack ${snap.id} -> peer ${peer}: ${decision}`);
      } catch (e) {
        console.warn(`ack fail peer ${peer}: ${e.message}`);
      }
    }
  }
}

export async function runBot(env) {
  const { VK_TOKEN, VK_GROUP_ID, SA_PATH, VK_PEERS, VK_CHAT_ID } = env;
  if (!VK_TOKEN || !VK_GROUP_ID || !SA_PATH) {
    throw new Error('missing env: need VK_TOKEN, VK_GROUP_ID, SA_PATH');
  }
  const sa = JSON.parse(readFileSync(SA_PATH, 'utf8'));
  const app = initializeApp({ credential: cert(sa), projectId: PROJECT_ID });
  const db = getFirestore(app);
  const bucket = getStorage(app).bucket(BUCKET);

  const cfgRef = db.doc('config/peers');
  let peers;
  const configured = (VK_PEERS || env.VK_CHAT_ID) ? String(VK_PEERS || env.VK_CHAT_ID).split(',').filter(Boolean) : null;
  const cfgSnap = await cfgRef.get();
  if (configured && configured.length) {
    peers = configured.map(Number).filter((n) => Number.isFinite(n));
  } else {
    const discovered = await discoverPeers(VK_TOKEN, null);
    const cached = (cfgSnap.exists && cfgSnap.data().peers) || [];
    peers = [...new Set([...discovered, ...cached])];
    const same = JSON.stringify([...peers].sort()) === JSON.stringify([...(cached || [])].sort());
    if (!same) {
      await cfgRef.set({ peers, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      console.log(`peers changed: ${peers.join(', ')}`);
    }
  }
  console.log(`peers: ${peers.join(', ')}`);

  const pending = await db.collection('submissions').where('sent', '==', false).limit(10).get();
  for (const snap of pending.docs) {
    try {
      await sendSubmission(env, db, bucket, snap, peers);
    } catch (e) {
      console.error(`submission ${snap.id} send failed:`, e.message);
    }
  }

  const undecided = await db.collection('submissions').where('sent', '==', true).where('state', '==', 'pending').limit(10).get();
  await scanAndDecide(env, db, undecided.docs, peers);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBot({
    VK_TOKEN: process.env.VK_TOKEN,
    VK_GROUP_ID: process.env.VK_GROUP_ID,
    VK_PEERS: process.env.VK_PEERS,
    VK_CHAT_ID: process.env.VK_CHAT_ID,
    SA_PATH: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  }).then(
    () => process.exit(0),
    (e) => {
      console.error('BOT FAIL:', e);
      process.exit(1);
    },
  );
}
