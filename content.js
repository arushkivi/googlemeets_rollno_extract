// content.js - Google Meet Roll Call Extractor

// State to store extracted data
// Format: name -> Set of roll numbers
const extractedData = new Map();

// Helper to clean and extract numbers
function extractNumbers(text) {
  if (!text) return [];
  // Extract all digit sequences
  const matches = text.match(/\d+/g);
  if (!matches) return [];
  // Return distinct matches as strings, preserving leading zeros (e.g. "07")
  // We use a Set to deduplicate within the single message immediately
  return [...new Set(matches)];
}

// --- Main Extraction Logic ---

function scanChatMessages() {
  // Strategy: Find message text nodes first (most distinct), then traverse up to find the associated sender.
  // This works for both the Sidebar and "Toast" notifications (popup bubbles) which often use the same internal classes but different containers.
  
  // .ptNLrf = Message Text Class
  // [jsname="dTKtvb"] = Alternative Message Text selector
  const textElements = document.querySelectorAll('.ptNLrf, [jsname="dTKtvb"]');
  
  textElements.forEach(textEl => {
      let name = '';
      
      // Traverse up to find a container that includes the name
      let container = textEl.parentElement;
      let attempts = 0;
      const MAX_LEVELS = 8; // Don't go too high to avoid capturing unrelated names
      
      while (container && attempts < MAX_LEVELS) {
          // Check for Name element in this container
          // .poVWob = Sender Name Class
          // .Zs7gze = Alternative Name Class
          const nameEl = container.querySelector('.poVWob, .Zs7gze');
          
          if (nameEl) {
              name = nameEl.textContent.trim();
              break;
          }
          container = container.parentElement;
          attempts++;
      }

      if (name) {
          const text = textEl.textContent;
          const numbers = extractNumbers(text);
          
          if (numbers.length > 0) {
              if (!extractedData.has(name)) {
                  extractedData.set(name, new Set());
              }
              
              // Add numbers
              numbers.forEach(num => {
                  if (!extractedData.get(name).has(num)) {
                      extractedData.get(name).add(num);
                  }
              });
          }
      }
  });
}

// --- Host Exclusion Logic ---

function getHostNames() {
    const hosts = new Set();
    
    // Search for participants list items
    const participants = document.querySelectorAll('div[role="listitem"]');
    
    participants.forEach(p => {
        // Check for "Meeting host" text
        if (p.textContent.includes("Meeting host") || p.innerHTML.includes("Meeting host")) {
            // Extract Name
            const nameEl = p.querySelector('.zWGUib');
            if (nameEl) {
                hosts.add(nameEl.textContent);
            } else {
                // Fallback: aria-label of the listitem often contains the name
                const ariaLabel = p.getAttribute('aria-label');
                if (ariaLabel) {
                    hosts.add(ariaLabel.split(',')[0]); // Simple split just in case
                }
            }
        }
    });

    // Also try to find "Meeting host" labels directly
    const hostBadges = document.querySelectorAll('.d93U2d, .qrLqp'); // Classes from snippet
    hostBadges.forEach(badge => {
        if (badge.textContent.includes('Meeting host')) {
            // Traverse up to find the name
            const container = badge.closest('[role="listitem"]');
            if (container) {
                const nameEl = container.querySelector('.zWGUib');
                if (nameEl) hosts.add(nameEl.textContent);
            }
        }
    });
    
    return hosts;
}

// --- Periodic Scanning ---

// We scan frequently to catch new messages
setInterval(scanChatMessages, 1000);


// --- Download Logic ---

function getMeetingName() {
    // Try to get meeting name from title or DOM
    let name = "Meeting";
    const titleEl = document.querySelector('[data-meeting-title]'); 
    if (titleEl && titleEl.textContent) {
        name = titleEl.textContent;
    } else {
        name = document.title || "Meeting";
    }
    // Clean up the name: remove "Meet - " prefix if present, and other common junk
    name = name.replace(/^Meet\s*-\s*/i, '').trim();
    return name;
}

function createDownloadButton() {
  if (document.getElementById('meet-roll-call-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'meet-roll-call-btn';
  btn.className = 'meet-roll-call-btn';
  btn.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
  `;
  btn.title = "Download Roll Call";
  
  btn.addEventListener('click', async () => {
      // 1. Check if chat is open
      const chatContainer = document.querySelector('div[role="log"], div[aria-label="Chat messages"]');
      const isChatOpen = chatContainer && chatContainer.offsetParent !== null;

      if (!isChatOpen) {
          // 2. Try to find the chat button
          // Primary: "Chat with everyone" aria-label
          let chatBtn = document.querySelector('button[data-panel-id="2"]') // Highly specific from user snippet
                       || document.querySelector('button[aria-label^="Chat with everyone"]') 
                       || document.querySelector('button[aria-label="Chat with everyone"]')
                       || document.querySelector('[data-tooltip="Chat with everyone"]')
                       || Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Chat with everyone'));
          
          if (!chatBtn) {
             // Try to find by icon content 'chat_bubble' if material icons are used as ligatures
             const icons = document.querySelectorAll('.google-material-icons');
             for (let icon of icons) {
                 if (icon.textContent === 'chat_bubble' || icon.textContent === 'chat') {
                     chatBtn = icon.closest('button');
                     break;
                 }
             }
          }

          if (chatBtn) {
              // Open it
              chatBtn.click();
              // Wait for DOM to render (3 seconds to be safe for loading history)
              await new Promise(r => setTimeout(r, 3000)); 
          } else {
              console.warn("[RollCall] Could not find Chat button to auto-open.");
              // Proceed anyway, maybe it was open but selector failed
          }
      }

      // 3. Force a scan now that it's likely open
      scanChatMessages();
      
      // 4. Refresh host list 
      const hosts = getHostNames();
      
      // 5. Download
      downloadCSV(hosts);
  });
  
  document.body.appendChild(btn);
}

// Helper for download
function downloadCSV(hosts) {
  const meetingName = getMeetingName();
  
  // Prepare data
  const dataList = [];
  const allRollsSet = new Set();

  extractedData.forEach((numbers, name) => {
    // Filter hosts (Exact match check)
    if (hosts.has(name)) return;
    const cleanName = name.replace('(You)', '').trim();
    let isHost = false;
    hosts.forEach(h => {
        if (h.replace('(You)', '').trim() === cleanName) isHost = true;
    });
    if (isHost) return;

    // Sort individual student numbers naturally
    const sortedStudentRolls = Array.from(numbers).sort((a, b) => 
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    );

    // Join with comma NO SPACE
    const rollNumbers = sortedStudentRolls.join(',');
    
    // Collect for bulk list
    numbers.forEach(n => allRollsSet.add(n));

    // Check for multiple entries
    let notes = "";
    if (numbers.size > 1) {
        notes = "⚠️ Multiple Rolls Found";
    }

    dataList.push({
        name: name,
        roll: rollNumbers,
        notes: notes
    });
  });

  // Sort Rows: Roll Number (Natural Sort) then Name
  dataList.sort((a, b) => {
      // Use the first roll number for sorting
      const splitA = a.roll.split(',');
      const splitB = b.roll.split(',');
      const valA = splitA[0] || '';
      const valB = splitB[0] || '';
      
      // Natural sort comparison
      const cmp = valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
      if (cmp !== 0) return cmp;
      
      return a.name.localeCompare(b.name);
  });

  // Create Bulk String (Natural Sort)
  const allRollsSorted = Array.from(allRollsSet)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .join(',');

  // Header
  // Note: We use CSV now. No styling (highlighting) possible, so we use the Notes column.
  const rows = [['Serial No.', 'Student Name', 'Roll Number', 'Notes', 'All Roll Numbers (Bulk)']];

  // Add Rows
  dataList.forEach((item, index) => {
      const serial = index + 1;
      const bulkCell = (index === 0) ? allRollsSorted : ''; // Only first row
      rows.push([serial, item.name, item.roll, item.notes, bulkCell]);
  });

  // Create CSV content with proper escaping and BOM for Excel
  const csvContent = "\ufeff" + rows.map(e => e.map(field => {
      let stringField = String(field);
      // Escape quotes and handle commas
      if (stringField.includes('"') || stringField.includes(',') || stringField.includes('\n')) {
        stringField = `"${stringField.replace(/"/g, '""')}"`;
      }
      return stringField;
    }).join(",")).join("\n");
  
  // Create Download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  const dateStr = new Date().toISOString().slice(0,10);
  // Sanitize filename more aggressively to avoid weird characters
  const cleanFileName = meetingName.replace(/[^a-z0-9\-_]/gi, '_').replace(/_+/g, '_');
  link.setAttribute("download", `${cleanFileName}_Attendance_${dateStr}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Initialize button
setInterval(createDownloadButton, 1000);

console.log("Google Meet Roll Call Extractor Loaded (Class-based)");
