// FitX Call — SIP phone (SIP over secure WebSocket, via JsSIP).
// Works with any PBX / VoIP provider that supports WebRTC "WSS" transport
// (Asterisk / FreePBX, FreeSWITCH, 3CX, Yeastar, Kamailio, Zadarma, Telnyx, ...).
import JsSIP from 'jssip';
import { iceConfig, loadTurn } from './call.js';

JsSIP.debug.disable('JsSIP:*');

const KEY = 'fx-sip';
export const sipDefaults = { enabled: false, name: '', user: '', password: '', domain: '', wss: '', authUser: '', prefix: '' };

export function loadSip() {
  try { return { ...sipDefaults, ...(JSON.parse(localStorage.getItem(KEY) || '{}')) }; } catch (e) { return { ...sipDefaults }; }
}
export function saveSip(cfg) {
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {}
}

/** One SIP call, shaped like CallSession so the normal call screen can drive it. */
class SipCall {
  constructor(phone, session, role, number) {
    this.kind = 'sip';
    this.phone = phone;
    this.session = session;
    this.role = role;
    this.type = 'audio';
    this.number = number;
    this.peer = { uid: 'sip:' + number, name: number };
    this.id = 'sip-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.createdAtMs = Date.now();
    this.ended = false;
    this.connectedOnce = false;
    this.status = 'ringing';
    this.hooks = {};
    this.remote = new MediaStream();
    this.wire();
  }

  wire() {
    const s = this.session;
    const attachPc = (pc) => {
      pc.addEventListener('track', (e) => {
        (e.streams[0] ? e.streams[0].getTracks() : [e.track]).forEach((t) => this.remote.addTrack(t));
        this.hooks.onRemoteStream?.(this.remote);
      });
    };
    if (s.connection) attachPc(s.connection);
    s.on('peerconnection', (e) => attachPc(e.peerconnection));
    // Don't wait for slow ICE gathering (TURN): send the offer/answer after ~1.5 s.
    let readyT = null;
    s.on('icecandidate', (e) => { if (!readyT) readyT = setTimeout(() => { try { e.ready(); } catch (x) {} }, 1500); });
    s.on('progress', () => { if (this.role === 'caller') this.hooks.onState?.('Ringing…'); });
    s.on('accepted', () => this.onUp());
    s.on('confirmed', () => this.onUp());
    s.on('ended', () => this.finish('Call ended', this.connectedOnce ? 'answered' : 'ended'));
    s.on('failed', (e) => {
      const c = (e && e.cause) || '';
      const map = {
        Busy: ['Busy', 'busy'], Rejected: ['Call declined', 'declined'], 'Not Found': ['Number not found', 'ended'],
        Unavailable: ['Not available', 'ended'], 'No Answer': ['No answer', 'missed'], Canceled: ['Call cancelled', 'cancelled'],
        'Authentication Error': ['SIP login failed — check password', 'ended'], 'Request Timeout': ['No answer', 'missed'],
        'Connection Error': ['SIP server unreachable', 'ended'], 'Address Incomplete': ['Number incomplete', 'ended'],
        'Incompatible SDP': ['PBX codec/WebRTC problem', 'ended'], 'User Denied Media Access': ['Allow microphone permission', 'ended'],
      };
      const [why, st] = map[c] || [c ? `Call failed: ${c}` : 'Call failed', this.role === 'callee' ? 'missed' : 'ended'];
      this.finish(why, st);
    });
  }

  onUp() {
    if (this.connectedOnce || this.ended) return;
    this.connectedOnce = true;
    this.status = 'answered';
    this.hooks.onConnected?.();
    this.hooks.onQuality?.('SIP · HD voice (Opus)');
  }

  async answer() {
    await loadTurn();
    this.session.answer({
      mediaConstraints: { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false },
      pcConfig: iceConfig(),
    });
  }
  decline() { try { this.session.terminate({ status_code: 486, reason_phrase: 'Busy Here' }); } catch (e) {} this.finish('', 'declined'); }
  hangup() { try { this.session.terminate(); } catch (e) {} this.finish('Call ended', this.connectedOnce ? 'answered' : 'cancelled'); }
  setMuted(m) { try { m ? this.session.mute({ audio: true }) : this.session.unmute({ audio: true }); } catch (e) {} }
  setCamera() {}
  async flipCamera() {}
  sendDTMF(d) { try { this.session.sendDTMF(d, { duration: 120, interToneGap: 70 }); } catch (e) {} }
  setStatus() { return Promise.resolve(); }
  finish(why, status) {
    if (this.ended) return;
    this.ended = true;
    this.endedAt = Date.now();
    this.finalStatus = status || (this.connectedOnce ? 'answered' : 'ended');
    if (this.phone.active === this) this.phone.active = null;
    this.hooks.onEnded?.(why);
  }
}

/** The SIP phone (registration + calls). ctx: { onStatus(state, text), onIncoming(sipCall) } */
export class SipPhone {
  constructor(ctx) { this.ctx = ctx; this.ua = null; this.active = null; this.state = 'off'; }

  status(state, text) { this.state = state; this.ctx.onStatus?.(state, text); }

  ready() { return this.ua && this.state === 'registered'; }

  start(cfg = loadSip()) {
    this.stop();
    if (!cfg.enabled) return this.status('off', 'SIP is off');
    if (!cfg.user || !cfg.domain || !cfg.wss) return this.status('missing', 'SIP not set up — open Settings');
    if (!/^wss?:\/\//i.test(cfg.wss)) return this.status('error', 'WebSocket URL must start with wss://');
    this.cfg = cfg;
    this.status('connecting', 'Connecting to SIP…');
    try {
      const socket = new JsSIP.WebSocketInterface(cfg.wss.trim());
      this.ua = new JsSIP.UA({
        sockets: [socket],
        uri: `sip:${cfg.user.trim()}@${cfg.domain.trim()}`,
        password: cfg.password,
        authorization_user: (cfg.authUser || cfg.user).trim(),
        display_name: cfg.name || undefined,
        register: true,
        register_expires: 300,
        session_timers: false,
        user_agent: 'FitX Call',
        connection_recovery_min_interval: 2,
        connection_recovery_max_interval: 30,
      });
    } catch (e) { return this.status('error', 'SIP settings are not valid: ' + (e.message || e)); }
    const ua = this.ua;
    ua.on('connected', () => this.status('connecting', 'Signing in to SIP…'));
    ua.on('disconnected', () => { if (this.ua === ua) this.status('error', 'SIP server unreachable — retrying…'); });
    ua.on('registered', () => this.status('registered', `SIP ready · ${cfg.user}@${cfg.domain}`));
    ua.on('unregistered', () => { if (this.ua === ua) this.status('error', 'SIP signed out'); });
    ua.on('registrationFailed', (e) => this.status('error', `SIP sign-in failed: ${(e && e.cause) || 'error'}`));
    ua.on('newRTCSession', (e) => {
      if (e.originator !== 'remote') return;
      const s = e.session;
      if (this.active || this.ctx.isBusy?.()) { try { s.terminate({ status_code: 486, reason_phrase: 'Busy Here' }); } catch (x) {} return; }
      const from = (s.remote_identity && (s.remote_identity.display_name || (s.remote_identity.uri && s.remote_identity.uri.user))) || 'Unknown';
      const num = (s.remote_identity && s.remote_identity.uri && s.remote_identity.uri.user) || from;
      const call = new SipCall(this, s, 'callee', num);
      call.peer.name = from && from !== num ? `${from} (${num})` : num;
      this.active = call;
      this.ctx.onIncoming?.(call);
    });
    ua.start();
  }

  stop() {
    if (this.ua) { const ua = this.ua; this.ua = null; try { ua.stop(); } catch (e) {} }
    this.status('off', 'SIP is off');
  }

  /** Place an outgoing call. Returns a SipCall (hooks must be set right after). */
  async call(number) {
    if (!this.ua) throw new Error('SIP is not set up');
    if (this.state !== 'registered') throw new Error('SIP is not connected yet');
    const clean = String(number).replace(/[^\d+*#a-zA-Z@._-]/g, '');
    const dial = (this.cfg.prefix || '') + clean;
    const target = dial.includes('@') ? `sip:${dial}` : `sip:${dial}@${this.cfg.domain}`;
    await loadTurn();
    const session = this.ua.call(target, {
      mediaConstraints: { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false },
      pcConfig: iceConfig(),
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
    });
    const c = new SipCall(this, session, 'caller', clean);
    this.active = c;
    return c;
  }
}
