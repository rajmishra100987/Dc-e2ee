const express = require('express');
const http = require('http');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

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
            '--no-zygote',
            '--single-process',
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

const activeTasks = new Map();
const sleep = (sec) => new Promise((resolve) => setTimeout(resolve, sec * 1000));

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
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #fce7f3 0%, #ffffff 100%); color: #1f2937; padding: 20px; margin: 0; min-height: 100vh; }
        .container { max-width: 680px; margin: 0 auto; background: #ffffff; padding: 30px; border-radius: 16px; border: 1px solid #fbcfe8; box-shadow: 0 12px 30px rgba(236, 72, 153, 0.15); }
        h2 { text-align: center; color: #db2777; margin-bottom: 5px; font-size: 26px; }
        .developer-tag { text-align: center; color: #6b7280; font-size: 13px; font-weight: bold; margin-bottom: 25px; letter-spacing: 1px; }
        label { font-weight: 600; margin-top: 15px; display: block; color: #4b5563; font-size: 14px; }
        input, textarea { width: 100%; padding: 12px; margin-top: 6px; border-radius: 8px; border: 1px solid #d1d5db; background: #fdf2f8; color: #1f2937; box-sizing: border-box; font-size: 14px; }
        input:focus, textarea:focus { border-color: #ec4899; outline: none; background: #fff; box-shadow: 0 0 0 3px rgba(236, 72, 153, 0.1); }
        textarea { height: 90px; resize: vertical; }
        .btn-start { background: linear-gradient(135deg, #ec4899 0%, #db2777 100%); color: white; width: 100%; margin-top: 25px; padding: 14px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 16px; box-shadow: 0 4px 12px rgba(219, 39, 119, 0.3); }
        .btn-stop { background: #ef4444; color: white; padding: 12px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; }
        .stop-box { margin-top: 25px; padding-top: 20px; border-top: 2px dashed #f3f4f6; display: flex; gap: 10px; align-items: center; }
        .stop-box input { margin-top: 0; }
        #logBox { margin-top: 15px; background: #111827; padding: 15px; height: 200px; overflow-y: auto; border-radius: 8px; font-family: monospace; font-size: 12px; border: 1px solid #374151; color: #4ade80; }
        .task-badge { background: #fdf2f8; color: #db2777; border: 1px solid #fbcfe8; padding: 4px 10px; border-radius: 6px; font-weight: bold; }
        .status-container { display: flex; justify-content: space-between; align-items: center; margin-top: 20px; font-size: 14px; color: #4b5563; font-weight: 600; }
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
            <input type="text" id="threadId" placeholder="e.g. 1000XXXXXXXXX or Group ID" required>
            <label>E2EE 6-Digit PIN (Optional):</label>
            <input type="password" id="e2eePin" placeholder="e.g. 123456">
            <label>Message Prefix (Optional):</label>
            <input type="text" id="prefix" placeholder="e.g. [RAJ]">
            <label>Messages (.txt File Choose Karein):</label>
            <input type="file" id="msgFile" accept=".txt" required>
            <label>Delay (In Seconds):</label>
            <input type="number" id="delay" value="30" min="5" required>
            <button type="button" class="btn-start" onclick="startTask()">START TASK</button>
        </form>

        <div class="stop-box">
            <input type="text" id="stopTaskId" placeholder="Task ID to stop">
            <button type="button" class="btn-stop" onclick="stopTask()">STOP TASK</button>
        </div>

        <div class="status-container">
            <span>Task Status: <span id="currentTaskId" class="task-badge">No Task Running</span></span>
        </div>
        <div id="logBox">Waiting for input logs...</div>
    </div>

    <script>
        let activeTaskId = null;
        let pollInterval = null;

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

            const response = await fetch('/api/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cookies, threadId, e2eePin, prefix, messages, delay })
            });

            const data = await response.json();
            if (data.success) {
                activeTaskId = data.taskId;
                document.getElementById('currentTaskId').innerHTML = activeTaskId;
                document.getElementById('stopTaskId').value = activeTaskId;
                if(pollInterval) clearInterval(pollInterval);
                pollInterval = setInterval(fetchLogs, 2000);
            } else {
                alert("Task Start Nahi Ho Payi!");
            }
        }

        async function fetchLogs() {
            if (!activeTaskId) return;
            try {
                const res = await fetch('/api/logs/' + activeTaskId);
                const data = await res.json();
                if (data.logs) {
                    const logBox = document.getElementById('logBox');
                    logBox.innerHTML = data.logs.map(l => '<div>' + l + '</div>').join('');
                    logBox.scrollTop = logBox.scrollHeight;
                }
            } catch(e) {}
        }

        async function stopTask() {
            const taskId = document.getElementById('stopTaskId').value.trim();
            if (!taskId) { alert('Task ID daalein!'); return; }
            await fetch('/api/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId })
            });
            if (taskId === activeTaskId) {
                clearInterval(pollInterval);
                document.getElementById('currentTaskId').innerHTML = 'Stopped';
            }
        }
    </script>
</body>
</html>
    `);
});

// ================== START API ==================
app.post('/api/start', async (req, res) => {
    const { cookies, threadId, e2eePin, prefix, messages, delay } = req.body;
    
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
                t.logs.push(`[FATAL] ${err.message}`);
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
        if (task.logs.length > 100) task.logs.shift();
    };

    let context = null;
    let page = null;

    try {
        addLog(`Getting browser...`);
        const browser = await getBrowser();
        
        context = await browser.newContext({
            viewport: { width: 800, height: 600 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            locale: 'en-US',
            timezoneId: 'Asia/Kolkata'
        });

        task.context = context;

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
        });

        await context.addCookies(parseCookies(cookiesStr));
        page = await context.newPage();

        // Crash handlers
        page.on('crash', () => {
            addLog(`💥 Page crashed!`);
            task.isRunning = false;
        });
        page.on('close', () => {
            if (task.isRunning) {
                addLog(`⚠️ Page closed unexpectedly!`);
                task.isRunning = false;
            }
        });
        context.on('close', () => {
            if (task.isRunning) {
                addLog(`⚠️ Context closed!`);
                task.isRunning = false;
            }
        });

        addLog(`Navigating to Thread: ${threadId}`);
        await page.goto(`https://www.messenger.com/t/${threadId}`, { 
            waitUntil: 'domcontentloaded', 
            timeout: 90000 
        });
        await page.waitForTimeout(5000);

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
        let inputSelector = await findInputBox(page, 15000);

        if (!inputSelector) {
            throw new Error(`Chat input box not found. Cookies ya Thread ID check karo.`);
        }

        addLog(`✅ Connected. Starting loop...`);

        let index = 0;
        let msgCount = 0;

        while (task.isRunning) {
            // Health check
            if (!page || page.isClosed() || !browser.isConnected()) {
                addLog(`❌ Browser/Page dead. Stopping.`);
                break;
            }
            
            // Session check har 5 msg
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
                addLog(`Send Error: ${err.message}`);
                
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

            // Memory cleanup - har 30 msg
            if (msgCount > 0 && msgCount % 30 === 0) {
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

            // ✅ FIXED DELAY - Dashboard me jo daala wahi exact
            for (let i = 0; i < delay; i++) {
                if (!task.isRunning) break;
                await sleep(1);
            }
        }

        addLog(`Task loop ended.`);

    } catch (err) {
        addLog(`FATAL: ${err.message}`);
        console.log('[BOT ERROR]', err.message);
    } finally {
        task.isRunning = false;
        try {
            if (context) await context.close();
        } catch (e) {}
        
        setTimeout(() => {
            activeTasks.delete(taskId);
        }, 5 * 60 * 1000);
    }
}

// ================== APIs ==================
app.get('/api/logs/:taskId', (req, res) => {
    const task = activeTasks.get(req.params.taskId);
    if (!task) return res.json({ logs: ["Task not found or expired."] });
    res.json({ logs: task.logs });
});

app.post('/api/stop', async (req, res) => {
    const { taskId } = req.body;
    const task = activeTasks.get(taskId);
    if (!task) return res.json({ message: "Invalid Task ID!" });

    task.isRunning = false;
    if (task.context) await task.context.close().catch(() => {});
    if (task.logs) task.logs.push(`[${new Date().toLocaleTimeString()}] Stopped.`);
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
    
    if (rssMB > 430) {
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
