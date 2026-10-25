// FitX Call — messaging: text, voice messages, photos, videos.
// Free Firebase plan has no file Storage, so media is stored in Firestore split into ~900 KB pieces.
import {
  doc, collection, setDoc, updateDoc, addDoc, getDoc, getDocs, deleteDoc, query, where, orderBy, limit,
  onSnapshot, serverTimestamp, increment, Bytes,
} from 'firebase/firestore';

const PART = 900 * 1024;
const MAX_VIDEO = 8 * 1024 * 1024;   // keeps the free 1 GB database allowance safe
const KEEP_DAYS = 30;               // photos / voice / video auto-delete after 30 days
const MAX_IMAGE_IN = 30 * 1024 * 1024;
const MAX_VOICE_SEC = 180;

export function createChat(ctx) {
  const { getDb, getMe, getUsers, toast, show, startCall, Native, native, esc, initials, ago, $ } = ctx;
  let unsubList = null, unsubMsgs = null;
  let chats = [];
  let open = null;            // { id, peer: {uid,name}, ref }
  let firstList = true;
  const lastSeenAt = {};
  const mediaCache = new Map();
  let pending = [];           // local "sending…" bubbles

  const chatIdFor = (a, b) => [a, b].sort().join('_');
  const fmtSec = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const preview = (m) => (m.type === 'text' ? m.text : m.type === 'image' ? '📷 Photo' : m.type === 'video' ? '🎬 Video' : '🎤 Voice message');

  // ---------------- Chat list ----------------
  function start() {
    stop();
    firstList = true;
    const me = getMe();
    unsubList = onSnapshot(query(collection(getDb(), 'chats'), where('members', 'array-contains', me.uid)), (snap) => {
      chats = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
      for (const c of chats) {
        const prev = lastSeenAt[c.id];
        lastSeenAt[c.id] = c.lastAt || 0;
        if (firstList || !c.lastAt || c.lastFrom === me.uid || (prev && c.lastAt <= prev)) continue;
        if (open && open.id === c.id && !document.hidden) continue;
        const name = (c.names && c.names[c.lastFrom]) || 'FitX';
        if (native) Native.showMessage({ chatId: c.id, fromName: name, text: c.lastText || 'New message' }).catch(() => {});
        if (!open || open.id !== c.id) toast(`💬 ${name}: ${c.lastText || 'New message'}`, 3000);
      }
      firstList = false;
      renderList();
    }, () => {});
    setTimeout(cleanupOldMedia, 20000);
  }
  // Free-plan housekeeping: delete my own photos/voice/videos older than KEEP_DAYS (text stays).
  async function cleanupOldMedia() {
    const me = getMe(); const db = getDb(); if (!me) return;
    try {
      const k = 'fitx-clean-' + me.uid;
      try { if (Date.now() - Number(localStorage.getItem(k) || 0) < 86400000) return; localStorage.setItem(k, String(Date.now())); } catch (e) {}
      const cutoff = Date.now() - KEEP_DAYS * 86400000;
      const snap = await getDocs(query(collection(db, 'media'), where('owner', '==', me.uid)));
      for (const d of snap.docs) {
        if ((d.data().createdAtMs || 0) > cutoff) continue;
        const n = d.data().parts || 1;
        for (let i = 0; i < n; i++) await deleteDoc(doc(db, 'media', d.id, 'parts', String(i))).catch(() => {});
        await deleteDoc(d.ref).catch(() => {});
      }
    } catch (e) { /* try again tomorrow */ }
  }
  function stop() {
    if (unsubList) unsubList(); unsubList = null;
    if (unsubMsgs) unsubMsgs(); unsubMsgs = null;
    open = null; chats = [];
  }
  function renderList() {
    const me = getMe(); if (!me) return;
    let total = 0;
    $('chats').innerHTML = chats.length ? chats.map((c) => {
      const peerUid = c.members.find((u) => u !== me.uid) || me.uid;
      const name = (c.names && c.names[peerUid]) || 'Employee';
      const n = (c.unread && c.unread[me.uid]) || 0; total += n;
      return `<li data-open="${esc(c.id)}">
        <div class="avatar">${esc(initials(name))}</div>
        <div class="who"><b>${esc(name)}</b><small>${c.lastFrom === me.uid ? 'You: ' : ''}${esc(c.lastText || '')}</small></div>
        <div class="meta"><span>${c.lastAt ? esc(ago(c.lastAt)) : ''}</span>${n ? `<span class="unread">${n}</span>` : ''}</div>
      </li>`;
    }).join('') : '<li class="empty">No messages yet — tap 💬 next to a colleague in Team</li>';
    $('chat-badge').textContent = total > 99 ? '99+' : total;
    $('chat-badge').classList.toggle('hidden', !total);
  }
  $('chats').addEventListener('click', (e) => {
    const li = e.target.closest('[data-open]'); if (!li) return;
    const c = chats.find((x) => x.id === li.dataset.open); if (!c) return;
    const me = getMe();
    const peerUid = c.members.find((u) => u !== me.uid) || me.uid;
    openWith({ uid: peerUid, name: (c.names && c.names[peerUid]) || 'Employee' });
  });

  // ---------------- Open a conversation ----------------
  async function openWith(peer) {
    const me = getMe(); const db = getDb();
    const id = chatIdFor(me.uid, peer.uid);
    const ref = doc(db, 'chats', id);
    const members = [me.uid, peer.uid].sort();
    open = { id, peer, ref };
    pending = [];
    $('chat-name').textContent = peer.name;
    $('chat-avatar').textContent = initials(peer.name);
    const u = getUsers().find((x) => x.uid === peer.uid);
    $('chat-sub').textContent = u && u.department ? u.department : '';
    $('msgs').innerHTML = '<div class="day">Loading…</div>';
    closeAttach(); setComposer();
    show('s-chat');
    try {
      await setDoc(ref, { members, names: { [me.uid]: me.name, [peer.uid]: peer.name }, [`unread`]: { [me.uid]: 0 } }, { merge: true });
    } catch (e) { toast('Could not open chat — check the database rules'); }
    if (unsubMsgs) unsubMsgs();
    unsubMsgs = onSnapshot(query(collection(ref, 'messages'), orderBy('createdAtMs', 'desc'), limit(150)), (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).reverse();
      renderMsgs(list);
      if (!document.hidden) updateDoc(ref, { [`unread.${me.uid}`]: 0 }).catch(() => {});
    }, () => { $('msgs').innerHTML = '<div class="day">Could not load messages</div>'; });
  }
  function close() {
    if (unsubMsgs) unsubMsgs(); unsubMsgs = null;
    stopRecording(true);
    open = null;
    show('s-main');
    renderList();
  }
  $('chat-back').addEventListener('click', close);
  $('chat-voice').addEventListener('click', () => open && startCall(open.peer, 'audio'));
  $('chat-video').addEventListener('click', () => open && startCall(open.peer, 'video'));

  // ---------------- Render messages ----------------
  let lastList = [];
  function renderMsgs(list) {
    lastList = list;
    const me = getMe();
    const box = $('msgs');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    let html = '', lastDay = '';
    for (const m of list) {
      const day = new Date(m.createdAtMs).toDateString();
      if (day !== lastDay) { lastDay = day; html += `<div class="day">${esc(dayLabel(m.createdAtMs))}</div>`; }
      html += bubble(m, m.from === me.uid);
    }
    for (const p of pending) html += `<div class="msg me"><span class="loading">${esc(p.label)}</span></div>`;
    box.innerHTML = html || '<div class="day">Say hello 👋</div>';
    if (atBottom || list.length < 3 || pending.length) box.scrollTop = box.scrollHeight;
  }
  function dayLabel(t) {
    const d = new Date(t), now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function bubble(m, mine) {
    const t = `<span class="t">${hhmm(m.createdAtMs)}</span>`;
    const cls = `msg${mine ? ' me' : ''}`;
    if (m.type === 'image') {
      return `<div class="${cls}"><img class="media" data-media="${esc(m.mediaId)}" data-mime="${esc(m.mime)}" src="${esc(m.thumb || '')}" alt="Photo">${t}</div>`;
    }
    if (m.type === 'video') {
      const bg = m.thumb ? `style="background-image:url('${esc(m.thumb)}')"` : '';
      return `<div class="${cls}"><div class="vthumb" data-media="${esc(m.mediaId)}" data-mime="${esc(m.mime)}" data-kind="video" ${bg}><svg><use href="#i-play"/></svg></div><span class="t">🎬 ${m.duration ? fmtSec(m.duration) + ' · ' : ''}${fmtSize(m.size || 0)} · ${hhmm(m.createdAtMs)}</span></div>`;
    }
    if (m.type === 'audio') {
      return `<div class="${cls}"><div class="audio" data-media="${esc(m.mediaId)}" data-mime="${esc(m.mime)}"><button aria-label="Play"><svg><use href="#i-play"/></svg></button><div class="bar"><i></i></div><small>${fmtSec(m.duration || 0)}</small></div>${t}</div>`;
    }
    return `<div class="${cls}">${esc(m.text)}${t}</div>`;
  }

  // ---------------- Media load / play ----------------
  async function loadMedia(id, mime) {
    if (mediaCache.has(id)) return mediaCache.get(id);
    const db = getDb();
    const meta = await getDoc(doc(db, 'media', id));
    if (!meta.exists()) throw new Error('expired');
    const n = meta.data().parts || 1;
    const chunks = await Promise.all(Array.from({ length: n }, (_, i) => getDoc(doc(db, 'media', id, 'parts', String(i)))));
    const blob = new Blob(chunks.map((c) => c.data().d.toUint8Array()), { type: meta.data().mime || mime });
    const url = URL.createObjectURL(blob);
    mediaCache.set(id, url);
    return url;
  }
  let playing = null;
  $('msgs').addEventListener('click', async (e) => {
    const img = e.target.closest('img.media');
    const vid = e.target.closest('.vthumb');
    const aud = e.target.closest('.audio button');
    if (img) {
      viewer(`<img src="${esc(img.src)}">`);
      try { const url = await loadMedia(img.dataset.media, img.dataset.mime); if (!$('viewer').classList.contains('hidden')) $('viewer-body').innerHTML = `<img src="${url}">`; }
      catch (x) { toast(x.message === 'expired' ? `Photo expired (kept ${KEEP_DAYS} days)` : 'Could not load photo'); }
    } else if (vid) {
      viewer('<p class="muted">Loading video…</p>');
      try { const url = await loadMedia(vid.dataset.media, vid.dataset.mime); if (!$('viewer').classList.contains('hidden')) $('viewer-body').innerHTML = `<video src="${url}" controls autoplay playsinline></video>`; }
      catch (x) { toast(x.message === 'expired' ? `Video expired (kept ${KEEP_DAYS} days)` : 'Could not load video'); closeViewer(); }
    } else if (aud) {
      const box = aud.closest('.audio');
      if (playing && playing.box === box) { if (playing.a.paused) playing.a.play(); else playing.a.pause(); return; }
      if (playing) playing.a.pause();
      aud.innerHTML = '<span class="loading">…</span>';
      try {
        const url = await loadMedia(box.dataset.media, box.dataset.mime);
        const a = new Audio(url);
        playing = { a, box };
        const btn = () => box.querySelector('button');
        a.onplay = () => { btn().innerHTML = '<svg><use href="#i-pause"/></svg>'; };
        a.onpause = () => { btn().innerHTML = '<svg><use href="#i-play"/></svg>'; };
        a.onended = () => { btn().innerHTML = '<svg><use href="#i-play"/></svg>'; box.querySelector('.bar i').style.width = '0'; playing = null; };
        a.ontimeupdate = () => { if (a.duration && isFinite(a.duration)) box.querySelector('.bar i').style.width = (100 * a.currentTime / a.duration) + '%'; };
        await a.play();
      } catch (x) { aud.innerHTML = '<svg><use href="#i-play"/></svg>'; toast(x.message === 'expired' ? `Voice message expired (kept ${KEEP_DAYS} days)` : 'Could not play voice message'); }
    }
  });
  function viewer(html) { $('viewer-body').innerHTML = html; $('viewer').classList.remove('hidden'); }
  function closeViewer() {
    $('viewer').classList.add('hidden');
    const v = $('viewer-body').querySelector('video'); if (v) v.pause();
    $('viewer-body').innerHTML = '';
  }
  $('viewer-close').addEventListener('click', closeViewer);

  // ---------------- Sending ----------------
  async function sendMessage(data) {
    if (!open) return;
    const me = getMe(); const { ref, peer } = open;
    const now = Date.now();
    await addDoc(collection(ref, 'messages'), { ...data, from: me.uid, createdAtMs: now, createdAt: serverTimestamp() });
    await updateDoc(ref, { lastText: preview(data).slice(0, 80), lastAt: now, lastFrom: me.uid, [`unread.${peer.uid}`]: increment(1) }).catch(() => {});
  }
  async function uploadMedia(blob, onProgress) {
    const db = getDb(); const me = getMe();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const parts = Math.max(1, Math.ceil(bytes.length / PART));
    const ref = doc(collection(db, 'media'));
    await setDoc(ref, { chatId: open.id, owner: me.uid, mime: blob.type, size: bytes.length, parts, createdAtMs: Date.now() });
    for (let i = 0; i < parts; i++) {
      await setDoc(doc(ref, 'parts', String(i)), { d: Bytes.fromUint8Array(bytes.subarray(i * PART, (i + 1) * PART)) });
      onProgress && onProgress(i + 1, parts);
    }
    mediaCache.set(ref.id, URL.createObjectURL(blob));
    return { mediaId: ref.id, size: bytes.length, mime: blob.type };
  }
  async function withPending(label, fn) {
    const p = { label }; pending.push(p); renderMsgs(lastList);
    try { await fn((txt) => { p.label = txt; renderMsgs(lastList); }); }
    catch (e) { console.warn(e); toast('Sending failed — check internet'); }
    pending = pending.filter((x) => x !== p); renderMsgs(lastList);
  }

  // Text
  const input = $('msg-input');
  function setComposer() {
    const has = input.value.trim().length > 0;
    $('send-btn').classList.toggle('hidden', !has);
    $('mic-btn').classList.toggle('hidden', has);
  }
  input.addEventListener('input', setComposer);
  input.addEventListener('focus', closeAttach);
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim(); if (!text || !open) return;
    input.value = ''; setComposer();
    sendMessage({ type: 'text', text: text.slice(0, 4000) }).catch(() => toast('Message not sent — check internet'));
  });

  // Attachments
  function closeAttach() { $('attach-menu').classList.add('hidden'); }
  $('attach-btn').addEventListener('click', () => $('attach-menu').classList.toggle('hidden'));
  $('attach-menu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]'); if (!b) return;
    const f = $('file-pick');
    f.value = ''; f.accept = b.dataset.pick;
    if (b.dataset.cap) f.setAttribute('capture', b.dataset.cap); else f.removeAttribute('capture');
    closeAttach();
    f.click();
  });
  $('file-pick').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0]; if (!file || !open) return;
    if (file.type.startsWith('image/')) sendImage(file);
    else if (file.type.startsWith('video/')) sendVideo(file);
    else toast('Only photos and videos can be sent');
  });

  async function sendImage(file) {
    if (file.size > MAX_IMAGE_IN) return toast('Photo is too large');
    await withPending('📷 Preparing photo…', async (upd) => {
      const full = await resizeImage(file, 1600, 0.8);
      const thumb = await blobToDataUrl(await resizeImage(file, 320, 0.6));
      upd('📷 Sending photo…');
      const m = await uploadMedia(full, (i, n) => n > 1 && upd(`📷 Sending photo ${i}/${n}…`));
      await sendMessage({ type: 'image', ...m, thumb });
    });
  }
  async function sendVideo(file) {
    if (file.size > MAX_VIDEO) return toast(`Video is ${fmtSize(file.size)} — max ${fmtSize(MAX_VIDEO)}. Send a shorter clip.`, 4500);
    await withPending('🎬 Preparing video…', async (upd) => {
      const { thumb, duration } = await videoPoster(file);
      const blob = file.type ? file : new Blob([file], { type: 'video/mp4' });
      const m = await uploadMedia(blob, (i, n) => upd(`🎬 Sending video ${Math.round(100 * i / n)}%…`));
      await sendMessage({ type: 'video', ...m, thumb, duration });
    });
  }

  // ---------------- Voice messages ----------------
  let rec = null;
  async function startRecording() {
    if (rec || !open) return;
    if (!window.MediaRecorder) return toast('Voice messages not supported on this phone');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { return toast('Allow microphone permission'); }
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const mr = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
    const chunks = [];
    mr.ondataavailable = (ev) => ev.data && ev.data.size && chunks.push(ev.data);
    rec = { mr, stream, chunks, started: Date.now(), cancel: false };
    mr.onstop = () => {
      const r = rec; rec = null;
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(r.timer);
      $('rec-bar').classList.add('hidden'); $('composer').classList.remove('hidden');
      if (r.cancel) return;
      const duration = Math.round((Date.now() - r.started) / 1000);
      if (duration < 1) return toast('Too short — tap the mic, speak, then tap send');
      const blob = new Blob(chunks, { type: (mr.mimeType || 'audio/webm').split(';')[0] });
      withPending('🎤 Sending voice message…', async () => {
        const m = await uploadMedia(blob);
        await sendMessage({ type: 'audio', ...m, duration });
      });
    };
    mr.start(1000);
    $('composer').classList.add('hidden'); closeAttach(); $('rec-bar').classList.remove('hidden');
    $('rec-time').textContent = '0:00';
    rec.timer = setInterval(() => {
      const s = (Date.now() - rec.started) / 1000;
      $('rec-time').textContent = fmtSec(s);
      if (s >= MAX_VOICE_SEC) stopRecording(false);
    }, 250);
  }
  function stopRecording(cancel) {
    if (!rec) return;
    rec.cancel = cancel;
    try { rec.mr.stop(); } catch (e) { rec = null; }
  }
  $('mic-btn').addEventListener('click', startRecording);
  $('rec-send').addEventListener('click', () => stopRecording(false));
  $('rec-cancel').addEventListener('click', () => stopRecording(true));

  // ---------------- Helpers ----------------
  async function resizeImage(file, max, q) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', q));
    } finally { URL.revokeObjectURL(url); }
  }
  function blobToDataUrl(b) { return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); }); }
  async function videoPoster(file) {
    const url = URL.createObjectURL(file);
    try {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = url;
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; setTimeout(res, 4000); });
      const duration = isFinite(v.duration) ? Math.round(v.duration) : 0;
      try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); await new Promise((res) => { v.onseeked = res; setTimeout(res, 2000); }); } catch (e) {}
      let thumb = '';
      if (v.videoWidth) {
        const s = Math.min(1, 320 / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        thumb = c.toDataURL('image/jpeg', 0.6);
      }
      return { thumb, duration };
    } catch (e) { return { thumb: '', duration: 0 }; }
    finally { URL.revokeObjectURL(url); }
  }

  return {
    start, stop, openWith, close,
    isOpen: () => !!open && !$('s-chat').classList.contains('hidden'),
    isOpenAny: () => !!open,
    viewerOpen: () => !$('viewer').classList.contains('hidden'),
    closeViewer,
    resume() { if (open && !$('s-chat').classList.contains('hidden')) updateDoc(open.ref, { [`unread.${getMe().uid}`]: 0 }).catch(() => {}); },
  };
}
