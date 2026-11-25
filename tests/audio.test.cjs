const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function harness({blocked = false, suspended = false} = {}) {
  const voices = [];
  const html = [];
  let rejectAudio = blocked;
  let resolveResume;
  const ctx = {
    get currentTime() { return Date.now() / 1000; }, state: suspended ? 'interrupted' : 'running', sampleRate: 44100, destination: {},
    resume() { return new Promise(resolve => { resolveResume = () => { ctx.state = 'running'; resolve(); }; }); },
    createBuffer(channels, count) { const data = new Float32Array(count); return { getChannelData: () => data }; },
    createBufferSource() {
      const voice = { connect() {}, disconnect() {}, start() { voice.started = true; }, stop() { voice.stopped = true; } };
      voices.push(voice); return voice;
    },
  };
  const c = {
    localStorage: {getItem: () => null, setItem() {}}, crypto: {randomUUID: () => 'station'},
    navigator: {}, window: { AudioContext: blocked ? undefined : function () { return ctx; } },
    document: { getElementById: () => null, body: {appendChild() {}}, createElement() {
      let position = 0, since = 0;
      const el = { get currentTime() { return position + (since ? (Date.now()-since)/1000 : 0); }, set currentTime(v) {position=v; if(since) since=Date.now();}, paused: true, setAttribute() {}, remove() {}, pause() { position=el.currentTime; since=0; el.paused = true; }, play() {
        el.played = true; el.paused=false; since=Date.now();
        return rejectAudio ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
      }};
      html.push(el); return el;
    } },
    URL: {createObjectURL: () => 'blob:alarm'}, Blob, setTimeout, clearTimeout,
  };
  vm.createContext(c);
  const cut = source.indexOf('  $("#btn-test-alarm").addEventListener');
  vm.runInContext(source.slice(0, cut) + 'globalThis.api = {unlockMediaChannels, mediaChannels, queueAlarm, flushPendingAlarms, stopAlertSound, pendingAlarms, soundPlayedFor, tryCompleteTimer, tryCompleteRestTimer, tick, state, quiet: () => { renderWorkspace = () => {}; refreshTimerListDisplay = () => true; refreshJustFinishedDisplay = () => true; }};})();', c);
  return {api:c.api, voices, html, ctx, resume: () => resolveResume(), allow: () => { rejectAudio = false; }};
}
const settle = () => new Promise(resolve => setTimeout(resolve, 250));
test('simultaneous dishes start separate non-silent audio sources immediately', async () => {
  const h = harness();
  h.api.queueAlarm('a'); h.api.queueAlarm('b'); h.api.queueAlarm('c');
  assert.equal(h.voices.length, 3);
  assert(h.voices.every(v => v.started));
  assert(h.voices[0].buffer.getChannelData(0).some(x => Math.abs(x) > 0.1));
  await settle();
  assert.equal(h.api.soundPlayedFor.size, 3);
  h.api.stopAlertSound('a');
  assert(h.voices[0].stopped);
  assert(!h.voices[1].stopped); assert(!h.voices[2].stopped);
  h.api.queueAlarm('d');
  assert.equal(h.voices.length, 4, 'new dish must not wait for a shared cooldown');
});
test('failed playback retries independently; success is not recorded early', async () => {
  const h = harness({blocked:true});
  h.api.queueAlarm('a'); h.api.queueAlarm('b'); await settle();
  assert.equal(h.html.length,2);
  assert.equal(h.api.soundPlayedFor.size,0);
  assert.equal(h.api.pendingAlarms.size,2);
  h.allow(); h.api.pendingAlarms.forEach(a => { a.retryAt=0; });
  h.api.flushPendingAlarms(); await settle();
  assert.equal(h.api.soundPlayedFor.size,2);
  assert.equal(h.api.pendingAlarms.size,0);
});
test('interrupted audio resumes; acknowledging one pending dish preserves the other', async () => {
  const h = harness({suspended:true});
  h.api.queueAlarm('a');
  h.api.stopAlertSound('a'); h.resume(); await settle();
  assert.equal(h.voices.length,0);
  h.api.queueAlarm('b'); await settle();
  assert.equal(h.voices.length,1); assert(h.voices[0].started);
});
test('expired dishes in different workspaces and pork resting each sound', async () => {
  const h = harness(); h.api.quiet();
  const a = {id:'a',state:'running',endAt:Date.now()-1};
  const b = {id:'b',state:'running',endAt:Date.now()-1};
  const rest = {id:'pork',state:'resting',endAt:Date.now()-1};
  h.api.state.tabs[0].timers.push(a);
  h.api.state.tabs.push({id:'hidden',timers:[b,rest],justFinished:[]});
  h.api.tick(); await settle();
  assert.equal(h.voices.length,3);
  assert.equal(a.state,'done'); assert.equal(b.state,'done'); assert.equal(rest.state,'rest_done');
  h.api.tick(); await settle();
  assert.equal(h.voices.length,3, 'ticks must not duplicate successful alerts');
});

test('Safari channels are unlocked during gesture and reused independently on expiry', async () => {
  const h = harness(); h.api.unlockMediaChannels(); await settle();
  assert.equal(h.api.mediaChannels.filter(c => c.unlocked).length,12);
  h.api.queueAlarm('media-a'); h.api.queueAlarm('media-b'); await settle();
  assert.equal(h.voices.length,0, 'primed media should be the primary path');
  assert.equal(h.api.mediaChannels.filter(c => c.busy).length,2);
  assert.equal(h.api.soundPlayedFor.size,2);
  h.api.stopAlertSound('media-a');
  assert.equal(h.api.mediaChannels.filter(c => c.busy).length,1);
});
test('reload recovers pending done alarms', async () => {
  const h = harness(); h.api.quiet();
  h.api.state.tabs[0].timers.push({id:'saved-done',state:'done'});
  h.api.tick(); await settle();
  assert(h.api.soundPlayedFor.has('saved-done'));
});
