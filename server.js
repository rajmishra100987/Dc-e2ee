const express = require('express');
const http = require('http');
const { chromium } = require('playwright');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ================== CRASH PREVENTION ==================
process.on('unhandledRejection', (err) => {
    console.log('[UNHANDLED REJECTION]', err?.message || err);
});

process.on('uncaughtException', (err) => {
    console.log('[UNCAUGHT EXCEPTION]', err?.message || err);
});

process.on('SIGTERM', async () => {
    console.log('SIGTERM received, cleaning up...');
    for (const [id, t] of activeTasks.entries()) {
        t.isRunning = false;
        if (t.context) await t.context.close().catch(() => {});
    }
    process.exit(0);
});

// ================== CONFIG ==================
const BROWSER_RESTART_INTERVAL = 8 * 60 * 60 * 1000; // 8 hours

// ================== GLOBAL BROWSER ==================
let GLOBAL_BROWSER = null;

async function getBrowser() {
    if (GLOBAL_BROWSER && GLOBAL_BROWSER.isConnected()) {
        return GLOBAL_BROWSER;
    }
    
    console.log('Launching fresh Chromium...');
    GLOBAL_BROWSER = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--no-first-run',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-breakpad',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-hang-monitor',
            '--disable-popup-blocking',
            '--disable-prompt-on-repost',
            '--disable-renderer-backgrounding',
            '--disable-sync',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check',
            '--no-pings',
            '--password-store=basic',
            '--use-mock-keychain',
            '--memory-pressure-off'
        ]
    });
    
    GLOBAL_BROWSER.on('disconnected', () => {
        console.log('⚠️ Global browser disconnected!');
        GLOBAL_BROWSER = null;
    });
    
    return GLOBAL_BROWSER;
}

// ================== ACTIVE TASKS ==================
const activeTasks = new Map();
const sleep = (sec) => new Promise((resolve) => setTimeout(resolve, sec * 1000));

// ================== COOKIE PARSER ==================
function parseCookies(cookieStr) {
    const result = [];
    const seen = new Set();
    
    cookieStr.split(';').forEach(pair => {
        const [name, ...rest] = pair.trim().split('=');
        if (!name || rest.length === 0) return;
        const value = rest.join('=').trim();
        const cookieName = name.trim();
        
        ['.facebook.com', '.messenger.com'].forEach(domain => {
            const key = `${cookieName}|${domain}`;
            if (seen.has(key)) return;
            seen.add(key);
            result.push({
                name: cookieName,
                value: value,
                domain: domain,
                path: '/',
                httpOnly: false,
                secure: true,
                sameSite: 'None'
            });
        });
    });
    
    return result;
}

// ================== HELPERS ==================
async function findInputBox(page, timeout = 10000) {
    const selectors = [
        'div[contenteditable="true"][data-lexical-editor="true"]',
        'div[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"][aria-label*="Message"]',
        'div[aria-label="Message"][contenteditable="true"]',
        'div[contenteditable="true"]'
    ];
    
    for (const sel of selectors) {
        try {
            await page.waitForSelector(sel, { timeout: timeout / selectors.length });
            return sel;
        } catch (e) {}
    }
    return null;
}

async function isSessionAlive(page) {
    try {
        const url = page.url();
        if (url.includes('/login') || url.includes('checkpoint') || url.includes('/recover')) {
            return false;
        }
        const input = await page.$('div[contenteditable="true"]');
        return !!input;
    } catch (e) {
        return false;
    }
}

// ================== SESSION SETUP (BROWSER RESTART KE LIYE REUSABLE) ==================
async function setupSession(cookiesStr, threadId, e2eePin, addLog) {
    const browser = await getBrowser();
    
    const context = await browser.newContext({
        viewport: { width: 800, height: 600 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'Asia/Kolkata'
    });
    
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
    });
    
    await context.addCookies(parseCookies(cookiesStr));
    const page = await context.newPage();
    
    addLog(`Navigating to Thread: ${threadId}`);
    await page.goto(`https://www.messenger.com/t/${threadId}`, { 
        waitUntil: 'domcontentloaded', 
        timeout: 90000 
    });
    await page.waitForTimeout(5000);
    
    // E2EE PIN
    if (e2eePin) {
        try {
            const pinInput = await page.waitForSelector(
                'input[type="password"], input[aria-label*="PIN"]', 
                { timeout: 8000 }
            ).catch(() => null);
            
            if (pinInput) {
                addLog(`E2EE PIN prompt detected.`);
                await pinInput.fill(e2eePin);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(6000);
            }
        } catch (pErr) {}
    }
    
    addLog(`Searching for input box...`);
    const inputSelector = await findInputBox(page, 15000);
    
    if (!inputSelector) {
        await context.close().catch(() => {});
        throw new Error('Chat input box not found. Cookies ya Thread ID check karo.');
    }
    
    return { browser, context, page, inputSelector };
}

// ================== DASHBOARD UI ==================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="hi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Messenger Auto Tool - RAJ MISHRA</title>
    <style>
        * { box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #fce7f3 0%, #ffffff 100%); color: #1f2937; padding: 20px; margin: 0; min-height: 100vh; }
        .container { max-width: 720px; margin: 0 auto; background: #ffffff; padding: 30px; border-radius: 16px; border: 1px solid #fbcfe8; box-shadow: 0 12px 30px rgba(236, 72, 153, 0.15); }
        h2 { text-align: center; color: #db2777; margin-bottom: 5px; font-size: 26px; }
        .developer-tag { text-align: center; color: #6b7280; font-size: 13px; font-weight: bold; margin-bottom: 25px; letter-spacing: 1px; }
        label { font-weight: 600; margin-top: 15px; display: block; color: #4b5563; font-size: 14px; }
        input, textarea { width: 100%; padding: 12px; margin-top: 6px; border-radius: 8px; border: 1px solid #d1d5db; background: #fdf2f8; color: #1f2937; font-size: 14px; }
        input:focus, textarea:focus { border-color: #ec4899; outline: none; background: #fff; box-shadow: 0 0 0 3px rgba(236, 72, 153, 0.1); }
        textarea { height: 90px; resize: vertical; }
        .btn-start { background: linear-gradient(135deg, #ec4899 0%, #db2777 100%); color: white; width: 100%; margin-top: 25px; padding: 14px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 16px; box-shadow: 0 4px 12px rgba(219, 39, 119, 0.3); }
        .btn-start:hover { opacity: 0.95; }
        .btn-stop { background: #ef4444; color: white; padding: 12px 20px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; white-space: nowrap; }
        .btn-stop:hover { background: #dc2626; }
        .btn-view { background: #8b5cf6; color: white; padding: 12px 20px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; white-space: nowrap; }
        .btn-view:hover { background: #7c3aed; }
        .row { display: flex; gap: 10px; align-items: flex-end; margin-top: 10px; }
        .row input { margin-top: 0; }
        .monitor-card { margin-top: 25px; padding: 20px; background: linear-gradient(135deg, #fdf2f8 0%, #ffffff 100%); border: 2px solid #fbcfe8; border-radius: 12px; }
        .monitor-card h3 { color: #db2777; margin: 0 0 15px 0; font-size: 16px; }
        .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 15px; }
        .stat-box { background: #fff; padding: 12px; border-radius: 8px; border: 1px solid #fbcfe8; }
        .stat-label { font-size: 11px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
        .stat-value { font-size: 18px; color: #db2777; font-weight: bold; margin-top: 4px; font-family: monospace; }
        #logBox { background: #111827; padding: 15px; height: 250px; overflow-y: auto; border-radius: 8px; font-family: monospace; font-size: 12px; border: 1px solid #374151; color: #4ade80; }
        #logBox .err { color: #f87171; }
        #logBox .warn { color: #fbbf24; }
        .divider { margin: 25px 0; border-top: 2px dashed #f3f4f6; }
        .hint { font-size: 12px; color: #9ca3af; margin-top: 6px; }
    </style>
</head>
<body>
    <div class="container">
        <h2>Messenger Automation Bot</h2>
        <div class="developer-tag">DEVELOPED BY : RAJ MISHRA</div>
        
        <form id="botForm">
            <label>Messenger Cookie String:</label>
            <textarea id="cookies" placeholder="c_user=...; xs=...; datr=...;" required></textarea>
            <label>Target UID / Thread ID:</label>
            <input type="text" id="threadId" placeholder="e.g. 1000XXXXXXXXX" required>
            <label>E2EE 6-Digit PIN (Optional):</label>
            <input type="password" id="e2eePin" placeholder="e.g. 123456">
            <label>Message Prefix (Optional):</label>
            <input type="text" id="prefix" placeholder="e.g. [RAJ]">
            <label>Messages (.txt File):</label>
            <input type="file" id="msgFile" accept=".txt" required>
            <label>Delay (In Seconds):</label>
            <input type="number" id="delay" value="30" min="5" required>
            <button type="button" class="btn-start" onclick="startTask()">START TASK</button>
        </form>

        <div class="divider"></div>

        <div class="monitor-card">
            <h3>📊 Task Monitor</h3>
            <label>Task ID (live logs + uptime dekhne ke liye):</label>
            <div class="row">
                <input type="text" id="monitorTaskId" placeholder="e.g. TASK-123456">
                <button type="button" class="btn-view" onclick="viewTask()">VIEW</button>
                <button type="button" class="btn-stop" onclick="stopTask()">STOP</button>
            </div>

            <div class="stats-grid" style="margin-top: 15px;">
                <div class="stat-box">
                    <div class="stat-label">Status</div>
                    <div class="stat-value" id="statusBadge">—</div>
                </div>
                <div class="stat-box">
                    <div class="stat-label">Uptime</div>
                    <div class="stat-value" id="uptime">—</div>
                </div>
            </div>

            <div id="logBox">Waiting for task ID...</div>
        </div>
    </div>

    <script>
        let monitorTaskId = null;
        let pollInterval = null;
        let startedAt = null;

        function escapeHtml(s) {
            return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        }

        async function startTask() {
            const cookies = document.getElementById('cookies').value.trim();
            const threadId = document.getElementById('threadId').value.trim();
            const e2eePin = document.getElementById('e2eePin').value.trim();
            const prefix = document.getElementById('prefix').value;
            const delay = parseInt(document.getElementById('delay').value);
            const fileInput = document.getElementById('msgFile');

            if (!cookies || !threadId || fileInput.files.length === 0) {
                alert('Cookies, UID aur Message file bharein!');
                return;
            }

            const text = await fileInput.files[0].text();
            const messages = text.split('\\n').map(m => m.trim()).filter(m => m.length > 0);
            if (messages.length === 0) { alert('Message file khali hai!'); return; }

            const response = await fetch('/api/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cookies, threadId, e2eePin, prefix, messages, delay })
            });

            const data = await response.json();
            if (data.success) {
                document.getElementById('monitorTaskId').value = data.taskId;
                viewTask();
            } else {
                alert("Task start nahi ho payi!");
            }
        }

        function viewTask() {
            const taskId = document.getElementById('monitorTaskId').value.trim();
            if (!taskId) { alert('Task ID daalein!'); return; }
            
            monitorTaskId = taskId;
            startedAt = null;
            document.getElementById('statusBadge').innerHTML = '—';
            document.getElementById('uptime').innerHTML = '—';
            document.getElementById('logBox').innerHTML = 'Loading logs...';
            
            if (pollInterval) clearInterval(pollInterval);
            fetchStatus();
            pollInterval = setInterval(fetchStatus, 2000);
        }

        async function fetchStatus() {
            if (!monitorTaskId) return;
            try {
                const res = await fetch('/api/status/' + monitorTaskId);
                const data = await res.json();
                
                if (!data.found) {
                    document.getElementById('statusBadge').innerHTML = '❌ Not Found';
                    document.getElementById('uptime').innerHTML = '—';
                    document.getElementById('logBox').innerHTML = 'Task not found (expired or invalid ID)';
                    return;
                }
                
                startedAt = data.startedAt;
                document.getElementById('statusBadge').innerHTML = data.isRunning ? '🟢 Running' : '🔴 Stopped';
                
                const logBox = document.getElementById('logBox');
                logBox.innerHTML = data.logs.map(l => {
                    let cls = '';
                    if (l.includes('FATAL') || l.includes('Error') || l.includes('❌')) cls = 'err';
                    else if (l.includes('⚠️') || l.includes('Warning')) cls = 'warn';
                    return '<div class="' + cls + '">' + escapeHtml(l) + '</div>';
                }).join('');
                logBox.scrollTop = logBox.scrollHeight;
            } catch(e) {}
        }

        async function stopTask() {
            const taskId = document.getElementById('monitorTaskId').value.trim();
            if (!taskId) { alert('Task ID daalein!'); return; }
            if (!confirm('Task ' + taskId + ' stop karein?')) return;
            
            await fetch('/api/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId })
            });
            fetchStatus();
        }

        // Uptime ticker - har second update
        setInterval(() => {
            if (!startedAt) return;
            const elapsed = Date.now() - startedAt;
            const d = Math.floor(elapsed / 86400000);
            const h = Math.floor((elapsed % 86400000) / 3600000);
            const m = Math.floor((elapsed % 3600000) / 60000);
            const s = Math.floor((elapsed % 60000) / 1000);
            document.getElementById('uptime').innerHTML = d + 'd ' + h + 'h ' + m + 'm ' + s + 's';
        }, 1000);
    </script>
</body>
</html>
    `);
});

// ================== START API ==================
app.post('/api/start', async (req, res) => {
    const { cookies, threadId, e2eePin, prefix, messages, delay } = req.body;
    
    // Purane running tasks band karo
    for (const [id, t] of activeTasks.entries()) {
        if (t.isRunning) {
            t.isRunning = false;
            if (t.context) await t.context.close().catch(() => {});
        }
    }
    
    const taskId = "TASK-" + Math.floor(100000 + Math.random() * 900000);
    const taskData = {
        taskId,
        isRunning: true,
        startedAt: Date.now(),  // UPTIME KE LIYE
        logs: [`[${new Date().toLocaleTimeString()}] Task Initialized. ID: ${taskId}`],
        context: null
    };

    activeTasks.set(taskId, taskData);

    runPlaywrightBot(taskId, cookies, threadId, e2eePin, prefix, messages, delay)
        .catch(err => {
            console.log('[BOT CRASH]', err.message);
            const t = activeTasks.get(taskId);
            if (t) {
                t.isRunning = false;
                t.logs.push(`[${new Date().toLocaleTimeString()}] [FATAL] ${err.message}`);
            }
        });

    res.json({ success: true, taskId });
});

// ================== MAIN BOT ==================
async function runPlaywrightBot(taskId, cookiesStr, threadId, e2eePin, prefix, messages, delay) {
    const task = activeTasks.get(taskId);
    if (!task) return;

    const addLog = (msg) => {
        if (!task.logs) task.logs = [];
        task.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
        if (task.logs.length > 150) task.logs.shift();
    };

    let context = null;
    let page = null;
    let inputSelector = null;
    let lastRestart = Date.now();

    try {
        addLog(`Setting up session...`);
        const session = await setupSession(cookiesStr, threadId, e2eePin, addLog);
        context = session.context;
        page = session.page;
        inputSelector = session.inputSelector;
        task.context = context;
        
        addLog(`✅ Connected. Starting loop...`);
        addLog(`⏰ Auto browser restart har 8 ghante me hoga.`);

        let index = 0;
        let msgCount = 0;

        while (task.isRunning) {
            
            // ========== 8 HOUR BROWSER RESTART ==========
            if (Date.now() - lastRestart >= BROWSER_RESTART_INTERVAL) {
                addLog(`🔄 8 ghante complete. Browser restart kar raha hoon...`);
                
                // Purana context band
                try { await context.close(); } catch(e) {}
                
                // Global browser bhi reset (fresh Chromium)
                if (GLOBAL_BROWSER) {
                    try { await GLOBAL_BROWSER.close(); } catch(e) {}
                    GLOBAL_BROWSER = null;
                }
                
                // Naya session setup
                try {
                    const newSession = await setupSession(cookiesStr, threadId, e2eePin, addLog);
                    context = newSession.context;
                    page = newSession.page;
                    inputSelector = newSession.inputSelector;
                    task.context = context;
                    lastRestart = Date.now();
                    addLog(`✅ Browser restart successful. Loop continue.`);
                } catch (rErr) {
                    addLog(`❌ Browser restart fail: ${rErr.message}. Task stop.`);
                    task.isRunning = false;
                    break;
                }
            }
            
            // ========== HEALTH CHECK ==========
            if (!page || page.isClosed() || !context) {
                addLog(`❌ Page/Context dead. Stopping.`);
                break;
            }
            
            // ========== SESSION CHECK har 5 msg ==========
            if (msgCount > 0 && msgCount % 5 === 0) {
                const alive = await isSessionAlive(page);
                if (!alive) {
                    addLog(`⚠️ Session expired. Stopping.`);
                    task.isRunning = false;
                    break;
                }
            }

            const rawMsg = messages[index];
            const finalPayload = (prefix ? prefix + " " : "") + rawMsg;

            try {
                await page.evaluate(({ selector, text }) => {
                    const el = document.querySelector(selector);
                    if (el) {
                        el.focus();
                        document.execCommand('selectAll', false, null);
                        document.execCommand('delete', false, null);
                        document.execCommand('insertText', false, text);
                    }
                }, { selector: inputSelector, text: finalPayload });

                await page.waitForTimeout(300);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(1000);

                const stillThere = await page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    return el ? el.innerText.trim().length : -1;
                }, inputSelector).catch(() => -1);

                if (stillThere === -1) {
                    throw new Error('Input box lost');
                } else if (stillThere > 0) {
                    await page.keyboard.press('Enter');
                    await page.waitForTimeout(800);
                    addLog(`✅ Sent (retry): "${finalPayload.substring(0, 40)}"`);
                } else {
                    addLog(`✅ Sent: "${finalPayload.substring(0, 40)}"`);
                }

            } catch (err) {
                addLog(`⚠️ Send Error: ${err.message}`);
                
                if (err.message.includes('Input box') || err.message.includes('Target closed')) {
                    try {
                        addLog(`🔄 Reloading...`);
                        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
                        await page.waitForTimeout(5000);
                        inputSelector = await findInputBox(page, 10000);
                        if (!inputSelector) {
                            addLog(`❌ Input box nahi mila. Stopping.`);
                            break;
                        }
                        continue;
                    } catch (rErr) {
                        addLog(`❌ Reload fail. Stopping.`);
                        break;
                    }
                }
            }

            index = (index + 1) % messages.length;
            msgCount++;

            // ========== MEMORY CLEANUP har 60 msg ==========
            if (msgCount > 0 && msgCount % 60 === 0) {
                addLog(`🔄 Memory cleanup - reload (msg #${msgCount})...`);
                try {
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
                    await page.waitForTimeout(5000);
                    inputSelector = await findInputBox(page, 10000);
                    if (!inputSelector) {
                        addLog(`❌ Reload ke baad input box nahi mila. Stopping.`);
                        break;
                    }
                    addLog(`✅ Memory cleaned.`);
                } catch (rErr) {
                    addLog(`⚠️ Cleanup fail: ${rErr.message}`);
                }
            }

            // ========== FIXED DELAY ==========
            for (let i = 0; i < delay; i++) {
                if (!task.isRunning) break;
                await sleep(1);
            }
        }

        addLog(`Task loop ended.`);

    } catch (err) {
        addLog(`[FATAL] ${err.message}`);
        console.log('[BOT ERROR]', err.message);
    } finally {
        task.isRunning = false;
        try {
            if (context) await context.close();
        } catch (e) {}
    }
}

// ================== STATUS API (UPTIME + LOGS) ==================
app.get('/api/status/:taskId', (req, res) => {
    const task = activeTasks.get(req.params.taskId);
    if (!task) return res.json({ found: false });
    res.json({
        found: true,
        taskId: task.taskId,
        isRunning: task.isRunning,
        startedAt: task.startedAt,
        logs: task.logs || []
    });
});

// ================== STOP API ==================
app.post('/api/stop', async (req, res) => {
    const { taskId } = req.body;
    const task = activeTasks.get(taskId);
    if (!task) return res.json({ message: "Invalid Task ID!" });

    task.isRunning = false;
    if (task.context) await task.context.close().catch(() => {});
    if (task.logs) task.logs.push(`[${new Date().toLocaleTimeString()}] 🛑 Stop signal received.`);
    res.json({ message: `Task ${taskId} stopped!` });
});

// ================== HEALTH ==================
app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: 'ok',
        uptime: Math.round(process.uptime()) + 's',
        ram_mb: Math.round(mem.rss / 1024 / 1024),
        heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
        active_tasks: Array.from(activeTasks.keys()).filter(k => activeTasks.get(k).isRunning),
        browser_alive: GLOBAL_BROWSER?.isConnected() || false
    });
});

// ================== MEMORY MONITOR ==================
setInterval(() => {
    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    console.log(`[MEMORY] RSS: ${rssMB}MB`);
    
    if (rssMB > 850) {
        console.log('⚠️ High memory! Restarting browser...');
        if (GLOBAL_BROWSER) {
            GLOBAL_BROWSER.close().catch(() => {});
            GLOBAL_BROWSER = null;
        }
    }
}, 2 * 60 * 1000);

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
