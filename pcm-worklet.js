// S-1354: recebe o som do PC (PCM 16 bits, estéreo, 48 kHz, vindo do app) e toca como faixa de áudio.
registerProcessor('pcm-in', class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.off = 0; this.n = 0;
    this.port.onmessage = (e) => {
      const s = new Int16Array(e.data);
      this.q.push(s); this.n += s.length / 2;
      while (this.n > 9600 && this.q.length > 1) { // atraso máximo 200 ms: joga fora o mais velho
        const d = this.q.shift(); this.n -= (d.length - this.off) / 2; this.off = 0;
      }
    };
  }

  process(_, [out]) {
    const L = out[0], R = out[1] || out[0];
    for (let i = 0; i < L.length; i++) {
      const b = this.q[0];
      if (!b) { L[i] = R[i] = 0; continue; } // nada tocando no PC: silêncio
      L[i] = b[this.off] / 32768; R[i] = b[this.off + 1] / 32768;
      this.off += 2; this.n--;
      if (this.off >= b.length) { this.q.shift(); this.off = 0; }
    }
    return true;
  }
});
