// FitX Call — conference calls.
// App participants connect to each other directly (WebRTC "mesh": voice up to 6, video up to 4).
// The host can also dial outside phone numbers through SIP; the host's phone mixes that audio in
// (Web Audio), so everyone hears the outside caller and the outside caller hears everyone.
import {
  doc, collection, setDoc, updateDoc, getDoc, addDoc, onSnapshot, query, where,
  arrayUnion, arrayRemove,
} from 'firebase/firestore';
import { iceConfig, loadTurn } from './call.js';

export const MAX_VOICE = 6;
export const MAX_VIDEO = 4;

function confMedia(type) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  return type === 'video'
    ? { audio, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 20, max: 24 } } }
    : { audio, video: false };
}

async function capSenders(pc) {
  for (const s of pc.getSenders()) {
    if (!s.track) continue;
    const p = s.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = s.track.kind === 'audio' ? 40000 : 450000;
    if (s.track.kind === 'video') p.encodings[0].maxFramerate = 20;
    try { await s.setParameters(p); } catch (e) {}
  }
}

/**
 * ctx: { db, me: {uid,name}, sip, onUpdate(state), onEnded(why) }
 * One Conference object per conference the user is in.
 */
export class Conference {
  constructor(ctx, id) {
    Object.assign(this, ctx);
    this.id = id;
    this.ref = doc(this.db, 'confs', id);
    this.peers = new Map();     // uid -> { pc, stream, name, state, unsubs[] }
    this.legs = new Map();      // legId -> { call, number, status, stream }
    this.unsubs = [];
    this.ended = false;
    this.muted = false;
    this.camOn = true;
    this.data = null;
    this.startedAt = null;
  }

  // ---------------- lifecycle ----------------
  static async create(ctx, { type, invitees }) {
    const ref = doc(collection(ctx.db, 'confs'));
    const ids = invitees.map((u) => u.uid);
    const names = { [ctx.me.uid]: ctx.me.name };
    invitees.forEach((u) => { names[u.uid] = u.name; });
    await setDoc(ref, {
      host: ctx.me.uid, hostName: ctx.me.name, type, status: 'active', createdAtMs: Date.now(),
      allowed: [ctx.me.uid, ...ids], invited: ids, joined: [], names, ext: [],
    });
    const c = new Conference(ctx, ref.id);
    await c.join();
    return c;
  }

  async join() {
    const snap = await getDoc(this.ref);
    if (!snap.exists() || snap.data().status !== 'active') throw new Error('This group call has ended');
    this.data = snap.data();
    this.type = this.data.type;
    this.isHost = this.data.host === this.me.uid;
    const max = this.type === 'video' ? MAX_VIDEO : MAX_VOICE;
    if ((this.data.joined || []).length >= max) throw new Error(`Group call is full (max ${max})`);
    await loadTurn();
    this.local = await navigator.mediaDevices.getUserMedia(confMedia(this.type));
    this.joinAt = Date.now();
    await updateDoc(this.ref, { joined: arrayUnion(this.me.uid), invited: arrayRemove(this.me.uid), [`names.${this.me.uid}`]: this.me.name });
    this.startedAt = Date.now();
    // Watch the conference: who is in it, who left, whether it ended.
    this.unsubs.push(onSnapshot(this.ref, (s) => this.onConf(s.data())));
    // Offers addressed to me (the member with the larger uid answers).
    this.unsubs.push(onSnapshot(query(collection(this.ref, 'pairs'), where('to', '==', this.me.uid)), (s) => {
      s.docChanges().forEach((ch) => {
        const d = ch.doc.data();
        if (ch.type === 'added' && d && (d.at || 0) > this.joinAt - 60000) this.answerPair(ch.doc); // skip offers from an earlier session
      });
    }));
  }

  onConf(d) {
    if (!d || this.ended) return;
    this.data = d;
    if (d.status !== 'active') return this.finish(this.isHost ? 'Group call ended' : 'The host ended the group call');
    const joined = d.joined || [];
    for (const uid of joined) {
      if (uid === this.me.uid || this.peers.has(uid)) continue;
      // Deterministic: the smaller uid makes the offer, so two people never both offer.
      if (this.me.uid < uid) this.offerTo(uid);
    }
    for (const uid of [...this.peers.keys()]) if (!joined.includes(uid)) this.dropPeer(uid);
    this.emit();
  }

  // ---------------- peer connections ----------------
  newPeer(uid) {
    const pc = new RTCPeerConnection(iceConfig());
    const p = { pc, stream: new MediaStream(), name: (this.data.names || {})[uid] || 'Employee', state: 'connecting', unsubs: [] };
    this.peers.set(uid, p);
    const outAudio = this.mixer ? this.mixer.toPeers.stream.getAudioTracks()[0] : this.local.getAudioTracks()[0];
    const outStream = new MediaStream([outAudio, ...this.local.getVideoTracks()]);
    outStream.getTracks().forEach((t) => pc.addTrack(t, outStream));
    pc.ontrack = (e) => {
      (e.streams[0] ? e.streams[0].getTracks() : [e.track]).forEach((t) => { if (!p.stream.getTracks().includes(t)) p.stream.addTrack(t); });
      if (e.track.kind === 'audio' && this.mixer) this.mixer.addPeer(uid, p.stream);
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      p.state = st === 'connected' ? 'connected' : st === 'failed' ? 'failed' : st === 'disconnected' ? 'reconnecting' : p.state;
      if (st === 'connected') capSenders(pc);
      this.emit();
    };
    return p;
  }

  async offerTo(uid) {
    const p = this.newPeer(uid);
    const pref = doc(this.ref, 'pairs', `${this.me.uid}__${uid}__${Date.now().toString(36)}`);
    p.pc.onicecandidate = (e) => { if (e.candidate) addDoc(collection(pref, 'ca'), e.candidate.toJSON()).catch(() => {}); };
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    await setDoc(pref, { from: this.me.uid, to: uid, offer: { type: offer.type, sdp: offer.sdp }, at: Date.now() });
    const pending = [];
    p.unsubs.push(onSnapshot(pref, async (s) => {
      const d = s.data();
      if (d && d.answer && !p.pc.currentRemoteDescription) {
        try { await p.pc.setRemoteDescription(d.answer); for (const c of pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {}); } catch (e) {}
      }
    }));
    p.unsubs.push(onSnapshot(collection(pref, 'cb'), (s) => s.docChanges().forEach((ch) => {
      if (ch.type !== 'added') return;
      const c = new RTCIceCandidate(ch.doc.data());
      if (p.pc.currentRemoteDescription) p.pc.addIceCandidate(c).catch(() => {}); else pending.push(c);
    })));
  }

  async answerPair(pairDoc) {
    const d = pairDoc.data();
    if (!d || !d.offer || this.ended) return;
    const uid = d.from;
    if (this.peers.has(uid)) this.dropPeer(uid, true); // they re-offered (e.g. rejoined)
    const p = this.newPeer(uid);
    const pref = pairDoc.ref;
    p.pc.onicecandidate = (e) => { if (e.candidate) addDoc(collection(pref, 'cb'), e.candidate.toJSON()).catch(() => {}); };
    await p.pc.setRemoteDescription(d.offer);
    const ans = await p.pc.createAnswer();
    await p.pc.setLocalDescription(ans);
    await updateDoc(pref, { answer: { type: ans.type, sdp: ans.sdp } });
    p.unsubs.push(onSnapshot(collection(pref, 'ca'), (s) => s.docChanges().forEach((ch) => {
      if (ch.type === 'added') p.pc.addIceCandidate(new RTCIceCandidate(ch.doc.data())).catch(() => {});
    })));
  }

  dropPeer(uid, silent) {
    const p = this.peers.get(uid); if (!p) return;
    p.unsubs.forEach((u) => u());
    try { p.pc.close(); } catch (e) {}
    this.peers.delete(uid);
    if (this.mixer) this.mixer.removePeer(uid);
    if (!silent) this.emit();
  }

  // ---------------- inviting ----------------
  async invite(users) {
    const max = this.type === 'video' ? MAX_VIDEO : MAX_VOICE;
    const count = (this.data.joined || []).length + (this.data.invited || []).length + this.legs.size;
    if (count + users.length > max) throw new Error(`Max ${max} people in a ${this.type === 'video' ? 'video' : 'voice'} group call`);
    const upd = { allowed: arrayUnion(...users.map((u) => u.uid)), invited: arrayUnion(...users.map((u) => u.uid)) };
    users.forEach((u) => { upd[`names.${u.uid}`] = u.name; });
    await updateDoc(this.ref, upd);
  }

  // ---------------- outside phone numbers (host, via SIP) ----------------
  async addNumber(number) {
    if (!this.isHost) throw new Error('Only the person who started the call can add phone numbers');
    if (!this.sip || !this.sip.ready()) throw new Error('Set up your SIP account in Settings first');
    const max = this.type === 'video' ? MAX_VIDEO : MAX_VOICE;
    if ((this.data.joined || []).length + this.legs.size >= max) throw new Error(`Max ${max} people`);
    if (!this.mixer) this.startMixer();
    const legId = 'L' + Date.now().toString(36);
    const dest = this.mixer.newLegDest(legId);
    const call = await this.sip.call(number, { mediaStream: dest.stream, leg: true });
    const leg = { call, number, status: 'calling', stream: null };
    this.legs.set(legId, leg);
    call.hooks = {
      onRemoteStream: (stream) => { leg.stream = stream; this.mixer && this.mixer.addLeg(legId, stream); this.emit(); },
      onState: (t) => { leg.status = /ring/i.test(t) ? 'ringing' : leg.status; this.emit(); this.syncExt(); },
      onConnected: () => { leg.status = 'connected'; this.emit(); this.syncExt(); },
      onQuality: () => {},
      onEnded: (why) => {
        this.legs.delete(legId);
        if (this.mixer) this.mixer.removeLeg(legId);
        if (this.toast && why) this.toast(`${number}: ${why}`);
        this.emit(); this.syncExt();
      },
    };
    this.emit(); this.syncExt();
  }
  hangupLeg(legId) { const l = this.legs.get(legId); if (l) l.call.hangup(); }
  syncExt() {
    if (!this.isHost || this.ended) return;
    updateDoc(this.ref, { ext: [...this.legs.values()].map((l) => ({ number: l.number, status: l.status })) }).catch(() => {});
  }
  sendDTMF(legId, d) { const l = this.legs.get(legId); if (l) l.call.sendDTMF(d); }

  // Web Audio mixer (host only, once an outside number is added)
  startMixer() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();
    const micGain = ctx.createGain();
    micGain.gain.value = this.muted ? 0 : 1;
    ctx.createMediaStreamSource(new MediaStream(this.local.getAudioTracks())).connect(micGain);
    const toPeers = ctx.createMediaStreamDestination();   // what app participants hear from me: mic + outside callers
    micGain.connect(toPeers);
    const peerSrc = new Map(), legSrc = new Map(), legDest = new Map();
    const m = {
      ctx, micGain, toPeers,
      newLegDest(id) {                                      // what an outside caller hears: mic + everyone else
        const d = ctx.createMediaStreamDestination();
        micGain.connect(d);
        peerSrc.forEach((src) => src.connect(d));
        legSrc.forEach((src, lid) => { if (lid !== id) src.connect(d); });
        legDest.set(id, d);
        return d;
      },
      addPeer(uid, stream) {
        if (peerSrc.has(uid) || !stream.getAudioTracks().length) return;
        const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        peerSrc.set(uid, src);
        legDest.forEach((d) => src.connect(d));
      },
      removePeer(uid) { const s = peerSrc.get(uid); if (s) { try { s.disconnect(); } catch (e) {} peerSrc.delete(uid); } },
      addLeg(id, stream) {
        if (legSrc.has(id) || !stream.getAudioTracks().length) return;
        const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        legSrc.set(id, src);
        src.connect(toPeers);
        legDest.forEach((d, lid) => { if (lid !== id) src.connect(d); });
      },
      removeLeg(id) {
        const s = legSrc.get(id); if (s) { try { s.disconnect(); } catch (e) {} legSrc.delete(id); }
        const d = legDest.get(id); if (d) { try { micGain.disconnect(d); } catch (e) {} legDest.delete(id); }
      },
      close() { try { ctx.close(); } catch (e) {} },
    };
    this.mixer = m;
    // Existing participants: send them the mixed audio from now on, and feed their voices to outside callers.
    const mixed = toPeers.stream.getAudioTracks()[0];
    this.peers.forEach((p, uid) => {
      p.pc.getSenders().forEach((s) => { if (s.track && s.track.kind === 'audio') s.replaceTrack(mixed).catch(() => {}); });
      m.addPeer(uid, p.stream);
    });
  }

  // ---------------- controls ----------------
  setMuted(on) {
    this.muted = on;
    this.local.getAudioTracks().forEach((t) => { t.enabled = !on; });
    if (this.mixer) this.mixer.micGain.gain.value = on ? 0 : 1;
  }
  setCamera(on) { this.camOn = on; this.local.getVideoTracks().forEach((t) => { t.enabled = on; }); }

  async leave(endForAll) {
    if (this.ended) return;
    try {
      if (endForAll && this.isHost) await updateDoc(this.ref, { status: 'ended', invited: [], joined: arrayRemove(this.me.uid) });
      else await updateDoc(this.ref, { joined: arrayRemove(this.me.uid) });
    } catch (e) {}
    this.finish('');
  }

  finish(why) {
    if (this.ended) return;
    this.ended = true;
    this.endedAt = Date.now();
    this.legs.forEach((l) => { try { l.call.hangup(); } catch (e) {} });
    this.legs.clear();
    [...this.peers.keys()].forEach((uid) => this.dropPeer(uid, true));
    this.unsubs.forEach((u) => u());
    if (this.mixer) this.mixer.close();
    this.local && this.local.getTracks().forEach((t) => t.stop());
    // Last one out closes the conference.
    getDoc(this.ref).then((s) => {
      const d = s.data();
      if (d && d.status === 'active' && !(d.joined || []).length) updateDoc(this.ref, { status: 'ended', invited: [] }).catch(() => {});
    }).catch(() => {});
    this.onEnded && this.onEnded(why);
  }

  emit() { if (!this.ended && this.onUpdate) this.onUpdate(this); }
}
