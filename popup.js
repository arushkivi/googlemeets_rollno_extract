// popup.js - Extension Popup Logic & Content Script Synchronizer

let currentSettings = {
  myRollNumbers: [],
  strikeMin: "",
  strikeMax: "",
  enableSound: true,
  enablePopup: true,
  enableAutoAdmit: false,
  patternMode: 'sequential'
};

// Toast feedback helper
function showPopupToast(msg) {
  const toast = document.getElementById('popup-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

// Check active tab status and query content script
async function getActiveMeetTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs && tabs.length > 0 && tabs[0].url && tabs[0].url.includes('meet.google.com')) {
    return tabs[0];
  }
  return null;
}

async function refreshTabStatus() {
  const tab = await getActiveMeetTab();
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  if (tab) {
    dot.className = 'status-dot online';
    text.textContent = 'Google Meet Connected';
    
    // Request status update from content script
    try {
      chrome.tabs.sendMessage(tab.id, { action: 'GET_STATUS' }, (response) => {
        if (chrome.runtime.lastError || !response) {
          try {
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js']
            }, () => {
              if (chrome.runtime.lastError) return;
              chrome.tabs.sendMessage(tab.id, { action: 'GET_STATUS' }, (retryResp) => {
                if (retryResp && retryResp.status === 'ok') {
                  document.getElementById('stat-students').textContent = retryResp.totalStudents || 0;
                  document.getElementById('stat-rolls').textContent = retryResp.rollCallsCount || 0;
                  if (retryResp.patternMode) updatePatternUI(retryResp.patternMode);
                }
              });
            });
          } catch (e) {}
          return;
        }
        if (response && response.status === 'ok') {
          document.getElementById('stat-students').textContent = response.totalStudents || 0;
          document.getElementById('stat-rolls').textContent = response.rollCallsCount || 0;
          if (response.patternMode) {
            updatePatternUI(response.patternMode);
          }
        }
      });
    } catch (e) {
      console.warn("Popup message error:", e);
    }
  } else {
    dot.className = 'status-dot offline';
    text.textContent = 'Open Google Meet Tab';
  }
}

// Update Pattern Mode UI
function updatePatternUI(mode) {
  currentSettings.patternMode = mode;
  const btn = document.getElementById('pattern-toggle-btn');
  if (!btn) return;

  if (mode === 'sequential') {
    btn.className = 'btn btn-pattern-toggle sequential';
    btn.innerHTML = '🔢 Sequential Mode (52, 53, 54...)';
  } else {
    btn.className = 'btn btn-pattern-toggle scrambled';
    btn.innerHTML = '🔀 Scrambled Mode (Random / Unordered)';
  }
}

// Load settings from storage
function loadSavedSettings() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['meet_attendance_settings'], (result) => {
      if (result.meet_attendance_settings) {
        currentSettings = { ...currentSettings, ...result.meet_attendance_settings };
      }
      
      document.getElementById('popup-roll-nums').value = (currentSettings.myRollNumbers || []).join(', ');
      document.getElementById('popup-strike-min').value = currentSettings.strikeMin !== undefined && currentSettings.strikeMin !== null ? currentSettings.strikeMin : '';
      document.getElementById('popup-strike-max').value = currentSettings.strikeMax !== undefined && currentSettings.strikeMax !== null ? currentSettings.strikeMax : '';
      document.getElementById('popup-sound-toggle').checked = currentSettings.enableSound;
      document.getElementById('popup-modal-toggle').checked = currentSettings.enablePopup;
      const admitToggle = document.getElementById('popup-autoadmit-toggle');
      if (admitToggle) admitToggle.checked = !!currentSettings.enableAutoAdmit;
      updatePatternUI(currentSettings.patternMode);
    });
  }
}

// Save settings function
async function saveSettings() {
  const rawRolls = document.getElementById('popup-roll-nums').value;
  const rolls = rawRolls.split(',').map(s => s.trim()).filter(Boolean);
  const minRaw = document.getElementById('popup-strike-min').value.trim();
  const maxRaw = document.getElementById('popup-strike-max').value.trim();
  const minVal = minRaw !== "" ? (parseInt(minRaw) || "") : "";
  const maxVal = maxRaw !== "" ? (parseInt(maxRaw) || "") : "";
  const soundOn = document.getElementById('popup-sound-toggle').checked;
  const popupOn = document.getElementById('popup-modal-toggle').checked;
  const admitToggle = document.getElementById('popup-autoadmit-toggle');
  const admitOn = admitToggle ? admitToggle.checked : false;

  currentSettings = {
    ...currentSettings,
    myRollNumbers: rolls,
    strikeMin: minVal,
    strikeMax: maxVal,
    enableSound: soundOn,
    enablePopup: popupOn,
    enableAutoAdmit: admitOn
  };

  chrome.storage.local.set({ meet_attendance_settings: currentSettings }, () => {
    showPopupToast("⚙️ Settings Saved!");
  });

  const tab = await getActiveMeetTab();
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { action: 'UPDATE_SETTINGS', settings: currentSettings });
  }
}

// Helper to trigger file download in extension popup context
function triggerFileDownload(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Helper to process response from content script
async function handleTabResponse(action, response) {
  if (!response) return;

  if (response.status === 'empty') {
    showPopupToast("⚠️ No student roll calls recorded yet!");
    return;
  }

  if (action === 'AUTO_SCAN') {
    showPopupToast(`🔍 Scanned! ${response.totalStudents || 0} members found.`);
  } else if (action === 'COPY_ROLLS') {
    if (!response.rolls || response.rolls.trim() === '') {
      showPopupToast("⚠️ No roll calls recorded yet!");
    } else {
      try {
        await navigator.clipboard.writeText(response.rolls);
        showPopupToast(`📋 Copied: ${response.rolls.slice(0, 20)}${response.rolls.length > 20 ? '...' : ''}`);
      } catch (err) {
        showPopupToast(`📋 Copied roll calls!`);
      }
    }
  } else if (action === 'EXPORT_CSV' || action === 'EXPORT_XLS') {
    if (response.content && response.filename) {
      triggerFileDownload(response.content, response.filename, response.mimeType);
      const formatLabel = action === 'EXPORT_CSV' ? 'CSV' : 'Excel (.xls)';
      showPopupToast(`📥 Exported ${formatLabel}!`);
    } else {
      showPopupToast("⚠️ Failed to generate export file!");
    }
  }
  setTimeout(refreshTabStatus, 500);
}

// Send Action to Content Script with Auto-Injection Fallback
async function sendTabMessage(action) {
  const tab = await getActiveMeetTab();
  if (!tab) {
    showPopupToast("⚠️ Please open Google Meet tab first!");
    return;
  }

  chrome.tabs.sendMessage(tab.id, { action: action }, async (response) => {
    if (chrome.runtime.lastError || !response) {
      // Auto-inject content script if tab was not previously connected
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { action: action }, (retryResp) => {
            if (chrome.runtime.lastError || !retryResp) {
              showPopupToast("⚠️ Please refresh the Google Meet tab once!");
            } else {
              handleTabResponse(action, retryResp);
            }
          });
        }, 300);
      } catch (e) {
        showPopupToast("⚠️ Please refresh the Google Meet tab once!");
      }
      return;
    }
    
    handleTabResponse(action, response);
  });
}

// Event Listeners Initialization
document.addEventListener('DOMContentLoaded', () => {
  loadSavedSettings();
  refreshTabStatus();

  // Pattern single toggle button
  const patternBtn = document.getElementById('pattern-toggle-btn');
  if (patternBtn) {
    patternBtn.onclick = () => {
      const newMode = currentSettings.patternMode === 'sequential' ? 'scrambled' : 'sequential';
      updatePatternUI(newMode);
      saveSettings();
      showPopupToast(`Mode: ${newMode === 'sequential' ? '🔢 Sequential' : '🔀 Scrambled'}`);
    };
  }

  // Action buttons
  document.getElementById('btn-auto-scan').onclick = () => {
    showPopupToast("🔍 Scanning Members & Chat...");
    sendTabMessage('AUTO_SCAN');
  };
  document.getElementById('btn-copy-rolls').onclick = () => sendTabMessage('COPY_ROLLS');
  document.getElementById('btn-export-csv').onclick = () => sendTabMessage('EXPORT_CSV');
  document.getElementById('btn-export-xls').onclick = () => sendTabMessage('EXPORT_XLS');

  // Save settings button
  document.getElementById('btn-save-settings').onclick = () => saveSettings();

  // Auto-admit toggle immediate feedback listener
  const autoadmitToggle = document.getElementById('popup-autoadmit-toggle');
  if (autoadmitToggle) {
    autoadmitToggle.onchange = () => {
      saveSettings();
      showPopupToast(autoadmitToggle.checked ? "⚡ Auto-Admit Enabled!" : "⚡ Auto-Admit Disabled!");
    };
  }
});
