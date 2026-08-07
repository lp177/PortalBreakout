// PortalBreakout — service worker registration, update detection, offline state.
// See CONTRACT.md "Offline and updates". The worker itself is generated at build
// time into docs/sw.js by scripts/build-sw.mjs.

const UPDATE_POLL_MS = 15 * 60 * 1000;   // background re-check while the tab lives

let reg = null;
let waitingWorker = null;
let reloading = false;
// Only a player-accepted swap may reload. clients.claim() also fires
// controllerchange on the FIRST install (when the worker takes over an
// already-open page), and reloading there would bounce every first visit.
let swapRequested = false;
let onUpdate = () => {};
let onOffline = () => {};

// A worker is "waiting" only when one is already controlling the page — on a
// first-ever visit the new worker installs with nothing to replace, which is not
// an update and must not prompt.
const noteWaiting = (worker) => {
  if (!worker || !navigator.serviceWorker.controller) return;
  waitingWorker = worker;
  onUpdate();
};

const watch = (registration) => {
  if (registration.waiting) noteWaiting(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const fresh = registration.installing;
    if (!fresh) return;
    fresh.addEventListener('statechange', () => {
      if (fresh.state === 'installed') noteWaiting(fresh);
    });
  });
};

export const pwa = {
  // callbacks: onUpdateReady() when a new build is downloaded and waiting,
  // onOfflineChange(offline) whenever connectivity flips.
  init({ onUpdateReady, onOfflineChange } = {}) {
    onUpdate = onUpdateReady ?? onUpdate;
    onOffline = onOfflineChange ?? onOffline;

    window.addEventListener('online', () => {
      onOffline(false);
      this.checkForUpdate();          // back online: is there a newer build?
    });
    window.addEventListener('offline', () => onOffline(true));

    if (!('serviceWorker' in navigator)) return;
    // file:// and other opaque origins cannot host a worker; fail quietly
    if (!location.protocol.startsWith('http')) return;

    window.addEventListener('load', async () => {
      try {
        // updateViaCache 'none': never let the HTTP cache serve a stale worker,
        // which is the bug this whole feature exists to fix
        reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
        watch(reg);
      } catch {
        return;                        // no worker: the game still runs online
      }

      // one reload, on the swap, so the page never loops
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!swapRequested || reloading) return;   // first-install claim: not an update
        reloading = true;
        location.reload();
      });

      // look for a new build when the player comes back to the tab, and slowly
      // in the background — the point is to notice a deploy without a hard refresh
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) this.checkForUpdate();
      });
      setInterval(() => this.checkForUpdate(), UPDATE_POLL_MS);
    });
  },

  checkForUpdate() {
    if (!reg || !navigator.onLine) return;
    reg.update().catch(() => { /* offline or transient — try again later */ });
  },

  // player accepted: let the waiting worker take over, controllerchange reloads
  applyUpdate() {
    swapRequested = true;
    if (!waitingWorker) { location.reload(); return; }
    waitingWorker.postMessage('SKIP_WAITING');
    // belt and braces: if the swap never lands (worker died), reload anyway
    setTimeout(() => { if (!reloading) { reloading = true; location.reload(); } }, 3000);
  },

  get updateReady() { return Boolean(waitingWorker); },
  get offline() { return !navigator.onLine; },
};
