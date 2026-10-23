// FitX Call — WebRTC engine (HD voice + video, Firestore signaling)
import {
  doc, collection, setDoc, updateDoc, addDoc, onSnapshot, serverTimestamp,
} from 'firebase/firestore';

const CFG = window.FITX_CONFIG || {};

export function iceConfig() {
  return {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
      ...(Array.isArray(CFG.turn) ? CFG.turn : []),
    ],
    iceCandidatePoolSize: 2,
    bundlePolicy: 'max-bundle',
  };
}

// --- HD tuning -------------------------------------------------------------
export function mediaConstraints(type, saver, facing = 'user') {
  const audio = {
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    channelCount: 1, sampleRate: 48000,
  };
  if (type !== 'video') return { audio, video: false };
  const video = saver
    ? { facingMode: facing, width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20, max: 24 } }
    : { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
  return { audio, video };
}

// Opus: wideband HD voice at up to 64 kbps, with in-band FEC so it survives packet loss.
function tuneSdp(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const want = { maxaveragebitrate: '64000', useinbandfec: '1', stereo: '0', maxplaybackrate: '48000' };
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (re.test(sdp)) {
    return sdp.replace(re, (_, params) => {
      const kv = Object.fromEntries(params.split(';').filter(Boolean).map((p) => p.trim().split('=')));
      Object.assign(kv, want);
      return `a=fmtp:${pt} ` + Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(';');
    });
  }
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ` + Object.entries(want).map(([k, v]) => `${k}=${v}`).join(';'));
}

async function tuneSenders(pc, saver) {
  for (const s of pc.getSenders()) {
    if (!s.track) continue;
    const p = s.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    if (s.track.kind === 'audio') {
      p.encodings[0].maxBitrate = 64000;
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
    } else {
      p.encodings[0].maxBitrate = saver ? 450000 : 1800000;
      p.encodings[0].maxFramerate = saver ? 20 : 30;
      p.degradationPreference = 'balanced';
    }
    try { await s.setParameters(p); } catch (e) { /* older WebView */ }
  }
}

// --- Call session ----------------------------------------------------------
/**
 * One call. role: 'caller' | 'callee'
 * hooks: { onRemoteStream, onState(text), onConnected, onEnded(reason), onQuality(text) }
 */
export class CallSession {
  constructor({ db, me, peer, type, role, callId, saver, hooks }) {
    Object.assign(this, { db, me, peer, type, role, saver, hooks });
    this.callRef = callId ? doc(db, 'calls', callId) : doc(collection(db, 'calls'));
    this.id = this.callRef.id;
    this.unsubs = [];
    this.pendingRemote = [];
    this.pendingLocal = [];
    this.docReady = false;
    this.ended = false;
    this.offerRev = 0;
    this.answeredRev = 0;
    this.facing = 'user';
    this.connectedOnce = false;
  }

  async getMedia() {
    this.local = await navigator.mediaDevices.getUserMedia(mediaConstraints(this.type, this.saver, this.facing));
    return this.local;
  }

  makePc() {
    const pc = new RTCPeerConnection(iceConfig());
    this.pc = pc;
    this.local.getTracks().forEach((t) => pc.addTrack(t, this.local));
    this.remote = new MediaStream();
    pc.ontrack = (e) => {
      e.streams[0] ? e.streams[0].getTracks().forEach((t) => this.remote.addTrack(t)) : this.remote.addTrack(e.track);
      this.hooks.onRemoteStream?.(this.remote);
    };
    const mySide = this.role === 'caller' ? 'callerCandidates' : 'calleeCandidates';
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = e.candidate.toJSON();
      if (this.docReady) addDoc(collection(this.callRef, mySide), c).catch(() => {});
      else this.pendingLocal.push(c);
    };
    pc.onconnectionstatechange = () => this.onConn(pc.connectionState);
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'disconnected') {
        this.hooks.onState?.('Reconnecting…');
        clearTimeout(this.discTimer);
        this.discTimer = setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected') this.restartIce();
        }, 3500);
      } else if (s === 'failed') {
        this.restartIce();
      } else if (s === 'connected' || s === 'completed') {
        clearTimeout(this.discTimer);
      }
    };
    return pc;
  }

  onConn(state) {
    if (state === 'connected') {
      clearTimeout(this.failTimer);
      tuneSenders(this.pc, this.saver);
      if (!this.connectedOnce) {
        this.connectedOnce = true;
        this.hooks.onConnected?.();
        this.startStats();
      } else this.hooks.onState?.('');
    }
    if (state === 'failed') {
      clearTimeout(this.failTimer);
      this.failTimer = setTimeout(() => {
        if (this.pc?.connectionState === 'failed') this.hangup('failed');
      }, 15000);
    }
  }

  flushLocal() {
    this.docReady = true;
    const side = this.role === 'caller' ? 'callerCandidates' : 'calleeCandidates';
    this.pendingLocal.splice(0).forEach((c) => addDoc(collection(this.callRef, side), c).catch(() => {}));
  }

  listenRemoteCandidates() {
    const side = this.role === 'caller' ? 'calleeCandidates' : 'callerCandidates';
    this.unsubs.push(onSnapshot(collection(this.callRef, side), (snap) => {
      snap.docChanges().forEach((ch) => {
        if (ch.type !== 'added') return;
        const c = new RTCIceCandidate(ch.doc.data());
        if (this.pc.remoteDescription) this.pc.addIceCandidate(c).catch(() => {});
        else this.pendingRemote.push(c);
      });
    }));
  }

  async drainRemote() {
    for (const c of this.pendingRemote.splice(0)) { try { await this.pc.addIceCandidate(c); } catch (e) {} }
  }

  // ---------- caller ----------
  async start() {
    await this.getMedia();
    this.makePc();
    const offer = await this.pc.createOffer();
    offer.sdp = tuneSdp(offer.sdp);
    await this.pc.setLocalDescription(offer);
    this.offerRev = 1;
    await setDoc(this.callRef, {
      from: this.me.uid, fromName: this.me.name,
      to: this.peer.uid, toName: this.peer.name,
      type: this.type, status: 'ringing',
      createdAt: serverTimestamp(), createdAtMs: Date.now(),
      offer: { type: offer.type, sdp: offer.sdp, rev: 1 },
    });
    this.flushLocal();
    this.listenRemoteCandidates();
    this.unsubs.push(onSnapshot(this.callRef, (snap) => this.onCallerDoc(snap.data())));
    this.ringTimer = setTimeout(() => {
      if (!this.connectedOnce && this.status === 'ringing') this.setStatus('missed').then(() => this.finish('No answer'));
    }, 45000);
  }

  async onCallerDoc(d) {
    if (!d || this.ended) return;
    this.status = d.status;
    if (d.answer && d.answer.rev > this.answeredRev && d.answer.rev === this.offerRev) {
      this.answeredRev = d.answer.rev;
      try {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: d.answer.sdp });
        await this.drainRemote();
      } catch (e) { console.warn('answer', e); }
    }
    if (d.status === 'active') { clearTimeout(this.ringTimer); if (!this.connectedOnce) this.hooks.onState?.('Connecting…'); }
    if (d.status === 'ringing') this.hooks.onState?.(d.delivered ? 'Ringing…' : 'Calling…');
    if (['declined', 'busy', 'ended', 'missed', 'cancelled'].includes(d.status)) {
      const why = { declined: 'Call declined', busy: 'Busy on another call', ended: 'Call ended', missed: 'No answer', cancelled: 'Call ended' }[d.status];
      this.finish(why);
    }
  }

  async restartIce() {
    if (this.ended || !this.pc) return;
    this.hooks.onState?.('Reconnecting…');
    if (this.role !== 'caller') return; // caller drives ICE restarts
    if (this.restarting) return;
    this.restarting = true;
    try {
      const offer = await this.pc.createOffer({ iceRestart: true });
      offer.sdp = tuneSdp(offer.sdp);
      await this.pc.setLocalDescription(offer);
      this.offerRev += 1;
      await updateDoc(this.callRef, { offer: { type: offer.type, sdp: offer.sdp, rev: this.offerRev } });
    } catch (e) { console.warn('restart', e); }
    setTimeout(() => { this.restarting = false; }, 5000);
  }

  // ---------- callee ----------
  async accept(callData) {
    await this.getMedia();
    this.makePc();
    this.listenRemoteCandidates();
    await this.answerOffer(callData.offer, true);
    this.flushLocal();
    this.unsubs.push(onSnapshot(this.callRef, (snap) => this.onCalleeDoc(snap.data())));
  }

  async answerOffer(offer, first) {
    if (!offer || offer.rev <= this.answeredRev) return;
    this.answeredRev = offer.rev;
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    await this.drainRemote();
    const ans = await this.pc.createAnswer();
    ans.sdp = tuneSdp(ans.sdp);
    await this.pc.setLocalDescription(ans);
    const upd = { answer: { type: ans.type, sdp: ans.sdp, rev: offer.rev } };
    if (first) Object.assign(upd, { status: 'active', answeredAt: serverTimestamp() });
    await updateDoc(this.callRef, upd);
  }

  async onCalleeDoc(d) {
    if (!d || this.ended) return;
    this.status = d.status;
    if (d.offer && d.offer.rev > this.answeredRev) {
      try { await this.answerOffer(d.offer, false); } catch (e) { console.warn('re-answer', e); }
    }
    if (['ended', 'cancelled', 'missed'].includes(d.status)) this.finish('Call ended');
  }

  // ---------- controls ----------
  setMuted(m) { this.local?.getAudioTracks().forEach((t) => { t.enabled = !m; }); }
  setCamera(on) { this.local?.getVideoTracks().forEach((t) => { t.enabled = on; }); }

  async flipCamera() {
    if (this.type !== 'video') return;
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    const c = mediaConstraints('video', this.saver, this.facing).video;
    const s = await navigator.mediaDevices.getUserMedia({ video: c, audio: false });
    const track = s.getVideoTracks()[0];
    const sender = this.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    const old = this.local.getVideoTracks()[0];
    if (sender) await sender.replaceTrack(track);
    if (old) { this.local.removeTrack(old); old.stop(); }
    this.local.addTrack(track);
    tuneSenders(this.pc, this.saver);
    return this.facing;
  }

  startStats() {
    let lastBytes = 0, lastTs = 0;
    this.statsTimer = setInterval(async () => {
      if (!this.pc) return;
      try {
        const stats = await this.pc.getStats();
        let rtt = null, kbps = null, res = '', loss = null;
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) rtt = r.currentRoundTripTime;
          if (r.type === 'inbound-rtp' && !r.isRemote) {
            if (r.kind === 'video' && r.frameHeight) res = `${r.frameHeight}p`;
            if (r.kind === 'audio' && r.packetsReceived) loss = (r.packetsLost || 0) / (r.packetsReceived + (r.packetsLost || 0));
            if (r.kind === (this.type === 'video' ? 'video' : 'audio')) {
              if (lastTs) kbps = Math.round(((r.bytesReceived - lastBytes) * 8) / (r.timestamp - lastTs));
              lastBytes = r.bytesReceived; lastTs = r.timestamp;
            }
          }
        });
        const bad = (rtt != null && rtt > 0.4) || (loss != null && loss > 0.05);
        const label = this.type === 'video' ? `HD video ${res}` : 'HD voice';
        this.hooks.onQuality?.(`${bad ? 'Weak network · ' : ''}${label}${kbps ? ` · ${kbps} kbps` : ''}`);
      } catch (e) {}
    }, 2000);
  }

  setStatus(status) {
    return updateDoc(this.callRef, { status, endedAt: serverTimestamp(), endedBy: this.me.uid }).catch(() => {});
  }

  async hangup(reason = 'ended') {
    if (this.ended) return;
    const st = !this.connectedOnce && this.role === 'caller' && this.status !== 'active' ? 'cancelled' : 'ended';
    await this.setStatus(reason === 'failed' ? 'ended' : st);
    this.finish(reason === 'failed' ? 'Connection lost' : 'Call ended');
  }

  finish(why) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.ringTimer); clearTimeout(this.discTimer); clearTimeout(this.failTimer);
    clearInterval(this.statsTimer);
    this.unsubs.forEach((u) => u());
    try { this.pc?.close(); } catch (e) {}
    this.local?.getTracks().forEach((t) => t.stop());
    this.hooks.onEnded?.(why);
  }
}
