/**
 * FigoBooks Printer Driver — Setup Wizard Logic
 * Port is read from the <meta name="figo-port"> tag injected by the server,
 * so this file never needs to hardcode 3838.
 */

const _port = document.querySelector('meta[name="figo-port"]')?.content || '3838';
const API   = `http://127.0.0.1:${_port}`;

// ── State ─────────────────────────────────────────────────────────────────────
let currentScreen  = 0;
let discoveredPrinters = [];
let selectedPrinter    = null;

// ── Navigation ────────────────────────────────────────────────────────────────
function goTo(index) {
  // Leave current screen
  document.getElementById(`screen-${currentScreen}`)?.classList.remove('active');
  document.querySelectorAll('.step')[currentScreen]?.classList.remove('active');

  currentScreen = index;

  // Enter new screen
  document.getElementById(`screen-${index}`)?.classList.add('active');
  document.querySelectorAll('.step')[index]?.classList.add('active');

  // Screen-specific init
  if (index === 1) startScan();
  if (index === 3) renderDoneScreen();
}

// ── Screen 1: Scan ────────────────────────────────────────────────────────────
async function startScan() {
  const scanIcon       = document.getElementById('scanIcon');
  const scanTitle      = document.getElementById('scanTitle');
  const scanSubtitle   = document.getElementById('scanSubtitle');
  const scanStatus     = document.getElementById('scanStatus');
  const scanStatusText = document.getElementById('scanStatusText');
  const scanActions    = document.getElementById('scanActions');
  const printerList    = document.getElementById('printerList');
  const btnSelect      = document.getElementById('btnSelectPrinter');
  const btWarning      = document.getElementById('btWarning');
  const btWarningTitle = document.getElementById('btWarningTitle');
  const btWarningMsg   = document.getElementById('btWarningMsg');

  // Reset UI
  scanIcon.classList.remove('done');
  scanTitle.textContent    = 'Scanning for Printers…';
  scanSubtitle.textContent = 'Make sure your printer is turned on and nearby.';
  scanActions.style.display  = 'none';
  printerList.style.display  = 'none';
  printerList.innerHTML      = '';
  btWarning.style.display    = 'none';
  scanStatus.style.display   = 'flex';
  scanStatusText.textContent = 'Checking Bluetooth, then scanning…';
  document.querySelector('#scanStatus .dot').className = 'dot pulse';

  try {
    const res  = await fetch(`${API}/printers`);
    const data = await res.json();

    scanIcon.classList.add('done');

    // ── Bluetooth off / permission denied ────────────────────────────────────
    if (!res.ok && data.errorCode) {
      const msgs = {
        BT_OFF:          ['Bluetooth is Off',          'Turn on Bluetooth in System Settings → Bluetooth, then tap Scan Again.'],
        BT_UNAUTHORIZED: ['Bluetooth Permission Denied', 'Go to System Settings → Privacy & Security → Bluetooth and allow this app.'],
        BT_UNSUPPORTED:  ['Bluetooth Not Supported',    'This device does not support Bluetooth. Connect your printer via USB instead.'],
      };
      const [title, msg] = msgs[data.errorCode] || ['Bluetooth Error', data.error];
      btWarningTitle.textContent = title;
      btWarningMsg.textContent   = msg;
      btWarning.style.display    = 'flex';
      scanTitle.textContent      = title;
      scanSubtitle.textContent   = 'Fix the issue above and try again.';
      scanStatusText.textContent = data.error;
      document.querySelector('#scanStatus .dot').className = 'dot error';
      scanActions.style.display  = 'flex';
      btnSelect.disabled         = true;
      return;
    }

    discoveredPrinters = data.printers || [];

    // ── Bluetooth state hint ─────────────────────────────────────────────────
    const btAvailable = data.bluetooth?.available;
    if (!btAvailable && discoveredPrinters.filter(p => p.type === 'usb').length === 0) {
      btWarningTitle.textContent = 'Bluetooth is Off';
      btWarningMsg.textContent   = 'BLE printers were not scanned. Turn on Bluetooth and scan again, or connect via USB.';
      btWarning.style.display    = 'flex';
    }

    // ── No devices found ─────────────────────────────────────────────────────
    if (discoveredPrinters.length === 0) {
      scanTitle.textContent    = 'No Printers Found';
      scanSubtitle.textContent = 'Make sure your printer is powered on and within range (within ~10 m).';
      scanStatusText.textContent = 'No devices detected.';
      document.querySelector('#scanStatus .dot').className = 'dot error';
    } else {
      // ── Devices found ───────────────────────────────────────────────────────
      scanTitle.textContent    = `Found ${discoveredPrinters.length} Printer${discoveredPrinters.length > 1 ? 's' : ''}`;
      scanSubtitle.textContent = 'Select one to continue.';
      scanStatusText.textContent = 'Scan complete — all devices are within range.';
      document.querySelector('#scanStatus .dot').className = 'dot success';

      printerList.style.display = 'flex';
      discoveredPrinters.forEach((p, i) => {
        printerList.appendChild(buildPrinterCard(p, i, 'scan'));
      });
    }

    scanActions.style.display = 'flex';
    btnSelect.disabled = !selectedPrinter;

  } catch (err) {
    scanIcon.classList.add('done');
    scanTitle.textContent    = 'Could Not Scan';
    scanSubtitle.textContent = 'The driver API is not responding. Try restarting the driver.';
    scanStatusText.textContent = `Error: ${err.message}`;
    document.querySelector('#scanStatus .dot').className = 'dot error';
    scanActions.style.display = 'flex';
  }
}

function buildPrinterCard(printer, index, context) {
  const card = document.createElement('div');
  card.className = 'printer-card' + (selectedPrinter?.name === printer.name ? ' selected' : '');
  card.setAttribute('data-index', index);

  const isBluetooth = printer.type === 'ble' || printer.type === 'y50';
  const badgeClass = isBluetooth ? 'badge-ble' : 'badge-usb';
  const badgeLabel = isBluetooth ? 'Bluetooth' : 'USB';

  // Signal strength — only for BLE/Y50
  const signalHtml = isBluetooth && printer.rssi
    ? `<span class="signal-badge signal-${(printer.signalLabel || 'Fair').toLowerCase()}">${printer.signalLabel || ''} (${printer.rssi} dBm)</span>`
    : '';

  const isY50 = printer.type === 'y50';
  const iconHtml = isY50
    ? `<img src="/assets/y50-printer.png" alt="Y50" class="y50-img" />`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="#2234FD" stroke-width="2">
        <rect x="3" y="7" width="18" height="10" rx="2"/>
        <path d="M8 7V4h8v3"/>
        <path d="M8 17v3h8v-3"/>
        <circle cx="17" cy="12" r="1" fill="#2234FD"/>
      </svg>`;

  card.innerHTML = `
    <div class="printer-icon">
      ${iconHtml}
    </div>
    <div class="printer-info">
      <div class="printer-name">${escapeHtml(printer.name)}</div>
      <div class="printer-meta">${escapeHtml(printer.address || '')}${signalHtml}</div>
    </div>
    <span class="printer-badge ${badgeClass}">${badgeLabel}</span>
  `;

  card.addEventListener('click', () => selectPrinter(printer, context));
  return card;
}

function selectPrinter(printer, context) {
  selectedPrinter = printer;

  // Update both lists
  document.querySelectorAll('.printer-card').forEach(card => {
    card.classList.remove('selected');
  });
  document.querySelectorAll('.printer-card').forEach(card => {
    if (card.querySelector('.printer-name')?.textContent === printer.name) {
      card.classList.add('selected');
    }
  });

  document.getElementById('btnSelectPrinter').disabled = false;

  const hint = document.getElementById('selectedHint');
  const nameEl = document.getElementById('selectedName');
  if (hint && nameEl) {
    nameEl.textContent = printer.name;
    hint.style.display = 'block';
  }
}

// ── Screen 2: Confirm / Select — REMOVED (merged into screen 1) ──────────────

// ── Screen 1 → Screen 2: Bind printer ────────────────────────────────────────
async function bindPrinter() {
  if (!selectedPrinter) return;

  const btn     = document.getElementById('btnSelectPrinter');
  const btnScan = document.getElementById('btnScanAgain');
  btn.disabled    = true;
  btn.textContent = 'Connecting…';
  if (btnScan) btnScan.disabled = true;

  try {
    const res  = await fetch(`${API}/bind`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        name:      selectedPrinter.name,
        type:      selectedPrinter.type,
        address:   selectedPrinter.address,
        vendorId:  selectedPrinter.vendorId  ?? null,
        productId: selectedPrinter.productId ?? null,
      }),
    });

    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Connection failed');

    goTo(2);
  } catch (err) {
    btn.disabled    = false;
    btn.textContent = 'Connect →';
    if (btnScan) btnScan.disabled = false;
    showToast(`Connection failed: ${err.message}`, 'error');
  }
}

// ── Screen 3: Test print ──────────────────────────────────────────────────────
async function sendTestPrint() {
  const btn    = document.getElementById('btnTestPrint');
  const result = document.getElementById('testResult');

  btn.disabled    = true;
  btn.textContent = 'Printing…';
  result.style.display = 'none';

  try {
    const res  = await fetch(`${API}/print`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'test', data: {} }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Print failed');

    // Poll job status
    const jobId = data.jobId;
    await pollJob(jobId);

    result.className     = 'test-result ok';
    result.innerHTML     = '✓ Test receipt printed successfully!';
    result.style.display = 'flex';

    btn.textContent = 'Print Again';
    btn.disabled    = false;

    // Auto-advance after 2s
    setTimeout(() => goTo(3), 2000);

  } catch (err) {
    result.className     = 'test-result fail';
    result.innerHTML     = `✗ ${escapeHtml(err.message)}`;
    result.style.display = 'flex';
    btn.textContent = 'Try Again';
    btn.disabled    = false;
  }
}

async function pollJob(jobId, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(500);
    const res  = await fetch(`${API}/jobs/${jobId}`);
    const data = await res.json();
    if (data.status === 'done')  return data;
    if (data.status === 'error') throw new Error(data.error || 'Print job failed');
  }
  throw new Error('Print job timed out');
}

// ── Screen 3: Done ────────────────────────────────────────────────────────────
function renderDoneScreen() {
  const name = selectedPrinter?.name || 'Your printer';
  document.getElementById('donePrinterName').textContent  = name;
  document.getElementById('donePrinterLabel').textContent = name;
}

// ── Disconnect & rescan ──────────────────────────────────────────────────────
async function disconnectAndRescan() {
  const btn = document.querySelector('#screen-3 .btn-ghost');
  if (btn) { btn.disabled = true; btn.textContent = 'Disconnecting…'; }
  try {
    await fetch(`${API}/bind`, { method: 'DELETE' });
  } catch (_) { /* ignore — proceed to rescan anyway */ }
  selectedPrinter = null;
  goTo(1);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message, type = 'info') {
  const t = document.createElement('div');
  t.style.cssText = `
    position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
    background:${type === 'error' ? '#ef4444' : '#0f1117'};
    color:#fff; padding:12px 22px; border-radius:10px;
    font-family:var(--font); font-size:0.9rem; font-weight:500;
    z-index:999; box-shadow:0 4px 20px rgba(0,0,0,0.2);
    animation: fadeUp 0.3s ease;
  `;
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // On load, check driver status:
  // - Printer connected              → jump straight to done screen
  // - Printer saved but offline      → jump to done screen in reconnecting state
  // - No printer saved               → stay on welcome screen (default)
  fetch(`${API}/status`)
    .then(r => r.json())
    .then(data => {
      if (data.printerConnected) {
        // Already connected — go straight to done
        selectedPrinter = { name: data.printerName };
        goTo(3);
      } else if (data.savedPrinterName) {
        // Saved printer exists but currently offline — show done screen
        // in a reconnecting state so user doesn't have to rescan
        selectedPrinter = { name: data.savedPrinterName };
        goTo(3);
        _showReconnectingBanner(data.savedPrinterName);
        // Poll status every 5 s and remove the banner once reconnected
        const poll = setInterval(() => {
          fetch(`${API}/status`)
            .then(r => r.json())
            .then(s => {
              if (s.printerConnected) {
                _hideReconnectingBanner();
                clearInterval(poll);
              }
            })
            .catch(() => {});
        }, 5000);
      }
      // else: no printer saved → stay on welcome screen
    })
    .catch(() => { /* driver still starting, show welcome */ });
});

function _showReconnectingBanner(printerName) {
  let banner = document.getElementById('reconnect-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'reconnect-banner';
    banner.style.cssText = [
      'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
      'background:#f59e0b', 'color:#fff', 'padding:12px 22px',
      'border-radius:10px', 'font-family:var(--font)', 'font-size:0.9rem',
      'font-weight:500', 'z-index:999', 'display:flex', 'align-items:center', 'gap:10px',
    ].join(';');
    document.body.appendChild(banner);
  }
  banner.innerHTML = `<span style="animation:spin 1s linear infinite;display:inline-block">&#8635;</span> Waiting for <strong>${escapeHtml(printerName)}</strong> to come back online…`;
  banner.style.display = 'flex';
  // Update done screen badge to show offline status
  const badge = document.querySelector('#screen-3 .status-badge');
  if (badge) { badge.className = 'status-badge error'; badge.textContent = 'Offline'; }
}

function _hideReconnectingBanner() {
  const banner = document.getElementById('reconnect-banner');
  if (banner) banner.style.display = 'none';
  // Restore done screen badge
  const badge = document.querySelector('#screen-3 .status-badge');
  if (badge) { badge.className = 'status-badge connected'; badge.textContent = 'Connected'; }
}
