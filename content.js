// content.js - Google Meet Roll Call Extractor & Auto-Attendance Radar (Silent Background Script)

// State to store extracted data (name -> Set of roll numbers)
const extractedData = new Map();

// Configuration Defaults
let userSettings = {
  myRollNumbers: [],
  strikeMin: "",
  strikeMax: "",
  cooldownTime: 30000,
  warningCooldown: 60000,
  enableSound: true,
  enablePopup: false,
  enableAutoAdmit: false,
  enablePatternMode: true,
  patternMode: 'sequential' // 'sequential' or 'scrambled'
};

// Load saved settings from chrome.storage
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get(['meet_attendance_settings'], (result) => {
    if (result.meet_attendance_settings) {
      userSettings = { ...userSettings, ...result.meet_attendance_settings };
    }
  });
}

// Cooldown tracking
let lastSentTime = 0;
let lastWarningTime = 0;

// Radar memory
let globalNumbers = new Set();
let strikeZoneNumbers = new Set();
let clearSetTimeout = null;

// --- Web Audio API Chime Generator ---
function playAlertSound(type = 'urgent') {
  if (!userSettings.enableSound) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    
    if (type === 'urgent') {
      const now = ctx.currentTime;
      [0, 0.2, 0.4].forEach(delay => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, now + delay);
        osc.frequency.exponentialRampToValueAtTime(1760, now + delay + 0.15);
        gain.gain.setValueAtTime(0.3, now + delay);
        gain.gain.exponentialRampToValueAtTime(0.01, now + delay + 0.15);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + delay);
        osc.stop(now + delay + 0.15);
      });
    } else {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.3);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.3);
    }
  } catch (e) {
    console.warn("[Attendance System] Audio play failed:", e);
  }
}

// Cleanup on tab unload/exit
window.addEventListener('beforeunload', () => {
  window.__meet_attendance_extension_disabled = true;
  if (activeObserver) activeObserver.disconnect();
  globalNumbers.clear();
  strikeZoneNumbers.clear();
});

window.addEventListener('pagehide', () => {
  window.__meet_attendance_extension_disabled = true;
  if (activeObserver) activeObserver.disconnect();
  globalNumbers.clear();
  strikeZoneNumbers.clear();
});

// --- Push Notification Helper ---
function sendPushNotification(title, body) {
  if (window.__meet_attendance_extension_disabled) return;
  if (!isInActiveCall()) return;

  if (typeof Notification !== 'undefined' && Notification.permission === "granted") {
    try {
      new Notification(title, { 
        body: body,
        icon: "https://www.gstatic.com/meet/app_icon_192.png", 
        requireInteraction: false 
      });
    } catch (e) {
      console.warn("[Attendance System] Notification error:", e);
    }
  }
}

// --- Helper to Extract Pure Roll Numbers from Text ---
function extractNumbers(text) {
  if (!text) return [];
  // Strip Google Meet UI noise words (e.g. keepPin, pin, unmute, mic)
  const cleaned = text.replace(/keepPin|keep pin|pin|unmute|mute|microphone|mic|more_vert|keyboard_arrow|contributors|participant|host|admin/gi, ' ');
  
  const matches = cleaned.match(/\b\d+\b/g);
  if (!matches) return [];

  // Only retain valid roll numbers (1 to 250)
  const validNumbers = matches.filter(num => {
    const val = parseInt(num, 10);
    return val > 0 && val <= 250;
  });

  return [...new Set(validNumbers)];
}

// --- Helper to Compile Sorted Bulk Roll Call String (1,2,3,4 format) ---
function getAllRollCallsString() {
  const allRollsSet = new Set();
  extractedData.forEach((data) => {
    const rolls = data.rolls || (data instanceof Set ? data : new Set());
    rolls.forEach(n => {
      if (n && String(n).trim()) {
        allRollsSet.add(String(n).trim());
      }
    });
  });

  const sorted = Array.from(allRollsSet).sort((a, b) => {
    const numA = parseInt(a, 10);
    const numB = parseInt(b, 10);
    if (!isNaN(numA) && !isNaN(numB) && String(numA) === a && String(numB) === b) {
      return numA - numB;
    }
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });

  return sorted.join(',');
}

// --- Copy Roll Calls to Clipboard ---
function copyAllRollCallsToClipboard() {
  const rollsStr = getAllRollCallsString();
  if (!rollsStr) return;

  try {
    const textarea = document.createElement('textarea');
    textarea.value = rollsStr;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  } catch (err) {
    console.warn("DOM copy fallback warning:", err);
  }
}

// --- Active Meeting Call Guard ---
function isInActiveCall() {
  if (window.__meet_attendance_extension_disabled) return false;

  const path = window.location.pathname.replace(/^\//, '').trim();
  if (!path || path === 'landing' || path.startsWith('landing') || path === 'calling' || path.startsWith('exit') || path.startsWith('feedback')) {
    return false;
  }

  const isMeetingCodeUrl = /^[a-z0-9]{3,4}-[a-z0-9]{3,4}-[a-z0-9]{3,4}/i.test(path);
  const hasInCallControls = !!document.querySelector('[aria-label="Leave call"], button[aria-label*="Leave call"], [aria-label*="leave call"], button[aria-label*="leave call"]');

  return isMeetingCodeUrl && hasInCallControls;
}

// --- SILENT ATTENDANCE ALERT TRIGGER (Audio & Push Only) ---
function triggerAttendanceAlert(title, reason, type = 'urgent', matchedKeyword = null) {
  if (!isInActiveCall()) return;

  // Strictly suppress pattern radar alerts when Pattern Mode is disabled
  if (!userSettings.enablePatternMode && (title.includes("STRIKE") || title.includes("Radar Active"))) {
    return;
  }

  const now = Date.now();
  if (type === 'urgent' && now - lastSentTime < userSettings.cooldownTime) return; 
  if (type === 'warning' && now - lastWarningTime < userSettings.warningCooldown) return;

  if (type === 'urgent') lastSentTime = now;
  if (type === 'warning') lastWarningTime = now;

  console.log(`%c[ATTENDANCE ALERT] ${title}: ${reason}`, "color: #00ff00; font-weight: bold; font-size: 14px;");

  playAlertSound(type);
  sendPushNotification(title, reason);
}

// --- RADAR ANALYZER & STRICT CONTAINER CHECK ---
function isFromValidSource(node) {
  if (!isInActiveCall()) return false;

  let element = (node.nodeType === Node.TEXT_NODE) ? node.parentElement : node;
  if (!element || !element.closest) return false;

  // Ignore inputs, buttons, tooltips, counters, icons, and non-chat elements
  if (element.closest('input, textarea, button, svg, img, script, style, [role="tooltip"], [aria-label="Participants"], .V6tdP, .MKVSQd, .d93U2d')) {
    return false;
  }

  // Strictly allow actual chat messages or live caption elements
  return !!element.closest('[aria-label="Captions"], [jsname="dTKtvb"], [data-message-text], [aria-live="polite"]');
}

function analyzeText(text) {
  if (!isInActiveCall() || !text) return;
  let cleanText = text.toLowerCase().trim();

  // Filter out time strings like 12:43 or 09:15
  if (/\b\d{1,2}:\d{2}\b/.test(cleanText)) return;

  // Filter out Google Meet UI system strings & settings/exit page text
  if (/contributors|meeting host|participants|in call|keyboard_arrow|more_vert|unmute|setting|settings|feedback|quality|rate/i.test(cleanText)) return;

  cleanText = cleanText.replace("arrow_downward", "").replace("jump to the bottom", "").replace("you", "");
  if (cleanText.length < 1) return;

  let matchedKeyword = null;
  const exactMatch = userSettings.myRollNumbers.some(num => {
    if (!num || !num.trim()) return false;
    const cleanNum = num.trim();
    const escapedNum = cleanNum.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`(^|\\W)${escapedNum}(\\W|$)`, 'i');
    if (regex.test(cleanText)) {
      matchedKeyword = cleanNum;
      return true;
    }
    return false;
  });

  if (exactMatch && matchedKeyword) {
    triggerAttendanceAlert(
      "🚨 IT'S YOUR TURN!", 
      `Matched keyword "${matchedKeyword}" in chat/captions! ("${cleanText}")`, 
      'urgent',
      matchedKeyword
    );
    return;
  }

  // Pattern Mode Radar Analysis
  if (userSettings.enablePatternMode && cleanText.length < 60) {
    const digitsFound = cleanText.match(/\b\d+\b/g);
    
    if (digitsFound) {
      const sMin = parseInt(userSettings.strikeMin, 10);
      const sMax = parseInt(userSettings.strikeMax, 10);

      digitsFound.forEach(digit => {
        let val = parseInt(digit, 10);
        if (val > 0 && val <= 150) {
          globalNumbers.add(val);
          
          if (!isNaN(sMin) && !isNaN(sMax) && val >= sMin && val <= sMax) {
            strikeZoneNumbers.add(val);
          }
        }
      });

      clearTimeout(clearSetTimeout);
      clearSetTimeout = setTimeout(() => {
        globalNumbers.clear();
        strikeZoneNumbers.clear();
      }, 30000);

      const isScrambled = userSettings.patternMode === 'scrambled';
      const requiredHits = isScrambled ? 1 : 2;

      if (strikeZoneNumbers.size >= requiredHits) {
        const hits = Array.from(strikeZoneNumbers).sort((a,b)=>a-b).join(', ');
        const modeLabel = isScrambled ? 'Scrambled Pattern' : 'Sequential Pattern';
        triggerAttendanceAlert("⚡ STRIKE ZONE HIT!", `Roll call detected in your strike range! (${modeLabel}) Saw: ${hits}`, 'urgent');
        strikeZoneNumbers.clear();
        globalNumbers.clear();
        return;
      }

      const requiredRadarCount = isScrambled ? 3 : 4;
      if (globalNumbers.size >= requiredRadarCount) {
        const now = Date.now();
        if (now - lastWarningTime > userSettings.warningCooldown) {
          const hits = Array.from(globalNumbers).sort((a,b)=>a-b).join(', ');
          const modeLabel = isScrambled ? 'Scrambled Pattern' : 'Sequential Pattern';
          triggerAttendanceAlert("👀 Attendance Radar Active", `Roll call activity detected! (${modeLabel}) Saw numbers: ${hits}`, 'warning');
        }
      }
    }
  } else if (!userSettings.enablePatternMode) {
    globalNumbers.clear();
    strikeZoneNumbers.clear();
  }
}

// --- Participant Name Sanitizer ---
function cleanParticipantName(rawName) {
  if (!rawName) return '';
  return rawName
    .replace(/\(You\)/gi, '')
    .replace(/Meeting host/gi, '')
    .replace(/\b\d{1,2}:\d{2}\s*(AM|PM)?\b/gi, '')
    .replace(/microphone\s+(off|on|muted)/gi, '')
    .replace(/video\s+(off|on)/gi, '')
    .replace(/keepPin|keep pin|pin|unmute|mute|microphone|mic|more_vert|keyboard_arrow_down|keyboard_arrow/gi, '')
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Time & Duration Format Helpers ---
function formatTimeString(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0m 0s';
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours > 0) {
    return `${hours}h ${remMins}m ${secs}s`;
  }
  return `${remMins}m ${secs}s`;
}

// --- Fuzzy & Case-Insensitive Participant Key Normalizer ---
function findOrCreateParticipantKey(cleanName) {
  if (!cleanName) return '';
  const lowerNew = cleanName.toLowerCase().trim();

  for (const existingKey of extractedData.keys()) {
    const lowerExisting = existingKey.toLowerCase().trim();
    if (lowerExisting === lowerNew) return existingKey;

    // Match First Name + Last Name (e.g. "SATVIK SUNIL PATIL" <-> "Satvik Patil")
    const wordsNew = lowerNew.split(/\s+/);
    const wordsExist = lowerExisting.split(/\s+/);
    if (wordsNew.length >= 2 && wordsExist.length >= 2) {
      if (wordsNew[0] === wordsExist[0] && wordsNew[wordsNew.length - 1] === wordsExist[wordsExist.length - 1]) {
        return existingKey;
      }
    }
  }

  return cleanName;
}

// --- Central Participant State Tracker ---
function recordParticipantState(rawCleanName, extractedRoll = null) {
  const now = Date.now();
  const cleanName = findOrCreateParticipantKey(rawCleanName);

  if (!extractedData.has(cleanName)) {
    extractedData.set(cleanName, {
      rolls: new Set(),
      firstSeen: now,
      lastSeen: now
    });
  }

  let data = extractedData.get(cleanName);
  if (data instanceof Set) {
    data = {
      rolls: data,
      firstSeen: now,
      lastSeen: now
    };
    extractedData.set(cleanName, data);
  }

  data.lastSeen = now;
  if (extractedRoll) {
    data.rolls.add(extractedRoll);
  }
  return data;
}

// --- Auto-Open Panels (People & Chat) ---
function openPeoplePanel() {
  const selectors = [
    'button[aria-label*="Show everyone"]',
    'button[aria-label*="People"]',
    'button[aria-label*="participants"]',
    '[data-panel-id="1"]',
    '[data-tab-id="1"]',
    '[jsname="nav9Xe"]',
    '.nI4yAd',
    '.fdZ55'
  ];
  
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      const clickTarget = el.closest('button, [role="button"]') || el;
      if (clickTarget.getAttribute('aria-pressed') !== 'true') {
        clickTarget.click();
        return true;
      }
    }
  }
  return false;
}

function openChatPanel() {
  const selectors = [
    'button[aria-label*="Chat with everyone"]',
    'button[aria-label*="Chat"]',
    '[aria-label*="Chat"]',
    '[aria-label*="chat"]',
    '[data-panel-id="2"]',
    '[data-tab-id="2"]',
    '.VYBDae-Bz112c-RLmnJb'
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      const clickTarget = el.closest('button, [role="button"]') || el;
      if (clickTarget.getAttribute('aria-pressed') !== 'true') {
        clickTarget.click();
        return true;
      }
    }
  }
  return false;
}

async function autoScanMeeting() {
  if (!isInActiveCall()) return;

  // 1. Open People panel to load all members in DOM
  openPeoplePanel();
  await new Promise(r => setTimeout(r, 400));
  scanParticipants();

  // Scroll participant container if scrollable
  const participantElem = document.querySelector('*[data-participant-id], div[role="listitem"]');
  if (participantElem) {
    let container = participantElem.parentElement;
    let attempts = 0;
    while (container && window.getComputedStyle(container).overflowY === 'visible' && container.parentElement && attempts < 10) {
      container = container.parentElement;
      attempts++;
    }
    if (container) {
      container.scrollTop += 300;
      await new Promise(r => setTimeout(r, 200));
      scanParticipants();
    }
  }

  // 2. Open Chat panel to load all chat roll calls in DOM
  openChatPanel();
  await new Promise(r => setTimeout(r, 400));
  scanChatMessages();
}

// --- Robust Sender Name Extractor for Chat Messages ---
function getSenderNameForElement(element) {
  let curr = element;
  let depth = 0;
  
  while (curr && curr !== document.body && depth < 15) {
    // 1. Check for explicit sender name element
    const nameEl = curr.querySelector('.poVWob, .Zs7gze, .zWGUib, [data-sender-name], .pl2yad');
    if (nameEl && nameEl.textContent) {
      const text = nameEl.textContent.trim();
      if (text && !/^\d{1,2}:\d{2}(\s*[ap]m)?$/i.test(text)) {
        return text;
      }
    }

    // 2. Check for sender avatar image alt attribute
    const imgEl = curr.querySelector('img.nkcAbf[alt], img[alt]');
    if (imgEl) {
      const alt = imgEl.getAttribute('alt');
      if (alt && alt.trim() && !/avatar|profile|photo/i.test(alt.trim())) {
        return alt.trim();
      }
    }

    // 3. Check for data-sender-name attribute
    const senderAttr = curr.getAttribute('data-sender-name');
    if (senderAttr && senderAttr.trim()) {
      return senderAttr.trim();
    }

    curr = curr.parentElement;
    depth++;
  }

  return '';
}

// --- Main Chat Extraction Scanner ---
function scanChatMessages() {
  if (!isInActiveCall()) return;

  const textElements = document.querySelectorAll('[jsname="dTKtvb"], [data-message-text]');
  const knownHosts = Array.from(getHostNames());
  const defaultHostName = knownHosts.length > 0 ? knownHosts[0] : "Meeting Host / Admin";
  const processedNodes = new Set();

  textElements.forEach(textEl => {
    const msgContainer = textEl.closest('[jsname="dTKtvb"], [data-message-text]') || textEl;
    if (processedNodes.has(msgContainer)) return;
    processedNodes.add(msgContainer);

    let rawName = getSenderNameForElement(msgContainer);
    let cleanName = cleanParticipantName(rawName);

    // If no participant name was found, only attribute to Host if it's an admin/pinned message banner
    if (!cleanName) {
      const isPinnedOrAdminBanner = !!msgContainer.closest('.chmVPb, .Sd72u, [aria-label*="Pin"], button[data-message-id]');
      if (isPinnedOrAdminBanner) {
        cleanName = defaultHostName;
      }
    }

    if (!cleanName) return;

    const text = msgContainer.textContent || '';
    const numbers = extractNumbers(text);
    if (numbers.length > 0) {
      numbers.forEach(num => {
        recordParticipantState(cleanName, num);
      });
    } else {
      recordParticipantState(cleanName);
    }
  });
}

// --- Participant List Scanner (Detect Members Joined in Current Meeting) ---
function scanParticipants() {
  if (!isInActiveCall()) return;

  // 1. Scan participant side panel & video tile containers
  const participantElements = document.querySelectorAll(
    '*[data-participant-id], *[data-requested-participant-id], div[role="listitem"], ' +
    'div[data-self-name], div[data-name], .cxdMu, .KV1GEc, .pjv25, .l425fd, .S1s5ce, .Q8T12e'
  );
  
  participantElements.forEach(pEl => {
    let rawName = '';

    // Check data-self-name or data-name attributes directly on container
    if (pEl.hasAttribute('data-self-name')) {
      rawName = pEl.getAttribute('data-self-name');
    } else if (pEl.hasAttribute('data-name')) {
      rawName = pEl.getAttribute('data-name');
    }

    // Check inner text element candidates
    if (!rawName) {
      const nameEl = pEl.querySelector('.zWGUib, .poVWob, .Zs7gze, .Xw370c, .DWv25b, .Yvsevd, span[dir="auto"]');
      if (nameEl && nameEl.textContent) {
        rawName = nameEl.textContent;
      }
    }

    // Check avatar image alt attribute
    if (!rawName) {
      const imgEl = pEl.querySelector('img[alt]');
      if (imgEl) {
        const alt = imgEl.getAttribute('alt');
        if (alt && alt.trim() && !/avatar|profile|photo|picture/i.test(alt.trim())) {
          rawName = alt.trim();
        }
      }
    }

    // Check aria-label attribute
    if (!rawName) {
      const ariaLabel = pEl.getAttribute('aria-label');
      if (ariaLabel && !/video|button|mute|pin|more|options|controls/i.test(ariaLabel)) {
        rawName = ariaLabel.split(',')[0];
      }
    }

    const cleanName = cleanParticipantName(rawName);
    if (!cleanName || cleanName.length < 2) return;

    const data = recordParticipantState(cleanName);

    // Extract roll numbers embedded directly in participant's display name
    const nameRolls = extractNumbers(cleanName);
    nameRolls.forEach(num => data.rolls.add(num));
  });

  // 2. Scan all standalone participant name labels across Google Meet
  const standaloneNameEls = document.querySelectorAll('.zWGUib, .poVWob, .Zs7gze, .Xw370c, div[data-self-name]');
  standaloneNameEls.forEach(el => {
    let rawName = el.getAttribute('data-self-name') || el.textContent || '';
    const cleanName = cleanParticipantName(rawName);
    if (cleanName && cleanName.length >= 2 && !/chat|everyone|people|details|in call|meeting host/i.test(cleanName)) {
      recordParticipantState(cleanName);
    }
  });
}

// --- Host Exclusion / Identification Logic ---
function getHostNames() {
  const hosts = new Set();
  const participants = document.querySelectorAll('div[role="listitem"], *[data-participant-id], .cxdMu');
  
  participants.forEach(p => {
    if (p.textContent.includes("Meeting host") || p.innerHTML.includes("Meeting host")) {
      const nameEl = p.querySelector('.zWGUib, .poVWob, .Zs7gze');
      if (nameEl) {
        hosts.add(cleanParticipantName(nameEl.textContent));
      } else {
        const ariaLabel = p.getAttribute('aria-label');
        if (ariaLabel) hosts.add(cleanParticipantName(ariaLabel.split(',')[0]));
      }
    }
  });

  const hostBadges = document.querySelectorAll('.d93U2d, .qrLqp');
  hostBadges.forEach(badge => {
    if (badge.textContent.includes('Meeting host')) {
      const container = badge.closest('[role="listitem"], *[data-participant-id], .cxdMu');
      if (container) {
        const nameEl = container.querySelector('.zWGUib, .poVWob, .Zs7gze');
        if (nameEl) hosts.add(cleanParticipantName(nameEl.textContent));
        else {
          const ariaLabel = container.getAttribute('aria-label');
          if (ariaLabel) hosts.add(cleanParticipantName(ariaLabel.split(',')[0]));
        }
      }
    }
  });
  
  return hosts;
}

// --- AUTO-ADMIT PARTICIPANTS ENGINE ---
function checkAndAutoAdmit() {
  if (!userSettings.enableAutoAdmit) return;

  try {
    // 1. Primary "Admit" button lookup by Google Meet jsname attribute "USyMUd"
    const admitBtns = document.querySelectorAll('[jsname="USyMUd"]');
    admitBtns.forEach(btn => {
      if (btn && typeof btn.click === 'function') {
        btn.click();
        console.log("%c[Auto-Admit] Admitted participant via USyMUd!", "color: #00ff00; font-weight: bold;");
      }
    });

    // 2. Fallback search for buttons or spans containing text "Admit" or "Admit all"
    const candidates = document.querySelectorAll('button, span[role="button"], div[role="button"], span');
    candidates.forEach(el => {
      const text = (el.innerText || el.textContent || '').trim();
      if (text === 'Admit' || text === 'Admit all') {
        if (typeof el.click === 'function') {
          el.click();
          console.log("%c[Auto-Admit] Clicked " + text, "color: #00ff00; font-weight: bold;");
        }
      }
    });
  } catch (e) {
    console.warn("Auto-Admit error:", e);
  }
}

setInterval(() => {
  if (!isInActiveCall()) {
    globalNumbers.clear();
    strikeZoneNumbers.clear();
    return;
  }
  scanChatMessages();
  scanParticipants();
  checkAndAutoAdmit();
}, 1000);

// --- EXPORT IN FILES (CSV & EXCEL XLS) ---
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getMeetingName() {
  let name = "Meeting";
  const titleEl = document.querySelector('[data-meeting-title]'); 
  if (titleEl && titleEl.textContent) {
    name = titleEl.textContent;
  } else {
    name = document.title || "Meeting";
  }
  return name.replace(/^Meet\s*-\s*/i, '').trim();
}

function getSortLabel(sortBy) {
  switch(sortBy) {
    case 'roll_desc': return 'Roll Number (Descending)';
    case 'duration_desc': return 'Meeting Duration (Longest First)';
    case 'duration_asc': return 'Meeting Duration (Shortest First)';
    case 'name_asc': return 'Student Name (A to Z)';
    case 'name_desc': return 'Student Name (Z to A)';
    case 'joined_asc': return 'Joined Time (Earliest First)';
    case 'joined_desc': return 'Joined Time (Latest First)';
    default: return 'Roll Number (Ascending)';
  }
}

function getAttendanceExportData(sortBy = 'roll_asc') {
  const hosts = getHostNames();
  const meetingName = getMeetingName();
  const dataList = [];
  const allRollsSet = new Set();
  const now = Date.now();

  extractedData.forEach((data, name) => {
    const cleanName = cleanParticipantName(name);
    let isHost = false;
    if (hosts.has(cleanName)) isHost = true;
    hosts.forEach(h => {
      if (cleanParticipantName(h) === cleanName) isHost = true;
    });

    const rolls = data.rolls || (data instanceof Set ? data : new Set());
    const firstSeen = data.firstSeen || now;
    const lastSeen = data.lastSeen || now;
    const durationMs = lastSeen - firstSeen;

    const firstSeenStr = formatTimeString(firstSeen);
    const lastSeenStr = formatTimeString(lastSeen);
    const durationStr = formatDuration(durationMs);

    const sortedStudentRolls = Array.from(rolls).sort((a, b) => {
      const numA = parseInt(a, 10);
      const numB = parseInt(b, 10);
      if (!isNaN(numA) && !isNaN(numB) && String(numA) === a && String(numB) === b) {
        return numA - numB;
      }
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });

    // Keep ONLY ONE primary roll number in the Roll Number column
    const primaryRoll = sortedStudentRolls.length > 0 ? sortedStudentRolls[0] : '';
    rolls.forEach(n => allRollsSet.add(n));

    let notesArr = [];
    if (isHost) notesArr.push("Meeting Host / Admin");
    if (sortedStudentRolls.length > 1) {
      notesArr.push(`⚠️ Multiple Rolls: ${sortedStudentRolls.join(', ')}`);
    }
    let notes = notesArr.join(' | ');

    dataList.push({
      name: cleanName,
      firstSeen: firstSeenStr,
      lastSeen: lastSeenStr,
      duration: durationStr,
      durationMs: durationMs,
      firstSeenMs: firstSeen,
      roll: primaryRoll,
      notes: notes
    });
  });

  // Dynamic Multi-Criterion Sorting
  dataList.sort((a, b) => {
    if (sortBy === 'duration_desc') {
      return b.durationMs - a.durationMs;
    } else if (sortBy === 'duration_asc') {
      return a.durationMs - b.durationMs;
    } else if (sortBy === 'name_asc') {
      return a.name.localeCompare(b.name);
    } else if (sortBy === 'name_desc') {
      return b.name.localeCompare(a.name);
    } else if (sortBy === 'joined_asc') {
      return a.firstSeenMs - b.firstSeenMs;
    } else if (sortBy === 'joined_desc') {
      return b.firstSeenMs - a.firstSeenMs;
    } else if (sortBy === 'roll_desc') {
      const valA = a.roll ? parseInt(a.roll, 10) : -1;
      const valB = b.roll ? parseInt(b.roll, 10) : -1;
      if (!isNaN(valA) && !isNaN(valB) && valA !== -1 && valB !== -1) {
        return valB - valA;
      }
      return b.roll.localeCompare(a.roll, undefined, { numeric: true });
    } else {
      // Default: roll_asc
      const valA = a.roll ? parseInt(a.roll, 10) : 999999;
      const valB = b.roll ? parseInt(b.roll, 10) : 999999;
      if (!isNaN(valA) && !isNaN(valB) && valA !== 999999 && valB !== 999999) {
        if (valA !== valB) return valA - valB;
      } else if (valA !== 999999 && valB === 999999) {
        return -1;
      } else if (valA === 999999 && valB !== 999999) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    }
  });

  const allRollsSorted = Array.from(allRollsSet)
    .sort((a, b) => {
      const numA = parseInt(a, 10);
      const numB = parseInt(b, 10);
      if (!isNaN(numA) && !isNaN(numB) && String(numA) === a && String(numB) === b) {
        return numA - numB;
      }
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    })
    .join(',');

  return { meetingName, dataList, allRollsSorted };
}

function downloadCSV(sortBy = 'roll_asc') {
  const data = getAttendanceExportData(sortBy);
  if (data.dataList.length === 0) return;

  const rows = [['Serial No.', 'Student / Member Name', 'Roll Number', 'First Seen (Joined)', 'Last Seen (Active)', 'Time in Meeting (Duration)', 'Notes', 'All Roll Numbers (Comma Separated)']];

  data.dataList.forEach((item, index) => {
    const serial = index + 1;
    const bulkCell = (index === 0) ? data.allRollsSorted : '';
    rows.push([serial, item.name, item.roll, item.firstSeen, item.lastSeen, item.duration, item.notes, bulkCell]);
  });

  const csvContent = "\ufeff" + rows.map(e => e.map(field => {
    let stringField = String(field);
    if (stringField.includes('"') || stringField.includes(',') || stringField.includes('\n')) {
      stringField = `"${stringField.replace(/"/g, '""')}"`;
    }
    return stringField;
  }).join(",")).join("\n");

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  const dateStr = new Date().toISOString().slice(0,10);
  const cleanFileName = data.meetingName.replace(/[^a-z0-9\-_]/gi, '_').replace(/_+/g, '_');
  link.setAttribute("download", `${cleanFileName}_Attendance_${dateStr}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function downloadXLS(sortBy = 'roll_asc') {
  const data = getAttendanceExportData(sortBy);
  if (data.dataList.length === 0) return;

  const dateStr = new Date().toISOString().slice(0, 10);
  const cleanFileName = data.meetingName.replace(/[^a-z0-9\-_]/gi, '_').replace(/_+/g, '_');

  let excelHTML = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <!--[if gte mso 9]>
      <xml>
        <x:ExcelWorkbook>
          <x:ExcelWorksheets>
            <x:ExcelWorksheet>
              <x:Name>Attendance Report</x:Name>
              <x:WorksheetOptions>
                <x:DisplayGridlines/>
              </x:WorksheetOptions>
            </x:ExcelWorksheet>
          </x:ExcelWorksheets>
        </x:ExcelWorkbook>
      </xml>
      <![endif]-->
      <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; margin: 20px; background-color: #ffffff; color: #202124; }
        .header-card { background: #1a73e8; color: #ffffff; padding: 18px 24px; border-radius: 10px; margin-bottom: 20px; }
        .header-card h2 { margin: 0 0 8px 0; font-size: 20px; font-weight: 700; }
        .header-card p { margin: 0; font-size: 13px; opacity: 0.95; }
        table { border-collapse: collapse; width: 100%; font-size: 13px; }
        th { background-color: #1565c0; color: #ffffff; font-weight: 700; border: 1px solid #d0d0d0; padding: 10px 14px; text-align: left; font-size: 13px; }
        td { border: 1px solid #e0e0e0; padding: 9px 14px; font-size: 13px; color: #202124; }
        tr:nth-child(even) { background-color: #f8f9fa; }
        .num { text-align: center; font-weight: 700; color: #1a73e8; }
        .name { font-weight: 600; color: #202124; }
        .duration-badge { font-weight: 700; color: #1967d2; text-align: center; }
        .notes-badge { color: #d93025; font-weight: 600; }
        .bulk { font-family: Consolas, monospace; background-color: #f1f3f4; color: #3c4043; font-weight: 600; padding: 6px 10px; }
      </style>
    </head>
    <body>
      <div class="header-card">
        <h2>Google Meet Attendance Report — ${escapeHTML(data.meetingName)}</h2>
        <p><b>Date:</b> ${dateStr} &nbsp;|&nbsp; <b>Total Members:</b> ${data.dataList.length} &nbsp;|&nbsp; <b>Total Roll Calls:</b> ${data.allRollsSorted ? data.allRollsSorted.split(',').length : 0} &nbsp;|&nbsp; <b>Sorted By:</b> ${getSortLabel(sortBy)}</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Serial No.</th>
            <th>Student / Member Name</th>
            <th>Roll Number</th>
            <th>First Seen (Joined)</th>
            <th>Last Seen (Active)</th>
            <th>Time in Meeting (Duration)</th>
            <th>Notes</th>
            <th>All Roll Numbers (Comma Separated)</th>
          </tr>
        </thead>
        <tbody>
  `;

  data.dataList.forEach((item, index) => {
    const serial = index + 1;
    const bulkCell = (index === 0) ? data.allRollsSorted : '';
    excelHTML += `
      <tr>
        <td class="num">${serial}</td>
        <td class="name">${escapeHTML(item.name)}</td>
        <td class="num">${escapeHTML(item.roll)}</td>
        <td>${escapeHTML(item.firstSeen)}</td>
        <td>${escapeHTML(item.lastSeen)}</td>
        <td class="duration-badge">${escapeHTML(item.duration)}</td>
        <td class="notes-badge">${escapeHTML(item.notes)}</td>
        <td class="bulk">${escapeHTML(bulkCell)}</td>
      </tr>
    `;
  });

  excelHTML += `
        </tbody>
      </table>
    </body>
    </html>
  `;

  const blob = new Blob([excelHTML], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `${cleanFileName}_Attendance_${dateStr}.xls`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// --- GLOBAL MUTATION OBSERVER WITH STRICT CONTAINERS ---
let activeObserver = null;

function initObserver() {
  if (activeObserver) return;
  if (!document.body) return;

  activeObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.target.tagName === 'TEXTAREA' || mutation.target.tagName === 'INPUT') continue;

      if (!isFromValidSource(mutation.target)) continue;

      if (mutation.type === 'childList') {
        scanParticipants();
        mutation.addedNodes.forEach(node => {
          if (!isFromValidSource(node)) return;

          if (node.nodeType === Node.ELEMENT_NODE) {
            analyzeText(node.innerText || node.textContent);
          } else if (node.nodeType === Node.TEXT_NODE) {
            analyzeText(node.nodeValue);
          }
        });
      }
    }
  });

  activeObserver.observe(document.body, { childList: true, subtree: true });
  console.log("%c[Attendance System] Silent Strict Observer Active.", "color: cyan; font-weight: bold;");
}

// --- INSTANT SILENT INITIALIZATION ---
function startExtension() {
  if (window.__meet_attendance_extension_initialized) {
    initObserver();
    return;
  }
  window.__meet_attendance_extension_initialized = true;

  if (typeof Notification !== 'undefined' && Notification.permission !== "granted" && Notification.permission !== "denied") {
    Notification.requestPermission();
  }

  initObserver();
  scanChatMessages();
  scanParticipants();
  console.log("%c[Attendance System] Silent Background Engine Active.", "color: #00ff00; font-weight: bold;");
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  startExtension();
} else {
  document.addEventListener('DOMContentLoaded', startExtension);
  window.addEventListener('load', startExtension);
}

setInterval(() => {
  if (!activeObserver && document.body) {
    initObserver();
  }
}, 1000);

// --- CHROME EXTENSION POPUP MESSAGE & STORAGE LISTENERS ---
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'GET_STATUS') {
      scanChatMessages();
      scanParticipants();
      const rollsStr = getAllRollCallsString();
      const count = rollsStr ? rollsStr.split(',').length : 0;
      sendResponse({
        status: 'ok',
        totalStudents: extractedData.size,
        rollCallsCount: count,
        rollsString: rollsStr,
        patternMode: userSettings.patternMode,
        enablePatternMode: userSettings.enablePatternMode
      });
    } else if (request.action === 'AUTO_SCAN') {
      autoScanMeeting().then(() => {
        const rollsStr = getAllRollCallsString();
        const count = rollsStr ? rollsStr.split(',').length : 0;
        sendResponse({
          status: 'ok',
          totalStudents: extractedData.size,
          rollCallsCount: count,
          rollsString: rollsStr
        });
      });
      return true;
    } else if (request.action === 'COPY_ROLLS') {
      scanChatMessages();
      scanParticipants();
      copyAllRollCallsToClipboard();
      sendResponse({ status: 'ok', rolls: getAllRollCallsString() });
    } else if (request.action === 'EXPORT_CSV') {
      scanChatMessages();
      scanParticipants();
      const sortBy = request.sortBy || 'roll_asc';
      const exportData = getAttendanceExportData(sortBy);
      if (!exportData || exportData.dataList.length === 0) {
        sendResponse({ status: 'empty' });
      } else {
        const rows = [['Serial No.', 'Student / Member Name', 'Roll Number', 'First Seen (Joined)', 'Last Seen (Active)', 'Time in Meeting (Duration)', 'Notes', 'All Roll Numbers (Comma Separated)']];
        exportData.dataList.forEach((item, index) => {
          const serial = index + 1;
          const bulkCell = (index === 0) ? exportData.allRollsSorted : '';
          rows.push([serial, item.name, item.roll, item.firstSeen, item.lastSeen, item.duration, item.notes, bulkCell]);
        });
        const csvContent = "\ufeff" + rows.map(e => e.map(field => {
          let stringField = String(field);
          if (stringField.includes('"') || stringField.includes(',') || stringField.includes('\n')) {
            stringField = `"${stringField.replace(/"/g, '""')}"`;
          }
          return stringField;
        }).join(",")).join("\n");

        const dateStr = new Date().toISOString().slice(0,10);
        const cleanFileName = `${exportData.meetingName.replace(/[^a-z0-9\-_]/gi, '_').replace(/_+/g, '_')}_Attendance_${dateStr}.csv`;

        sendResponse({ status: 'ok', content: csvContent, filename: cleanFileName, mimeType: 'text/csv;charset=utf-8;' });
      }
    } else if (request.action === 'EXPORT_XLS') {
      scanChatMessages();
      scanParticipants();
      const sortBy = request.sortBy || 'roll_asc';
      const exportData = getAttendanceExportData(sortBy);
      if (!exportData || exportData.dataList.length === 0) {
        sendResponse({ status: 'empty' });
      } else {
        const dateStr = new Date().toISOString().slice(0, 10);
        const cleanFileName = `${exportData.meetingName.replace(/[^a-z0-9\-_]/gi, '_').replace(/_+/g, '_')}_Attendance_${dateStr}.xls`;

        let excelHTML = `
          <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
          <head>
            <meta charset="utf-8">
            <!--[if gte mso 9]>
            <xml>
              <x:ExcelWorkbook>
                <x:ExcelWorksheets>
                  <x:ExcelWorksheet>
                    <x:Name>Attendance Report</x:Name>
                    <x:WorksheetOptions>
                      <x:DisplayGridlines/>
                    </x:WorksheetOptions>
                  </x:ExcelWorksheet>
                </x:ExcelWorksheets>
              </x:ExcelWorkbook>
            </xml>
            <![endif]-->
            <style>
              body { font-family: 'Segoe UI', Arial, sans-serif; margin: 20px; background-color: #ffffff; color: #202124; }
              .header-card { background: #1a73e8; color: #ffffff; padding: 18px 24px; border-radius: 10px; margin-bottom: 20px; }
              .header-card h2 { margin: 0 0 8px 0; font-size: 20px; font-weight: 700; }
              .header-card p { margin: 0; font-size: 13px; opacity: 0.95; }
              table { border-collapse: collapse; width: 100%; font-size: 13px; }
              th { background-color: #1565c0; color: #ffffff; font-weight: 700; border: 1px solid #d0d0d0; padding: 10px 14px; text-align: left; font-size: 13px; }
              td { border: 1px solid #e0e0e0; padding: 9px 14px; font-size: 13px; color: #202124; }
              tr:nth-child(even) { background-color: #f8f9fa; }
              tr:hover { background-color: #f1f3f4; }
              .num { text-align: center; font-weight: 700; color: #1a73e8; }
              .name { font-weight: 600; color: #202124; }
              .duration-badge { font-weight: 700; color: #1967d2; text-align: center; }
              .notes-badge { color: #d93025; font-weight: 600; }
              .bulk { font-family: Consolas, monospace; background-color: #f1f3f4; color: #3c4043; font-weight: 600; padding: 6px 10px; }
            </style>
          </head>
          <body>
            <div class="header-card">
              <h2>Google Meet Attendance Report — ${escapeHTML(exportData.meetingName)}</h2>
              <p><b>Date:</b> ${dateStr} &nbsp;|&nbsp; <b>Total Members:</b> ${exportData.dataList.length} &nbsp;|&nbsp; <b>Total Roll Calls:</b> ${exportData.allRollsSorted ? exportData.allRollsSorted.split(',').length : 0} &nbsp;|&nbsp; <b>Sorted By:</b> ${getSortLabel(sortBy)}</p>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Serial No.</th>
                  <th>Student / Member Name</th>
                  <th>Roll Number</th>
                  <th>First Seen (Joined)</th>
                  <th>Last Seen (Active)</th>
                  <th>Time in Meeting (Duration)</th>
                  <th>Notes</th>
                  <th>All Roll Numbers (Comma Separated)</th>
                </tr>
              </thead>
              <tbody>
        `;

        exportData.dataList.forEach((item, index) => {
          const serial = index + 1;
          const bulkCell = (index === 0) ? exportData.allRollsSorted : '';
          excelHTML += `
            <tr>
              <td class="num">${serial}</td>
              <td class="name">${escapeHTML(item.name)}</td>
              <td class="num">${escapeHTML(item.roll)}</td>
              <td>${escapeHTML(item.firstSeen)}</td>
              <td>${escapeHTML(item.lastSeen)}</td>
              <td class="duration-badge">${escapeHTML(item.duration)}</td>
              <td class="notes-badge">${escapeHTML(item.notes)}</td>
              <td class="bulk">${escapeHTML(bulkCell)}</td>
            </tr>
          `;
        });

        excelHTML += `
              </tbody>
            </table>
          </body>
          </html>
        `;

        sendResponse({ status: 'ok', content: excelHTML, filename: cleanFileName, mimeType: 'application/vnd.ms-excel;charset=utf-8;' });
      }
    } else if (request.action === 'UPDATE_SETTINGS') {
      if (request.settings) {
        userSettings = { ...userSettings, ...request.settings };
      }
      sendResponse({ status: 'ok' });
    }
    return true;
  });
}

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.meet_attendance_settings) {
      userSettings = { ...userSettings, ...changes.meet_attendance_settings.newValue };
    }
  });
}

console.log("Google Meet Roll Call Extractor Silent Engine Loaded.");
