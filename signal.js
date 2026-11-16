/* BAGRENATION — sinalização WebRTC pelo Worker (S-1382). Substitui o PeerJS (e o servidor público 0.peerjs.com).
 *
 * Mantém só a parte da API do PeerJS que o app.js usa: new Peer(id) com open/connection/call/disconnected/close/error,
 * peer.connect(id) (canal de dados JSON), peer.call(id, stream, { sdpTransform }) (tela) e reconnect/destroy.
 * O Worker (server/worker.js, rota /rtc) só repassa oferta, resposta e candidatos ICE entre os ids; os dados, a voz
 * e a tela seguem direto de navegador para navegador (ou pelo TURN do Cloudflare quando a rede não deixa).
 */
(() => {
  'use strict';

  const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  const relay = new URLSearchParams(location.search).get('ice') === 'relay'; // só para teste: força passar pelo TURN
  const lib = { url: '', ice: STUN };
  const pcConfig = () => ({ iceServers: lib.ice, ...(relay ? { iceTransportPolicy: 'relay' } : {}) });
  const rid = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');

  class Emitter {
    constructor() { this.h = {}; }
    on(ev, fn) { (this.h[ev] ||= []).push(fn); return this; }
    emit(ev, ...a) { for (const fn of [...(this.h[ev] || [])]) { try { fn(...a); } catch (e) { console.error('BAGRENATION', ev, e); } } }
  }

  // Um RTCPeerConnection com a fila de candidatos que chegam antes da resposta, e o envio dos meus.
  class Link extends Emitter {
    constructor(peer, remote, cid, kind) {
      super();
      Object.assign(this, { peer: remote, cid, kind, owner: peer, closed: false, queue: [], remoteSet: false });
      this.pc = new RTCPeerConnection(pcConfig());
      this.pc.onicecandidate = (ev) => { if (ev.candidate) this.sig({ i: ev.candidate.toJSON() }); };
    }
    get peerConnection() { return this.pc; }
    sig(d) { this.owner.signal(this.peer, { k: this.kind, c: this.cid, ...d }); }
    async setRemote(desc) {
      await this.pc.setRemoteDescription(desc);
      this.remoteSet = true;
      for (const c of this.queue.splice(0)) this.pc.addIceCandidate(c).catch(() => {});
    }
    cand(c) { if (this.remoteSet) this.pc.addIceCandidate(c).catch(() => {}); else if (this.queue.length < 100) this.queue.push(c); }
    shut(notify) {
      if (this.closed) return;
      this.closed = true;
      if (notify) this.sig({ x: 1 });
      this.owner.links.delete(`${this.peer}|${this.kind}|${this.cid}`);
      try { this.pc.close(); } catch { /* já fechou */ }
      this.afterShut();
    }
    close() { this.shut(true); }
  }

  class DataConnection extends Link {
    constructor(peer, remote, cid) {
      super(peer, remote, cid, 'd');
      this.open = false;
      this.pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(this.pc.connectionState)) this.shut(false); };
      this.timer = setTimeout(() => { if (!this.open) this.shut(true); }, 20000); // nunca abriu: desisto sem avisar o app (igual ao PeerJS)
    }
    attach(dc) {
      this.dc = dc;
      dc.onopen = () => { this.open = true; clearTimeout(this.timer); this.emit('open'); };
      dc.onmessage = (ev) => { try { this.emit('data', JSON.parse(ev.data)); } catch { /* lixo: ignora */ } };
      dc.onclose = () => this.shut(false);
      dc.onerror = () => {};
    }
    send(obj) { if (this.open) this.dc.send(JSON.stringify(obj)); }
    afterShut() {
      clearTimeout(this.timer);
      const was = this.open;
      this.open = false;
      if (was) this.emit('close'); // como no PeerJS: quem nunca abriu não emite 'close'
    }
  }

  class MediaConnection extends Link {
    constructor(peer, remote, cid) {
      super(peer, remote, cid, 'm');
      this.announced = false;
      this.pc.ontrack = (ev) => {
        const s = ev.streams[0] || new MediaStream([ev.track]);
        if (this.announced) return; // as outras faixas entram no mesmo stream
        this.announced = true;
        this.emit('stream', s);
      };
    }
    async offer(stream, tf) {
      for (const t of stream.getTracks()) this.pc.addTrack(t, stream);
      const o = await this.pc.createOffer();
      const desc = { type: 'offer', sdp: tf ? tf(o.sdp) : o.sdp };
      await this.pc.setLocalDescription(desc);
      this.sig({ o: desc.sdp });
    }
    answer(stream, opts) { // só recebe: o app chama answer(undefined, { sdpTransform })
      const tf = opts && opts.sdpTransform;
      (async () => {
        await this.setRemote({ type: 'offer', sdp: this.remoteOffer });
        if (stream) for (const t of stream.getTracks()) this.pc.addTrack(t, stream);
        const a = await this.pc.createAnswer();
        const desc = { type: 'answer', sdp: tf ? tf(a.sdp) : a.sdp };
        await this.pc.setLocalDescription(desc);
        this.sig({ a: desc.sdp });
      })().catch((err) => { this.emit('error', err); this.shut(true); });
    }
    afterShut() { this.emit('close'); }
  }

  class Peer extends Emitter {
    constructor(id) {
      super();
      this.id = id;
      this.tok = rid() + rid();
      this.open = false;
      this.disconnected = true;
      this.destroyed = false;
      this.links = new Map(); // "<peer>|<tipo>|<cid>" -> Link
      this.ws = null;
      this.reconnect();
    }

    reconnect() {
      if (this.destroyed || this.ws) return;
      const ws = this.ws = new WebSocket(lib.url);
      let pongAt = Date.now();
      const ping = setInterval(() => {
        if (ws.readyState !== 1) return;
        if (Date.now() - pongAt > 70000) { ws.close(); return; } // sem resposta há 70 s: a conexão morreu sem avisar
        ws.send('ping');
      }, 25000);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'reg', id: this.id, tok: this.tok }));
      ws.onmessage = (ev) => {
        pongAt = Date.now();
        if (ev.data === 'pong') return;
        let d;
        try { d = JSON.parse(ev.data); } catch { return; }
        if (d.t === 'ok') {
          if (Array.isArray(d.ice) && d.ice.length) lib.ice = d.ice;
          this.open = true; this.disconnected = false;
          this.emit('open', this.id);
        } else if (d.t === 'taken') {
          this.emit('error', Object.assign(new Error(`ID ${this.id} is taken`), { type: 'unavailable-id' }));
          this.destroy();
        } else if (d.t === 'gone') {
          this.emit('error', Object.assign(new Error(`Could not connect to peer ${d.to}`), { type: 'peer-unavailable' }));
        } else if (d.t === 'sig') this.incoming(d.from, d.d).catch((err) => console.warn('BAGRENATION: sinalização', err));
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (this.ws !== ws) return;
        this.ws = null;
        this.open = false;
        if (this.destroyed) return;
        this.disconnected = true;
        this.emit('disconnected', this.id);
      };
      ws.onerror = () => {};
    }

    signal(to, d) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'sig', to, d })); }

    async incoming(from, d) {
      if (this.destroyed || !d || (d.k !== 'd' && d.k !== 'm') || typeof d.c !== 'string' || d.c.length > 24) return;
      const key = `${from}|${d.k}|${d.c}`;
      let l = this.links.get(key);
      if (d.x) { if (l) l.shut(false); return; }
      if (typeof d.o === 'string') { // oferta: alguém quer falar comigo
        if (l) return;
        if (d.k === 'd') {
          const c = l = new DataConnection(this, from, d.c);
          this.links.set(key, c);
          c.pc.ondatachannel = (ev) => c.attach(ev.channel);
          await c.setRemote({ type: 'offer', sdp: d.o });
          const a = await c.pc.createAnswer();
          await c.pc.setLocalDescription(a);
          c.sig({ a: a.sdp });
          this.emit('connection', c);
        } else {
          const c = l = new MediaConnection(this, from, d.c);
          c.remoteOffer = d.o;
          this.links.set(key, c);
          this.emit('call', c);
        }
      } else if (!l) return;
      else if (typeof d.a === 'string') await l.setRemote({ type: 'answer', sdp: d.a });
      else if (d.i && typeof d.i === 'object') l.cand(d.i);
    }

    connect(id) {
      const c = new DataConnection(this, id, rid());
      this.links.set(`${id}|d|${c.cid}`, c);
      c.attach(c.pc.createDataChannel('d'));
      (async () => {
        const o = await c.pc.createOffer();
        await c.pc.setLocalDescription(o);
        c.sig({ o: o.sdp });
      })().catch(() => c.shut(false));
      return c;
    }

    call(id, stream, opts) {
      const c = new MediaConnection(this, id, rid());
      this.links.set(`${id}|m|${c.cid}`, c);
      c.offer(stream, opts && opts.sdpTransform).catch((err) => { c.emit('error', err); c.shut(false); });
      return c;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.open = false;
      for (const l of [...this.links.values()]) l.shut(true);
      const ws = this.ws; this.ws = null;
      if (ws) ws.close();
      this.emit('close');
    }
  }

  Peer.setup = (url) => { lib.url = url; };
  Peer.pcConfig = pcConfig;
  window.Peer = Peer;
})();
