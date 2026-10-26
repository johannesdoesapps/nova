/**
 * OrbisAudioAnalyzer: a smoothed 0–1 loudness from a microphone stream the assistant already has open (it never
 * opens one itself). Spoken replies come from the device's speech engine, which doesn't expose its audio, so
 * speaking is shown with pulses at each spoken word instead (see pulseOrbis).
 */
export class OrbisAudioAnalyzer {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private data: Uint8Array<ArrayBuffer> | null = null;
  private smooth = 0;

  connect(stream: MediaStream | null) {
    this.disconnect();
    if (!stream || typeof AudioContext === "undefined") return;
    try {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.source = this.ctx.createMediaStreamSource(stream);
      this.source.connect(this.analyser);
      this.data = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    } catch {
      this.disconnect();
    }
  }

  /** Root-mean-square loudness, eased so the core breathes rather than jitters. */
  level = (): number => {
    if (!this.analyser || !this.data) {
      this.smooth *= 0.9;
      return this.smooth;
    }
    this.analyser.getByteTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) {
      const v = (this.data[i]! - 128) / 128;
      sum += v * v;
    }
    const rms = Math.min(1, Math.sqrt(sum / this.data.length) * 4);
    this.smooth += (rms - this.smooth) * (rms > this.smooth ? 0.35 : 0.08);
    return this.smooth;
  };

  disconnect() {
    this.source?.disconnect();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.data = null;
  }
}
