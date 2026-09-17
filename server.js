const express = require('express');
const http = require('http');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Active Tasks Store
const activeTasks = new Map();

// Delay Helper
const sleep = (sec) => new Promise((resolve) => setTimeout(resolve, sec * 1000));

// Memory & RAM Cleaner (Prevents Server Out-of-Memory Crashes)
setInterval(() => {
    if (global.gc) {
        try { global.gc(); } catch (e) {}
    }
}, 5 * 60 * 1000); // Every 5 minutes

// Cookie Parser Helper
function parseCookies(cookieStr) {
    return cookieStr.split(';').map(pair => {
        const [name, ...rest] = pair.trim().split('=');
        if (!name || rest.length === 0) return null;
        return {
            name: name.trim(),
            value: rest.join('=').trim(),
            domain: '.messenger.com',
            path: '/',
            httpOnly: false,
            secure: true,
            sameSite: 'Lax'
        };
    }).filter(Boolean);
}

// ---------------- DASHBOARD UI (PINK + WHITE THEME) ----------------
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
        input, textarea { width: 100%; padding: 12px; margin-top: 6px; border-radius: 8px; border: 1px solid #d1d5db; background: #fdf2f8; color: #1f2937; box-sizing: border-box; font-size: 14px; transition: all 0.3s; }
        input:focus, textarea:focus { border-color: #ec4899; outline: none; background: #fff; box-shadow: 0 0 0 3px rgba(236, 72, 153, 0.1); }
        textarea { height: 90px; resize: vertical; }
        .btn-start { background: linear-gradient(135deg, #ec4899 0%, #db2777 100%); color: white; width: 100%; margin-top: 25px; padding: 14px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 16px; box-shadow: 0 4px 12px rgba(219, 39, 119, 0.3); transition: 0.2s; }
        .btn-start:hover { opacity: 0.95; transform: translateY(-1px); }
        .btn-stop { background: #ef4444; color: white; padding: 12px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.2s; }
        .btn-stop:hover { background: #dc2626; }
        .stop-box { margin-top: 25px; padding-top: 20px; border-top: 2px dashed #f3f4f6; display: flex; gap: 10px; align-items: center; }
        .stop-box input { margin-top: 0; }
        #logBox { margin-top: 15px; background: #111827; padding: 15px; height: 200px; overflow-y: auto; border-radius: 8px; font-family: monospace; font-size: 12px; border: 1px solid #374151; color: #4ade80; box-shadow: inset 0 2px 4px rgba(0,0,0,0.5); }
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
            <input type="text" id="stopTaskId" placeholder="Task ID to stop (e.g. TASK-123456)">
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

        function log(msg) {
            const logBox = document.getElementById('logBox');
            logBox.innerHTML += '<div>[' + new Date().toLocaleTimeString() + '] ' + msg + '</div>';
            logBox.scrollTop = logBox.scrollHeight;
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

            const file = fileInput.files[0];
            const text = await file.text();
            const messages = text.split('\\n').map(m => m.trim()).filter(m => m.length > 0);

            if (messages.length === 0) {
                alert('Message File khali hai!');
                return;
            }

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
            const res = await fetch('/api/logs/' + activeTaskId);
            const data = await res.json();
            if (data.logs) {
                const logBox = document.getElementById('logBox');
                logBox.innerHTML = data.logs.map(l => '<div>' + l + '</div>').join('');
                logBox.scrollTop = logBox.scrollHeight;
            }
        }

        async function stopTask() {
            const taskId = document.getElementById('stopTaskId').value.trim();
            if (!taskId) {
                alert('Task ID daalein!');
                return;
            }

            const response = await fetch('/api/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId })
            });

            const data = await response.json();
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

// ---------------- BACKEND LOGIC ----------------

app.post('/api/start', async (req, res) => {
    const { cookies, threadId, e2eePin, prefix, messages, delay } = req.body;
    
    const taskId = "TASK-" + Math.floor(100000 + Math.random() * 900000);

    const taskData = {
        taskId,
        isRunning: true,
        logs: [`[${new Date().toLocaleTimeString()}] Task Initialized. ID: ${taskId}`],
        browser: null,
        context: null
    };

    activeTasks.set(taskId, taskData);

    // Run asynchronously without blocking terminal
    runPlaywrightBot(taskId, cookies, threadId, e2eePin, prefix, messages, delay);

    res.json({ success: true, taskId });
});

async function runPlaywrightBot(taskId, cookiesStr, threadId, e2eePin, prefix, messages, delay) {
    const task = activeTasks.get(taskId);
    if (!task) return;

    // Helper to push logs ONLY to web dashboard (Terminal remains 100% clean)
    const addLog = (msg) => {
        if (!task.logs) task.logs = [];
        task.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
        if (task.logs.length > 150) task.logs.shift(); // Keep array size controlled
    };

    try {
        addLog(`Launching Browser Engine...`);
        
        const browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        });

        task.browser = browser;

        const context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        });

        task.context = context;

        const parsedCookies = parseCookies(cookiesStr);
        await context.addCookies(parsedCookies);

        const page = await context.newPage();

        addLog(`Navigating to Target Thread: ${threadId}`);
        await page.goto(`https://www.messenger.com/t/${threadId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // --- E2EE PIN AUTO-FILL CHECK ---
        if (e2eePin) {
            try {
                const pinSelector = 'input[type="password"], input[aria-label*="PIN"], input[placeholder*="PIN"]';
                const pinInput = await page.waitForSelector(pinSelector, { timeout: 8000 }).catch(() => null);
                
                if (pinInput) {
                    addLog(`E2EE PIN Prompt detected. Entering PIN...`);
                    await pinInput.click();
                    await pinInput.fill(e2eePin);
                    await page.keyboard.press('Enter');

                    const submitBtn = await page.$('button[type="submit"], div[role="button"]:has-text("Continue"), div[role="button"]:has-text("Submit")').catch(() => null);
                    if (submitBtn) await submitBtn.click();

                    addLog(`PIN submitted. Waiting for chat unlock...`);
                    await page.waitForTimeout(6000);
                }
            } catch (pErr) {
                addLog(`PIN Handling Warning: ${pErr.message}`);
            }
        }

        // --- CHAT INPUT SELECTOR CHECK ---
        const possibleSelectors = [
            'div[role="textbox"][contenteditable="true"]',
            'div[contenteditable="true"][aria-label*="Message"]',
            'div[contenteditable="true"]',
            'div[aria-label="Message"]',
            'div[role="textbox"]'
        ];

        let inputSelector = null;
        addLog(`Searching for chat input box...`);

        for (const selector of possibleSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 6000 });
                inputSelector = selector;
                break;
            } catch (e) {}
        }

        if (!inputSelector) {
            throw new Error(`Chat input box not found. Check cookies or target ID.`);
        }

        addLog(`Connected to Chat successfully. Starting continuous infinite loop...`);

        let index = 0;

        // --- CONTROLLED INFINITE LOOP (Runs until manually stopped or cookies expire) ---
        while (task.isRunning) {
            const rawMsg = messages[index];
            const finalPayload = (prefix ? prefix + " " : "") + rawMsg;

            try {
                // Direct Native Insert Command (0% Typing Indicator + 100% Real Delivery via React/Lexical Sync)
                await page.evaluate(({ selector, text }) => {
                    const el = document.querySelector(selector);
                    if (el) {
                        el.focus();
                        document.execCommand('selectAll', false, null);
                        document.execCommand('delete', false, null);
                        document.execCommand('insertText', false, text);
                    }
                }, { selector: inputSelector, text: finalPayload });

                await page.waitForTimeout(200);
                await page.keyboard.press('Enter');

                addLog(`Message Sent: "${finalPayload}"`);
            } catch (err) {
                addLog(`Send Error: ${err.message}`);
            }

            index = (index + 1) % messages.length;

            for (let i = 0; i < delay; i++) {
                if (!task.isRunning) break;
                await sleep(1);
            }
        }

        addLog(`Task Loop Terminated.`);

    } catch (err) {
        addLog(`FATAL ERROR: ${err.message}`);
    } finally {
        if (task.browser) {
            await task.browser.close().catch(() => {});
        }
        task.isRunning = false;
    }
}

app.get('/api/logs/:taskId', (req, res) => {
    const task = activeTasks.get(req.params.taskId);
    if (!task) return res.json({ logs: ["Task not found or expired."] });
    res.json({ logs: task.logs });
});

app.post('/api/stop', async (req, res) => {
    const { taskId } = req.body;
    const task = activeTasks.get(taskId);

    if (!task) {
        return res.json({ message: "Invalid Task ID!" });
    }

    task.isRunning = false;
    if (task.browser) {
        await task.browser.close().catch(() => {});
    }

    if (task.logs) {
        task.logs.push(`[${new Date().toLocaleTimeString()}] Stop signal received. Task terminated.`);
    }
    res.json({ message: `Task ${taskId} is stopped!` });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    // Terminal stays 100% clean as requested
});
