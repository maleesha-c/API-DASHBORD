const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
// yt-dlp-exec exports the callable itself (returns parsed JSON with dumpSingleJson)
const youtubedl = require('yt-dlp-exec');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SITE = 'https://cinesubz.lk';
const CREATOR = 'MALIYA CINE HUB';
const MASTER_ID = 'master_id_1';

// Default Daily Request Limit per API Key
const DAILY_LIMIT = 200;

const KEYS_FILE = './keys.json';
const MASTER_KEY_VALUE = process.env.MASTER_KEY || "maleesha_api_d31808a77ee8c98c7ad9dc1adfec4e9e";

// Google Sign-In (for users to get their own API key)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "463389444910-35gb9ucjj5d89gf12j55g0hd6hbvtf7f.apps.googleusercontent.com";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// =======================================================
// HELPERS
// =======================================================

const cleanTitle = (text) => (text ? text.replace(/\s+/g, ' ').trim() : '');

const absUrl = (href, base) => {
    if (!href) return null;
    try { return new URL(href, base).href; } catch { return null; }
};

const CONTENT_PATH = /^\/(movies|tvshows|episodes|series)\/[^/]+\/?$/i;

function isContentLink(link) {
    try {
        const u = new URL(link);
        if (u.hostname !== 'cinesubz.lk' && u.hostname !== 'www.cinesubz.lk') return false;
        return CONTENT_PATH.test(u.pathname);
    } catch {
        return false;
    }
}

async function resolveZtPage(ztUrl) {
    const { data } = await axios.get(ztUrl, {
        headers: { 'User-Agent': UA, 'Referer': `${SITE}/` },
        timeout: 15000
    });
    const html = typeof data === 'string' ? data : JSON.stringify(data);
    const $ = cheerio.load(html);
    const title = cleanTitle($('title').text() || $('h1').first().text());

    let href = $('#link').attr('href');
    if (!href) return { link: null, title };

    const mapRe = /search\s*:\s*\[([^\]]*)\]\s*,\s*replace\s*:\s*(["'])(.*?)\2/g;
    let m;
    let mapped = false;
    while (!mapped && (m = mapRe.exec(html))) {
        const searches = [...m[1].matchAll(/(["'])(.*?)\1/g)].map(x => x[2]);
        for (const s of searches) {
            if (s && href.startsWith(s)) {
                href = m[3] + href.slice(s.length);
                mapped = true;
                break;
            }
        }
    }

    if (!mapped) console.warn(`[CineSubz] no urlMapping matched for ${href}`);
    return { link: href, title };
}

async function resolveZtLink(ztUrl) {
    return (await resolveZtPage(ztUrl)).link;
}

// ---- TMDB image helpers (poster w780, cast w185, gallery original) ----
const TMDB_RE = /\/t\/p\/(?:w\d+|h\d+|original)\//;
const tmdbSize = (url, size) => (url && TMDB_RE.test(url) ? url.replace(TMDB_RE, `/t/p/${size}/`) : url);

const imgSrc = ($el) => {
    const s = $el.attr('data-src') || $el.attr('data-lazy-src') || $el.attr('data-original') || $el.attr('src') || '';
    return s.startsWith('data:') ? '' : s;
};

// Finds a value by its label, e.g. "Country : USA"
function metaByLabel($, labels) {
    const group = labels.join('|');
    const exact = new RegExp(`^(${group})$`, 'i');
    const inline = new RegExp(`^\\s*(?:${group})\\s*:?\\s*(.+)$`, 'i');
    let out = '';

    // Dooplay style custom fields (label + value)
    $('.custom_fields').each((_, el) => {
        if (out) return;
        const label = $(el).find('.variante').text().trim();
        if (exact.test(label)) out = $(el).find('.valor').text().replace(/\s+/g, ' ').trim();
    });
    if (out) return out;

    // Generic "Label: value" text
    $('li, p, span, div.meta').each((_, el) => {
        if (out) return;
        const t = $(el).text().replace(/\s+/g, ' ').trim();
        if (t.length > 200) return;
        const m = t.match(inline);
        if (m && m[1]) out = m[1].trim();
    });
    return out;
}

// "WEB-DL 480p [Telegram Bot] 800 MB" -> { quality, size, lang }
function parseDownloadMeta(raw) {
    const text = (raw || '').replace(/\s+/g, ' ').trim();
    const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*(MB|GB)/i);
    const size = sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}` : 'N/A';
    const langMatch = text.match(/\b(Sinhala|English|Tamil|Hindi|Korean|Japanese)\b/i);
    const lang = langMatch ? langMatch[1][0].toUpperCase() + langMatch[1].slice(1).toLowerCase() : 'English';
    const quality = text
        .replace(/(\d+(?:\.\d+)?)\s*(MB|GB)/i, '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s|•·\-–—]+|[\s|•·\-–—]+$/g, '')
        .trim();
    return { quality: quality || text || 'N/A', size, lang };
}

// =======================================================
// API KEYS
// =======================================================

const getKeys = () => {
    try {
        return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
};

const saveKeys = (keys) => fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));

// Make sure keys.json exists and its master key matches MASTER_KEY_VALUE
(function syncMasterKey() {
    const keys = getKeys();
    const master = keys.find(k => k.id === MASTER_ID);
    if (!master) {
        keys.unshift({
            id: MASTER_ID,
            name: "Maliya Master Key",
            key: MASTER_KEY_VALUE,
            requestCount: 0,
            lastReset: new Date().toDateString(),
            createdAt: new Date().toISOString()
        });
        saveKeys(keys);
    } else if (master.key !== MASTER_KEY_VALUE) {
        master.key = MASTER_KEY_VALUE;
        saveKeys(keys);
    }
})();

const verifyApiKey = (req, res, next) => {
    const rawKey = req.headers['x-api-key'] || req.query.apikey || req.query.api_key;

    console.log(`[API REQUEST] ${req.method} ${req.path}`);

    if (!rawKey) {
        return res.status(401).json({ status: false, creator: CREATOR, message: "API Key is missing!" });
    }

    const apiKey = String(rawKey).trim();
    const keys = getKeys();
    const found = keys.find(k => k.key.trim() === apiKey);

    if (!found) {
        console.warn(`[API WARN] Invalid API key attempt from ${req.ip}`);
        return res.status(403).json({ status: false, creator: CREATOR, message: "Invalid API key." });
    }

    const today = new Date().toDateString();
    if (found.lastReset !== today) {
        found.requestCount = 0;
        found.lastReset = today;
    }

    const keyLimit = found.dailyLimit || DAILY_LIMIT;
    if (found.id !== MASTER_ID && (found.requestCount || 0) >= keyLimit) {
        return res.status(429).json({
            status: false,
            creator: CREATOR,
            message: `Rate limit exceeded! Daily limit is ${keyLimit} requests.`
        });
    }

    found.requestCount = (found.requestCount || 0) + 1;
    saveKeys(keys);

    next();
};

const verifyMaster = (req, res, next) => {
    const rawKey = req.headers['x-api-key'] || req.query.apikey || req.query.api_key;
    if (!rawKey) {
        return res.status(401).json({ status: false, message: "Enter the admin key first!" });
    }
    const apiKey = String(rawKey).trim();
    const found = getKeys().find(k => k.key.trim() === apiKey);
    if (!found || found.id !== MASTER_ID) {
        return res.status(403).json({ status: false, message: "Only the master key can do this." });
    }
    next();
};

app.use((req, res, next) => {
    console.log(`[INCOMING] ${req.method} ${req.url.split('?')[0]}`);
    next();
});

// Server status (JSON) - moved from "/" so the landing page can use it
app.get('/status', (req, res) => {
    res.json({
        status: true,
        creator: CREATOR,
        message: "MALIYA API HUB IS RUNNING!",
        dashboard: "Visit /dashboard to manage API keys"
    });
});

// =======================================================
// LANDING / LOGIN PAGE  (/ and /home)
// =======================================================

app.get(['/', '/home'], (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="si">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maliya Cine Hub - Login</title>
    <script src="https://accounts.google.com/gsi/client" async defer></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        body { background-color: #09090e; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
        .login-card { background: #12121c; border: 1px solid #1f1f33; border-radius: 20px; padding: 40px 30px; text-align: center; max-width: 420px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .logo { width: 100px; height: 100px; border-radius: 20px; margin-bottom: 20px; border: 2px solid #6c5ce7; box-shadow: 0 0 20px rgba(108, 92, 231, 0.4); }
        h1 { font-size: 26px; font-weight: 700; margin-bottom: 10px; color: #ffffff; }
        .subtitle { font-size: 11px; color: #00cec9; letter-spacing: 2px; margin-bottom: 25px; text-transform: uppercase; }
        .desc { font-size: 13px; color: #a0a0b0; line-height: 1.6; margin-bottom: 30px; }
        .google-btn-container { display: flex; justify-content: center; margin-bottom: 25px; }
        .footer-links { font-size: 12px; color: #6c5ce7; text-decoration: none; margin: 0 10px; }
        .copyright { font-size: 11px; color: #505060; margin-top: 25px; }
        #loginMsg { color: #ff7675; font-size: 12px; margin-bottom: 15px; min-height: 14px; }
    </style>
</head>
<body>
    <div class="login-card">
        <img src="https://i.ibb.co/L51qRTL/cinehub.jpg" alt="Logo" class="logo" onerror="this.src='https://via.placeholder.com/100/6c5ce7/fff?text=MALIYA'">
        <h1>Maliya Cine Hub</h1>
        <div class="subtitle">SINHALA MOVIE SCRAPER & DETAILS API</div>
        <p class="desc">Sign in with your Google account to access developer API keys, sandbox playground, and movie request credits.</p>

        <div class="google-btn-container">
            <div id="g_id_onload"
                data-client_id="${GOOGLE_CLIENT_ID}"
                data-callback="handleCredentialResponse"
                data-auto_prompt="false">
            </div>
            <div class="g_id_signin"
                data-type="standard"
                data-size="large"
                data-theme="outline"
                data-text="continue_with"
                data-shape="pill"
                data-logo_alignment="left">
            </div>
        </div>

        <p id="loginMsg"></p>

        <div>
            <a href="#" class="footer-links">Privacy Policy</a> •
            <a href="#" class="footer-links">Terms of Service</a>
        </div>
        <div class="copyright">© 2026 Maliya Cine Hub. All rights reserved.</div>
    </div>

    <script>
        async function handleCredentialResponse(response) {
            var msg = document.getElementById('loginMsg');
            msg.textContent = '';
            try {
                var res = await fetch('/api/auth/google', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: response.credential })
                });
                var data = await res.json();
                if (data.success) {
                    localStorage.setItem('user', JSON.stringify(data.user));
                    window.location.href = '/dashboard';
                } else {
                    msg.textContent = data.message || 'Login failed!';
                }
            } catch (err) {
                msg.textContent = 'Error: ' + err.message;
            }
        }

        // Already logged in -> go straight to the dashboard
        if (localStorage.getItem('user')) {
            window.location.href = '/dashboard';
        }
    </script>
</body>
</html>`);
});

// =======================================================
// GOOGLE LOGIN (user gets a personal API key)
// =======================================================

app.post('/api/auth/google', async (req, res) => {
    try {
        const { token } = req.body || {};
        if (!token) {
            return res.status(400).json({ success: false, message: "Google token is required!" });
        }

        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: GOOGLE_CLIENT_ID
        });
        const { email, name, picture } = ticket.getPayload();
        if (!email) {
            return res.status(400).json({ success: false, message: "Google account has no email." });
        }

        const keys = getKeys();
        const today = new Date().toDateString();
        let user = keys.find(k => k.email === email);

        if (!user) {
            user = {
                id: `user_${Date.now()}`,
                name: name || email,
                email,
                picture: picture || '',
                key: `maliya_api_${crypto.randomBytes(12).toString('hex')}`,
                requestCount: 0,
                dailyLimit: DAILY_LIMIT,
                lastReset: today,
                createdAt: new Date().toISOString()
            };
            keys.push(user);
        } else {
            if (user.lastReset !== today) {
                user.requestCount = 0;
                user.lastReset = today;
            }
            if (picture) user.picture = picture;
        }
        saveKeys(keys);

        return res.json({
            success: true,
            user: {
                name: user.name,
                email: user.email,
                picture: user.picture,
                key: user.key,
                requestCount: user.requestCount || 0,
                dailyLimit: user.dailyLimit || DAILY_LIMIT
            }
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: "Google Auth Failed: " + error.message });
    }
});

// =======================================================
// DASHBOARD
// =======================================================

app.get('/dashboard', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MALIYA CINE HUB - Modern Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://accounts.google.com/gsi/client" async defer></script>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Plus Jakarta Sans', sans-serif; }
        .glass-card { background: rgba(17, 24, 39, 0.7); backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.08); }
        .glow-purple { box-shadow: 0 0 35px -5px rgba(168, 85, 247, 0.25); }
        .glow-pink { box-shadow: 0 0 35px -5px rgba(236, 72, 153, 0.25); }
        .text-gradient { background: linear-gradient(135deg, #a855f7 0%, #ec4899 50%, #f43f5e 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    </style>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen relative selection:bg-pink-500 selection:text-white">

    <!-- Background Decorative Elements -->
    <div class="fixed top-0 left-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl pointer-events-none"></div>
    <div class="fixed bottom-0 right-1/4 w-96 h-96 bg-pink-600/10 rounded-full blur-3xl pointer-events-none"></div>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 relative z-10">

        <!-- HEADER -->
        <header class="flex flex-col md:flex-row justify-between items-center mb-10 pb-6 border-b border-gray-800/80 gap-4">
            <div class="flex items-center gap-4">
                <div class="w-14 h-14 rounded-2xl bg-gradient-to-tr from-purple-600 to-pink-500 flex items-center justify-center text-3xl font-black shadow-lg shadow-purple-500/30">
                    🎬
                </div>
                <div>
                    <h1 class="text-3xl font-black tracking-wider text-gradient">
                        MALIYA CINE HUB
                    </h1>
                    <p class="text-xs text-gray-400 font-medium tracking-wide">Developer Control Panel & API Playground</p>
                </div>
            </div>

            <div class="flex items-center gap-3">
                <div class="px-4 py-2 rounded-xl bg-emerald-950/50 border border-emerald-500/30 text-emerald-400 text-xs font-semibold flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    API Server Online
                </div>
                <button onclick="logout()" class="px-4 py-2 rounded-xl bg-red-950/50 border border-red-500/30 text-red-400 hover:text-red-300 text-xs font-semibold transition-all">
                    Logout
                </button>
            </div>
        </header>

        <!-- DASHBOARD NAVIGATION TABS -->
        <div class="flex flex-wrap gap-3 mb-8 border-b border-gray-800/60 pb-4">
            <button onclick="switchTab('overview')" id="tab-overview" class="px-5 py-2.5 rounded-xl font-bold text-xs transition-all bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-lg">
                🏠 Overview
            </button>
            <button onclick="switchTab('keys')" id="tab-keys" class="px-5 py-2.5 rounded-xl font-bold text-xs transition-all bg-gray-900 text-gray-400 hover:text-white border border-gray-800">
                🔑 API Keys Management
            </button>
            <button onclick="switchTab('tester')" id="tab-tester" class="px-5 py-2.5 rounded-xl font-bold text-xs transition-all bg-gray-900 text-gray-400 hover:text-white border border-gray-800">
                ⚡ API Tester & Tester Studio
            </button>
            <button onclick="switchTab('playground')" id="tab-playground" class="px-5 py-2.5 rounded-xl font-bold text-xs transition-all bg-gray-900 text-gray-400 hover:text-white border border-gray-800">
                🖥️ DL Playground
            </button>
            <button onclick="switchTab('account')" id="tab-account" class="px-5 py-2.5 rounded-xl font-bold text-xs transition-all bg-gray-900 text-gray-400 hover:text-white border border-gray-800">
                👤 My API Key
            </button>
        </div>

        <!-- TAB 1: OVERVIEW (HOME PAGE) -->
        <div id="page-overview" class="space-y-8">
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <div class="glass-card rounded-2xl p-6 glow-purple">
                    <div class="flex justify-between items-start mb-4">
                        <span class="text-2xl">⚡</span>
                        <span class="text-[10px] bg-purple-500/20 text-purple-300 font-bold px-2 py-1 rounded-md">STATUS</span>
                    </div>
                    <h3 class="text-gray-400 text-xs font-semibold">Total Endpoints</h3>
                    <p class="text-2xl font-black text-white mt-1">12 Active APIs</p>
                </div>

                <div class="glass-card rounded-2xl p-6 glow-pink">
                    <div class="flex justify-between items-start mb-4">
                        <span class="text-2xl">🍿</span>
                        <span class="text-[10px] bg-pink-500/20 text-pink-300 font-bold px-2 py-1 rounded-md">CINEMA</span>
                    </div>
                    <h3 class="text-gray-400 text-xs font-semibold">Primary Scraper</h3>
                    <p class="text-2xl font-black text-white mt-1">CineSubz Engine v2</p>
                </div>

                <div class="glass-card rounded-2xl p-6">
                    <div class="flex justify-between items-start mb-4">
                        <span class="text-2xl">🛡️</span>
                        <span class="text-[10px] bg-emerald-500/20 text-emerald-300 font-bold px-2 py-1 rounded-md">SECURITY</span>
                    </div>
                    <h3 class="text-gray-400 text-xs font-semibold">Authentication</h3>
                    <p class="text-2xl font-black text-white mt-1">Master Key Active</p>
                </div>

                <div class="glass-card rounded-2xl p-6">
                    <div class="flex justify-between items-start mb-4">
                        <span class="text-2xl">📊</span>
                        <span class="text-[10px] bg-amber-500/20 text-amber-300 font-bold px-2 py-1 rounded-md">LIMIT</span>
                    </div>
                    <h3 class="text-gray-400 text-xs font-semibold">Daily Request Limit</h3>
                    <p class="text-2xl font-black text-white mt-1">${DAILY_LIMIT} / Key</p>
                </div>
            </div>

            <!-- MENU CARDS -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div onclick="switchTab('keys')" class="glass-card rounded-2xl p-8 hover:border-purple-500/50 cursor-pointer transition-all hover:-translate-y-1 group">
                    <div class="w-12 h-12 rounded-xl bg-purple-600/20 text-purple-400 flex items-center justify-center text-2xl mb-4 group-hover:scale-110 transition-transform">
                        🔑
                    </div>
                    <h3 class="text-xl font-bold text-white mb-2">API Keys & Management</h3>
                    <p class="text-xs text-gray-400 leading-relaxed">Create new API keys for your WhatsApp Bots, monitor daily usage quotas, and manage active master keys.</p>
                </div>

                <div onclick="switchTab('tester')" class="glass-card rounded-2xl p-8 hover:border-pink-500/50 cursor-pointer transition-all hover:-translate-y-1 group">
                    <div class="w-12 h-12 rounded-xl bg-pink-600/20 text-pink-400 flex items-center justify-center text-2xl mb-4 group-hover:scale-110 transition-transform">
                        🚀
                    </div>
                    <h3 class="text-xl font-bold text-white mb-2">CineSubz Response Tester</h3>
                    <p class="text-xs text-gray-400 leading-relaxed">Test CineSubz Search, InfoDL & Download responses directly in a large JSON viewer window with instant feedback.</p>
                </div>
            </div>
        </div>

        <!-- TAB 2: API KEYS -->
        <div id="page-keys" class="hidden space-y-8">
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <!-- CREATE KEY -->
                <div class="glass-card rounded-2xl p-6 glow-purple">
                    <h2 class="text-lg font-bold text-white mb-2 flex items-center gap-2">
                        <span>✨</span> Create New API Key
                    </h2>
                    <p class="text-xs text-gray-400 mb-6">Generate dedicated API access keys for your WhatsApp bots.</p>

                    <form id="createForm" class="space-y-4">
                        <div>
                            <label class="text-xs font-semibold text-gray-300 block mb-1">Key Owner / Bot Name</label>
                            <input type="text" id="keyName" placeholder="e.g. Maleesha V3 Bot" required maxlength="50"
                                class="w-full bg-gray-950 border border-gray-800 focus:border-purple-500 rounded-xl px-4 py-3 text-sm text-white focus:outline-none transition-all">
                        </div>
                        <button type="submit" class="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white font-bold py-3 rounded-xl transition-all shadow-lg active:scale-95 text-sm">
                            🚀 Generate Key
                        </button>
                    </form>

                    <div id="newKeyBox" class="hidden mt-5 p-4 bg-emerald-950/40 border border-emerald-500/50 rounded-xl text-emerald-400 text-xs break-all font-mono"></div>
                </div>

                <!-- ACTIVE KEYS TABLE -->
                <div class="lg:col-span-2 glass-card rounded-2xl p-6">
                    <div class="flex flex-col sm:flex-row justify-between sm:items-center mb-6 gap-3">
                        <div>
                            <h2 class="text-lg font-bold text-white flex items-center gap-2">
                                <span>🔐</span> Active API Keys
                            </h2>
                            <p class="text-xs text-gray-400">Admin control panel & quota status • Limit: ${DAILY_LIMIT} requests/day per key</p>
                        </div>
                    </div>

                    <div class="flex gap-2 mb-6">
                        <input type="password" id="adminKey" placeholder="Enter Master Key to Load Keys..."
                            class="bg-gray-950 border border-gray-800 focus:border-purple-500 rounded-xl px-4 py-2.5 text-sm text-white flex-grow focus:outline-none transition-all font-mono">
                        <button id="loadBtn" class="bg-purple-600 hover:bg-purple-500 text-white px-5 py-2.5 rounded-xl font-semibold text-sm transition-all active:scale-95">
                            Load
                        </button>
                    </div>

                    <p id="msg" class="text-red-400 text-xs mb-3 font-medium"></p>

                    <div class="overflow-x-auto rounded-xl border border-gray-800">
                        <table class="w-full text-left border-collapse">
                            <thead>
                                <tr class="bg-gray-950/80 text-gray-400 text-xs font-semibold uppercase tracking-wider border-b border-gray-800">
                                    <th class="p-3">Name</th>
                                    <th class="p-3">Key</th>
                                    <th class="p-3">Usage</th>
                                    <th class="p-3 text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody id="keysTable" class="divide-y divide-gray-800/50 text-xs">
                                <tr>
                                    <td colspan="4" class="p-6 text-center text-gray-500 font-medium">Enter Master Key above to view keys list.</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>

        <!-- TAB 3: API TESTER STUDIO -->
        <div id="page-tester" class="hidden space-y-6">
            <div class="glass-card rounded-2xl p-6 glow-pink">
                <h2 class="text-xl font-bold text-white mb-2 flex items-center gap-2">
                    <span>⚡</span> CineSubz API Response Studio
                </h2>
                <p class="text-xs text-gray-400 mb-6">Select endpoint, enter your query or movie URL, and test the full JSON response in real-time.</p>

                <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                    <div>
                        <label class="block text-xs font-semibold text-gray-300 mb-1">API KEY</label>
                        <input type="text" id="testApiKey" placeholder="Enter your API Key" class="w-full bg-gray-950 border border-gray-800 rounded-xl p-3 text-xs text-white font-mono focus:border-purple-500 focus:outline-none">
                    </div>

                    <div class="md:col-span-2">
                        <label class="block text-xs font-semibold text-gray-300 mb-1">QUERY OR MOVIE URL</label>
                        <input type="text" id="testQuery" value="GOAT" placeholder="e.g. GOAT or https://cinesubz.lk/movies/..." class="w-full bg-gray-950 border border-gray-800 rounded-xl p-3 text-xs text-white font-mono focus:border-purple-500 focus:outline-none">
                    </div>
                </div>

                <!-- SEPARATE TEST BUTTONS FOR CINESUBZ -->
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                    <button onclick="runCineSubzSearch()" class="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold py-3 px-4 rounded-xl transition-all shadow-lg active:scale-95 text-xs flex items-center justify-center gap-2">
                        🔍 CineSubz Search Response
                    </button>
                    <button onclick="runCineSubzInfoDL()" class="bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-500 hover:to-rose-500 text-white font-bold py-3 px-4 rounded-xl transition-all shadow-lg active:scale-95 text-xs flex items-center justify-center gap-2">
                        🎬 CineSubz InfoDL Response
                    </button>
                    <button onclick="runCineSubzDL()" class="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold py-3 px-4 rounded-xl transition-all shadow-lg active:scale-95 text-xs flex items-center justify-center gap-2">
                        📥 CineSubz Download (DL)
                    </button>
                </div>

                <!-- EXTRA LARGE RESPONSE VIEWER -->
                <div>
                    <div class="flex justify-between items-center mb-2">
                        <label class="text-xs font-semibold text-gray-400">RESPONSE JSON OUTPUT</label>
                        <span id="responseStatus" class="text-xs font-bold text-gray-500">Idle</span>
                    </div>
                    <pre id="responseBox" class="w-full h-[550px] bg-gray-950 border border-gray-800 rounded-2xl p-5 text-emerald-400 font-mono text-xs overflow-auto leading-relaxed shadow-inner">Click "CineSubz Search", "CineSubz InfoDL" or "CineSubz Download" above to view response...</pre>
                </div>
            </div>
        </div>

        <!-- TAB 4: TERMINAL PLAYGROUND (Cinesubz Download) -->
        <div id="page-playground" class="hidden space-y-8">
            <div class="glass-card rounded-2xl p-6 max-w-3xl mx-auto border border-gray-800/80 shadow-2xl">
                <!-- Terminal Title Bar -->
                <div class="flex justify-between items-center pb-4 border-b border-gray-800 mb-6">
                    <div class="flex items-center gap-2">
                        <span class="w-3 h-3 bg-red-500 rounded-full inline-block"></span>
                        <span class="w-3 h-3 bg-yellow-500 rounded-full inline-block"></span>
                        <span class="w-3 h-3 bg-green-500 rounded-full inline-block"></span>
                        <span class="text-xs text-gray-400 font-mono ml-2">Terminal — Cinesubz Download</span>
                    </div>
                </div>

                <h2 class="text-xl font-bold text-white mb-1">Cinesubz Download</h2>
                <div class="flex items-center gap-2 text-xs font-mono text-purple-400 mb-6">
                    <span class="bg-purple-950/80 border border-purple-500/40 px-2 py-0.5 rounded text-purple-300 font-bold">GET</span>
                    <span>/api/movie/cinesubz/dl</span>
                </div>

                <div class="space-y-4 text-xs font-mono">
                    <div>
                        <label class="block text-gray-400 mb-1 font-sans">FULL API URL</label>
                        <input type="text" id="dlFullUrl" readonly class="w-full bg-gray-950 border border-gray-800 rounded-xl p-3 text-purple-300 font-mono text-[11px]">
                    </div>

                    <div>
                        <label class="block text-gray-400 mb-1 font-sans">PARAMETERS (url *)</label>
                        <input type="text" id="dlParamUrl" value="https://cinesubz.lk/zt-links/9p5dymh0kr/" oninput="updateDlUrl()" class="w-full bg-gray-950 border border-gray-800 rounded-xl p-3 text-white">
                    </div>

                    <div>
                        <label class="block text-gray-400 mb-1 font-sans">API KEY</label>
                        <input type="text" id="dlApiKey" placeholder="Enter API Key" oninput="updateDlUrl()" class="w-full bg-gray-950 border border-gray-800 rounded-xl p-3 text-white">
                    </div>

                    <div class="flex gap-3 pt-2">
                        <button onclick="runDlApi()" class="bg-white text-black hover:bg-gray-200 font-bold px-6 py-2.5 rounded-xl flex items-center gap-2 text-xs transition active:scale-95">
                            ▶ Run
                        </button>
                        <button onclick="copyDlUrl()" class="bg-gray-900 border border-gray-800 hover:bg-gray-800 text-gray-300 font-semibold px-4 py-2.5 rounded-xl text-xs transition active:scale-95">
                            Copy URL
                        </button>
                    </div>

                    <div class="pt-4">
                        <div class="flex justify-between items-center mb-2">
                            <label class="block text-gray-400 font-sans">RESPONSE JSON</label>
                            <span id="dlStatus" class="text-gray-500 font-bold">Idle</span>
                        </div>
                        <pre id="dlResponseBox" class="w-full h-80 bg-gray-950 border border-gray-800 rounded-xl p-4 text-emerald-400 font-mono text-xs overflow-auto">Click "Run" button to test response...</pre>
                    </div>
                </div>
            </div>
        </div>

        <!-- TAB 5: MY API KEY (Google Login) -->
        <div id="page-account" class="hidden space-y-8">
            <div class="glass-card rounded-2xl p-6 max-w-xl mx-auto glow-purple">
                <div id="login-card" class="text-center">
                    <h2 class="text-lg font-bold text-white mb-2">Login to Get Your API Key</h2>
                    <p class="text-xs text-gray-400 mb-6">Sign in with Google to automatically get your personal API key (${DAILY_LIMIT} requests/day).</p>
                    <div class="flex justify-center"><div id="googleBtn"></div></div>
                    <p id="accMsg" class="text-red-400 text-xs mt-4 font-medium"></p>
                </div>

                <div id="user-card" class="hidden space-y-4">
                    <div class="flex items-center gap-4 border-b border-gray-800 pb-4">
                        <img id="user-img" class="w-12 h-12 rounded-full border border-purple-400" src="" alt="Profile">
                        <div>
                            <h2 id="user-name" class="text-lg font-bold text-purple-300"></h2>
                            <p id="user-email" class="text-gray-400 text-xs"></p>
                        </div>
                    </div>

                    <div class="space-y-2">
                        <label class="text-xs text-gray-400">YOUR PERSONAL API KEY</label>
                        <div class="flex items-center gap-2 bg-gray-950 p-3 rounded-xl border border-gray-800">
                            <input id="api-key-input" readonly type="text" class="bg-transparent text-emerald-300 font-mono text-xs w-full outline-none">
                            <button onclick="copyAccKey()" class="bg-purple-600 hover:bg-purple-500 text-white text-xs px-3 py-1.5 rounded-lg transition">Copy</button>
                        </div>
                    </div>

                    <div class="grid grid-cols-2 gap-4 pt-2">
                        <div class="bg-gray-950 p-3 rounded-xl border border-gray-800">
                            <p class="text-xs text-gray-500">DAILY LIMIT</p>
                            <p id="daily-limit" class="text-lg font-bold text-gray-200">${DAILY_LIMIT}</p>
                        </div>
                        <div class="bg-gray-950 p-3 rounded-xl border border-gray-800">
                            <p class="text-xs text-gray-500">USED TODAY</p>
                            <p id="used-count" class="text-lg font-bold text-emerald-400">0</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>

    </div>

    <script>
        // ---- Login guard (user is saved by the /home login page) ----
        var savedUser = null;
        try { savedUser = JSON.parse(localStorage.getItem('user') || 'null'); } catch (e) { savedUser = null; }
        if (!savedUser) { window.location.href = '/home'; }

        function logout() {
            localStorage.removeItem('user');
            sessionStorage.removeItem('adminKey');
            window.location.href = '/home';
        }

        function showUser(u) {
            document.getElementById('login-card').classList.add('hidden');
            document.getElementById('user-card').classList.remove('hidden');
            document.getElementById('user-name').textContent = u.name || '';
            document.getElementById('user-email').textContent = u.email || '';
            document.getElementById('user-img').src = u.picture || '';
            document.getElementById('api-key-input').value = u.key || '';
            document.getElementById('daily-limit').textContent = u.dailyLimit || ${DAILY_LIMIT};
            document.getElementById('used-count').textContent = u.requestCount || 0;
        }

        var LIMIT = ${DAILY_LIMIT};
        var MASTER = '${MASTER_ID}';
        var adminInput = document.getElementById('adminKey');
        adminInput.value = sessionStorage.getItem('adminKey') || '';

        function authHeaders() { return { 'x-api-key': adminInput.value.trim() }; }

        var TABS = ['overview', 'keys', 'tester', 'playground', 'account'];
        var TAB_OFF = "px-5 py-2.5 rounded-xl font-bold text-xs transition-all bg-gray-900 text-gray-400 hover:text-white border border-gray-800";
        var TAB_ON = "px-5 py-2.5 rounded-xl font-bold text-xs transition-all bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-lg";

        function switchTab(tab) {
            TABS.forEach(function (t) {
                document.getElementById('page-' + t).classList.add('hidden');
                document.getElementById('tab-' + t).className = TAB_OFF;
            });
            document.getElementById('page-' + tab).classList.remove('hidden');
            document.getElementById('tab-' + tab).className = TAB_ON;
            if (tab === 'account') initGoogle();
        }

        // ---- Google login ----
        var googleReady = false;
        function initGoogle() {
            if (googleReady) return;
            if (!window.google || !google.accounts) { setTimeout(initGoogle, 300); return; }
            google.accounts.id.initialize({ client_id: '${GOOGLE_CLIENT_ID}', callback: handleCredentialResponse });
            google.accounts.id.renderButton(document.getElementById('googleBtn'), { type: 'standard', theme: 'filled_black', size: 'large' });
            googleReady = true;
        }

        function handleCredentialResponse(response) {
            var msg = document.getElementById('accMsg');
            msg.textContent = '';
            fetch('/api/auth/google', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: response.credential })
            })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data.success) { msg.textContent = data.message || 'Login failed'; return; }
                localStorage.setItem('user', JSON.stringify(data.user));
                showUser(data.user);
            })
            .catch(function (err) { msg.textContent = 'Error: ' + err.message; });
        }

        function copyAccKey() {
            navigator.clipboard.writeText(document.getElementById('api-key-input').value);
            alert("API Key Copied!");
        }

        function cell(text, cls) {
            var td = document.createElement('td');
            td.className = 'p-3 ' + (cls || '');
            td.textContent = text;
            return td;
        }

        async function loadKeys() {
            var msg = document.getElementById('msg');
            var tbody = document.getElementById('keysTable');
            msg.textContent = '';

            if (!adminInput.value.trim()) return;

            var res = await fetch('/v1/api-keys', { headers: authHeaders() });
            if (!res.ok) {
                var err = await res.json().catch(function () { return {}; });
                msg.textContent = err.message || 'Failed to load keys';
                return;
            }
            sessionStorage.setItem('adminKey', adminInput.value.trim());

            var keys = await res.json();
            tbody.innerHTML = '';
            keys.forEach(function (k) {
                var tr = document.createElement('tr');
                tr.className = 'hover:bg-gray-800/30 transition-all';
                tr.appendChild(cell(k.name + (k.email ? ' (' + k.email + ')' : ''), 'font-semibold text-gray-200'));
                tr.appendChild(cell(k.key, 'font-mono text-purple-300 break-all'));

                var usage = k.id === MASTER
                    ? (k.requestCount || 0) + ' / Unlimited'
                    : (k.requestCount || 0) + ' / ' + (k.dailyLimit || LIMIT);
                tr.appendChild(cell(usage, 'text-gray-300'));

                var td = document.createElement('td');
                td.className = 'p-3 text-right';
                if (k.id !== MASTER) {
                    var b = document.createElement('button');
                    b.textContent = 'Delete';
                    b.className = 'text-red-400 hover:text-red-300 font-semibold';
                    b.onclick = function () { deleteKey(k.id); };
                    td.appendChild(b);
                }
                tr.appendChild(td);
                tbody.appendChild(tr);
            });
        }

        async function runCineSubzSearch() {
            var apiKey = document.getElementById('testApiKey').value.trim();
            var q = document.getElementById('testQuery').value.trim();
            var box = document.getElementById('responseBox');
            var status = document.getElementById('responseStatus');

            if (!apiKey) { alert("Please enter API Key!"); return; }
            box.textContent = "Fetching CineSubz Search response...";
            status.textContent = "Loading...";

            try {
                var url = "/api/v1/movie/cinesubz/search?q=" + encodeURIComponent(q) + "&apikey=" + encodeURIComponent(apiKey);
                var res = await fetch(url);
                var data = await res.json();
                box.textContent = JSON.stringify(data, null, 2);
                status.textContent = "200 OK";
            } catch (err) {
                box.textContent = "Error: " + err.message;
                status.textContent = "Error";
            }
        }

        async function runCineSubzInfoDL() {
            var apiKey = document.getElementById('testApiKey').value.trim();
            var q = document.getElementById('testQuery').value.trim();
            var box = document.getElementById('responseBox');
            var status = document.getElementById('responseStatus');

            if (!apiKey) { alert("Please enter API Key!"); return; }
            box.textContent = "Fetching CineSubz InfoDL response...";
            status.textContent = "Loading...";

            try {
                var url = "/api/v1/movie/cinesubz/infodl?q=" + encodeURIComponent(q) + "&apikey=" + encodeURIComponent(apiKey);
                var res = await fetch(url);
                var data = await res.json();
                box.textContent = JSON.stringify(data, null, 2);
                status.textContent = "200 OK";
            } catch (err) {
                box.textContent = "Error: " + err.message;
                status.textContent = "Error";
            }
        }

        async function runCineSubzDL() {
            var apiKey = document.getElementById('testApiKey').value.trim();
            var q = document.getElementById('testQuery').value.trim();
            var box = document.getElementById('responseBox');
            var status = document.getElementById('responseStatus');

            if (!apiKey) { alert("Please enter API Key!"); return; }
            box.textContent = "Fetching CineSubz DL response...";
            status.textContent = "Loading...";

            try {
                var url = "/api/v1/movie/cinesubz/dl?url=" + encodeURIComponent(q) + "&apikey=" + encodeURIComponent(apiKey);
                var res = await fetch(url);
                var data = await res.json();
                box.textContent = JSON.stringify(data, null, 2);
                status.textContent = "200 OK";
            } catch (err) {
                box.textContent = "Error: " + err.message;
                status.textContent = "Error";
            }
        }

        function updateDlUrl() {
            var param = encodeURIComponent(document.getElementById('dlParamUrl').value.trim());
            var key = encodeURIComponent(document.getElementById('dlApiKey').value.trim());
            var full = window.location.origin + "/api/movie/cinesubz/dl?url=" + param + "&apikey=" + key;
            document.getElementById('dlFullUrl').value = full;
        }

        async function runDlApi() {
            var fullUrl = document.getElementById('dlFullUrl').value;
            var box = document.getElementById('dlResponseBox');
            var status = document.getElementById('dlStatus');

            if (!document.getElementById('dlApiKey').value.trim()) { alert("Please enter API Key!"); return; }

            box.textContent = "Fetching response...";
            status.textContent = "Loading...";
            status.className = "text-gray-500 font-bold";

            try {
                var res = await fetch(fullUrl);
                var data = await res.json();
                box.textContent = JSON.stringify(data, null, 2);
                status.textContent = res.status + (res.ok ? " OK" : " Error");
                status.className = (res.ok ? "text-emerald-400" : "text-red-400") + " font-bold";
            } catch (err) {
                box.textContent = "Error: " + err.message;
                status.textContent = "Error";
                status.className = "text-red-400 font-bold";
            }
        }

        function copyDlUrl() {
            var copyText = document.getElementById('dlFullUrl');
            copyText.select();
            try {
                navigator.clipboard.writeText(copyText.value).then(function () {
                    alert("API URL Copied to Clipboard!");
                }, function () {
                    document.execCommand('copy');
                    alert("API URL Copied to Clipboard!");
                });
            } catch (e) {
                document.execCommand('copy');
                alert("API URL Copied to Clipboard!");
            }
        }

        var myKey = (savedUser && savedUser.key) ? savedUser.key : '';
        if (savedUser) showUser(savedUser);
        document.getElementById('testApiKey').value = sessionStorage.getItem('adminKey') || myKey;
        document.getElementById('dlApiKey').value = sessionStorage.getItem('adminKey') || myKey;
        updateDlUrl();

        document.getElementById('loadBtn').addEventListener('click', loadKeys);

        document.getElementById('createForm').addEventListener('submit', async function (e) {
            e.preventDefault();
            var name = document.getElementById('keyName').value;
            var headers = Object.assign({ 'Content-Type': 'application/json' }, authHeaders());
            var res = await fetch('/v1/api-keys', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ name: name })
            });
            var data = await res.json().catch(function () { return {}; });
            var box = document.getElementById('newKeyBox');
            box.classList.remove('hidden');
            if (data.status) {
                box.textContent = 'Key Created: ' + data.key + '  (Save it now!)';
                document.getElementById('keyName').value = '';
                loadKeys();
            } else {
                box.textContent = (data.message || 'Failed to create key');
            }
        });

        async function deleteKey(id) {
            if (confirm('Are you sure you want to delete this key?')) {
                await fetch('/v1/api-keys/' + id, { method: 'DELETE', headers: authHeaders() });
                loadKeys();
            }
        }

        loadKeys();
    </script>
</body>
</html>`);
});

app.post('/v1/api-keys', verifyMaster, (req, res) => {
    const { name } = req.body || {};
    if (!name || typeof name !== 'string') {
        return res.status(400).json({ status: false, creator: CREATOR, message: "Key name is required!" });
    }

    const randomHex = crypto.randomBytes(16).toString('hex');
    const newKey = `maleesha_api_${randomHex}`;
    const newId = crypto.randomBytes(6).toString('hex');

    const keys = getKeys();
    keys.push({
        id: newId,
        name: name.slice(0, 50),
        key: newKey,
        requestCount: 0,
        lastReset: new Date().toDateString(),
        createdAt: new Date().toISOString()
    });
    saveKeys(keys);

    return res.status(201).json({
        status: true,
        creator: CREATOR,
        message: "API key created successfully!",
        id: newId,
        name: name.slice(0, 50),
        key: newKey
    });
});

app.get('/v1/api-keys', verifyMaster, (req, res) => {
    return res.json(getKeys());
});

app.delete('/v1/api-keys/:id', verifyMaster, (req, res) => {
    const keyId = req.params.id;

    if (keyId === MASTER_ID) {
        return res.status(400).json({ status: false, message: "The master key cannot be deleted!" });
    }

    const keys = getKeys();
    const remaining = keys.filter(k => k.id !== keyId);

    if (remaining.length === keys.length) {
        return res.status(404).json({ status: false, message: "API key ID not found!" });
    }

    saveKeys(remaining);
    return res.json({ status: true, message: "API key deleted successfully." });
});

// =======================================================
// MOVIE SITES
// =======================================================

async function scrapeGenericSite(siteUrl, searchPath, detailPath, query, res, isInfodl = false) {
    try {
        if (!query) {
            return res.status(400).json({ status: false, creator: CREATOR, message: "Query parameter 'q' is required!" });
        }
        const targetUrl = isInfodl ? query : `${siteUrl}${searchPath}?s=${encodeURIComponent(query)}`;

        if (isInfodl) {
            const { data } = await axios.get(targetUrl, { headers: { 'User-Agent': UA }, timeout: 20000 });
            const $ = cheerio.load(data);
            const title = cleanTitle($('meta[property="og:title"]').attr('content') || $('h1').first().text()) || 'Movie';
            const image = $('meta[property="og:image"]').attr('content') || '';
            const imdb = $('body').text().match(/IMDb\s*:?\s*([0-9]\.[0-9])/i)?.[1] || 'N/A';
            const story = $('meta[property="og:description"]').attr('content') || 'N/A';

            const downloads = [];
            $('a[href]').each((i, el) => {
                const href = $(el).attr('href');
                if (href && (href.includes('.mp4') || href.includes('.mkv') || href.includes('drive.google') || href.includes('pixeldrain'))) {
                    downloads.push({ quality: $(el).text().trim() || 'HD', direct_link: href });
                }
            });

            return res.json({ status: true, creator: CREATOR, data: { title, image, imdb, story, downloads } });
        } else {
            const { data } = await axios.get(targetUrl, { headers: { 'User-Agent': UA }, timeout: 20000 });
            const $ = cheerio.load(data);
            const results = [];
            $('a').each((i, el) => {
                const href = $(el).attr('href');
                const title = cleanTitle($(el).text());
                if (href && title && title.length > 3 && (href.includes('/movie/') || href.includes('/tvshows/') || href.includes('/series/'))) {
                    if (!results.some(r => r.link === href)) {
                        results.push({ title, link: href, image: '' });
                    }
                }
            });
            return res.json({ status: true, creator: CREATOR, count: results.length, results: results.slice(0, 20) });
        }
    } catch (e) {
        return res.status(500).json({ status: false, creator: CREATOR, error: e.message });
    }
}

// =======================================================
// CINESUBZ COMPLETE API ENDPOINTS (MALIYA CINE HUB)
// =======================================================

// 1. CINESUBZ SEARCH API
app.get(['/api/v1/movie/cinesubz/search', '/api/movie/cinesubz/search'], verifyApiKey, async (req, res) => {
    try {
        const query = req.query.q || req.query.query;
        if (!query) {
            return res.status(400).json({ status: false, creator: CREATOR, message: "Query parameter 'q' is required!" });
        }

        const searchUrl = `${SITE}/?s=${encodeURIComponent(query)}`;
        const { data } = await axios.get(searchUrl, {
            headers: { 'User-Agent': UA, 'Referer': `${SITE}/` },
            timeout: 20000
        });

        const $ = cheerio.load(data);
        const results = [];
        const seenLinks = new Set();

        $('article, .result-item, .post-item, a[href]').each((i, el) => {
            let link = $(el).attr('href') || $(el).find('a').first().attr('href');
            link = absUrl(link, SITE);

            if (!link || seenLinks.has(link)) return;

            if (isContentLink(link)) {
                const imgEl = $(el).find('img').first();
                let title = $(el).find('.entry-title, .title, h2, h3').first().text().trim()
                            || imgEl.attr('alt')
                            || $(el).attr('title')
                            || $(el).text().trim();

                title = cleanTitle(title);
                const image = imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || imgEl.attr('src') || '';

                if (title && title.length >= 2 && !title.toLowerCase().includes('tv shows')) {
                    seenLinks.add(link);
                    results.push({ title, link, image });
                }
            }
        });

        // Fallback: older theme layout (.result-item / .item with .title a / h3 a)
        if (results.length === 0) {
            $('.result-item, .item').each((_, el) => {
                const a = $(el).find('.title a, h3 a').first();
                const title = cleanTitle(a.text());
                const link = absUrl(a.attr('href'), SITE);
                const image = $(el).find('img').first().attr('src') || '';
                if (title && link && !seenLinks.has(link)) {
                    seenLinks.add(link);
                    results.push({ title, link, image });
                }
            });
        }

        return res.json({
            status: true,
            creator: CREATOR,
            count: results.length,
            results
        });
    } catch (error) {
        return res.status(500).json({ status: false, creator: CREATOR, error: error.message });
    }
});

// 2. CINESUBZ INFO & DETAILS API
app.get(['/api/v1/movie/cinesubz/infodl', '/api/movie/cinesubz/infodl'], verifyApiKey, async (req, res) => {
    const q = req.query.q || req.query.url;
    if (!q) {
        return res.status(400).json({ status: false, creator: CREATOR, message: "URL 'q' is required" });
    }

    let parsed;
    try { parsed = new URL(q); } catch {
        return res.status(400).json({ status: false, creator: CREATOR, message: "Invalid URL!" });
    }

    try {
        const targetUrl = parsed.href;
        console.log(`[CineSubz Info] Scraping: ${targetUrl}`);

        const { data } = await axios.get(targetUrl, {
            headers: { 'User-Agent': UA, 'Referer': `${SITE}/` },
            timeout: 20000
        });

        const $ = cheerio.load(data);

        const title = cleanTitle($('meta[property="og:title"]').attr('content'))
            || cleanTitle($('h1.entry-title, .s-title').first().text())
            || cleanTitle($('title').text())
            || 'Movie';

        const image = tmdbSize(
            $('meta[property="og:image"]').attr('content')
            || $('.poster img').first().attr('src')
            || $('.m-img img').first().attr('src')
            || '',
            'w780'
        );

        const paragraphs = $('#info .wp-content, .wp-content').first().find('p')
            .map((_, p) => $(p).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
        const story = paragraphs.join('\n\n')
            || $('.wp-content, .story, .synopsis').first().text().replace(/\s+/g, ' ').trim()
            || $('.entry-content p').first().text().replace(/\s+/g, ' ').trim()
            || $('meta[property="og:description"]').attr('content')
            || 'N/A';

        // Cast & Gallery
        const cast = [];
        const seenCast = new Set();
        $('#cast .person, .cast-item, .person, .actor').each((_, el) => {
            const name = cleanTitle($(el).find('.name a, .name, h4').first().text());
            if (!name || seenCast.has(name)) return;
            seenCast.add(name);
            const role = cleanTitle($(el).find('.caracter, .role, .character').first().text());
            const img = tmdbSize(imgSrc($(el).find('img').first()), 'w185');
            cast.push({ name, role: role || 'Actor', image: img });
        });

        const downloads = [];
        $('a.movie-download-button, .movie-download-link-item a[href]').each((_, el) => {
            const link = absUrl($(el).attr('href'), targetUrl);
            if (!link || downloads.some(d => d.link === link)) return;

            const metaText = $(el).find('.movie-download-meta').text()
                || $(el).closest('.movie-download-link-item').find('.movie-download-meta').first().text()
                || $(el).text();
            const { quality, size, lang } = parseDownloadMeta(metaText);

            downloads.push({
                quality: quality || `Option ${downloads.length + 1}`,
                size,
                language: lang,
                link
            });
        });

        // Fallback: any zt-links / api links on the page
        if (downloads.length === 0) {
            $('a[href*="/zt-links/"], a[href*="/api-rwjdzuehbdrwjdz/"]').each((_, el) => {
                const link = absUrl($(el).attr('href'), targetUrl);
                if (!link || downloads.some(d => d.link === link)) return;

                const t = cleanTitle($(el).text() || $(el).parent().text());
                downloads.push({
                    quality: /1080/.test(t) ? '1080p Full HD' : /720/.test(t) ? '720p HD' : '480p SD',
                    size: parseDownloadMeta(t).size,
                    language: 'Sinhala Subbed',
                    link
                });
            });
        }

        return res.json({
            status: true,
            creator: CREATOR,
            data: {
                title,
                image,
                story,
                cast: cast.slice(0, 15),
                downloads: downloads.slice(0, 20)
            }
        });
    } catch (error) {
        return res.status(500).json({ status: false, creator: CREATOR, error: error.message });
    }
});

// 3. CINESUBZ DIRECT MP4 / ZT-LINK DOWNLOAD RESOLVER API
app.get(['/api/v1/movie/cinesubz/dl', '/api/movie/cinesubz/dl'], verifyApiKey, async (req, res) => {
    try {
        const downloadUrl = req.query.url || req.query.q;
        if (!downloadUrl) {
            return res.status(400).json({ creator: CREATOR, success: false, message: "URL parameter required!" });
        }

        console.log(`[CineSubz DL] Resolving: ${downloadUrl}`);

        let resolvedLink = downloadUrl;
        let movieTitle = "Resolved CineSubz Download Link";

        if (/\/zt-links\//i.test(downloadUrl)) {
            try {
                const { data } = await axios.get(downloadUrl, {
                    headers: { 'User-Agent': UA, 'Referer': `${SITE}/` },
                    timeout: 15000
                });
                const html = typeof data === 'string' ? data : JSON.stringify(data);
                const $ = cheerio.load(html);

                const fetchedTitle = cleanTitle($('title').text() || $('h1').first().text());
                if (fetchedTitle) movieTitle = fetchedTitle;

                const real = await resolveZtLink(downloadUrl);
                if (real) {
                    resolvedLink = real;
                } else {
                    // Fallback: csplayer / btn-download links
                    const alt = $('a[href*="csplayer"]').attr('href') || $('a.btn-download').attr('href');
                    if (alt) resolvedLink = absUrl(alt, downloadUrl) || alt;
                }
            } catch (err) {
                console.error("[ZT-Link Fetch Error]:", err.message);
            }
        }

        return res.json({
            creator: CREATOR,
            success: true,
            query: downloadUrl,
            result: {
                title: movieTitle,
                ztLinkUrl: downloadUrl,
                mirrors: [
                    {
                        label: "Click Here",
                        url: resolvedLink
                    }
                ]
            }
        });
    } catch (error) {
        return res.status(500).json({ creator: CREATOR, success: false, error: error.message });
    }
});

const sitesList = ['baiscope', 'lksub', 'sinhalasub', 'thenkiri', 'cineru', 'dinkamovies', 'sinhalacartoons', 'chithrapata', 'animeheaven'];
sitesList.forEach(sName => {
    app.get(`/api/v1/movie/${sName}/search`, verifyApiKey, async (req, res) => {
        return scrapeGenericSite(`https://${sName}.lk`, '', '', req.query.q, res, false);
    });
    app.get(`/api/v1/movie/${sName}/infodl`, verifyApiKey, async (req, res) => {
        return scrapeGenericSite('', '', '', req.query.q || req.query.url, res, true);
    });
});

// =======================================================
// SOCIAL MEDIA DOWNLOADERS (YouTube, Facebook, TikTok)
// =======================================================

const PLATFORM_HOSTS = {
    yt: /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i,
    fb: /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/i,
    tiktok: /(^|\.)tiktok\.com$/i
};

async function getVideoInfo(platform, rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch {
        const err = new Error('Invalid URL!');
        err.statusCode = 400;
        throw err;
    }
    if (!/^https?:$/.test(u.protocol) || !PLATFORM_HOSTS[platform].test(u.hostname)) {
        const err = new Error('This is not a valid link for this endpoint!');
        err.statusCode = 400;
        throw err;
    }

    return youtubedl(u.href, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
        noPlaylist: true,
        format: 'best[ext=mp4]/best'
    });
}

function downloaderRoute(path, platform, label) {
    app.get(path, verifyApiKey, async (req, res) => {
        const videoUrl = req.query.url || req.query.q;
        if (!videoUrl) {
            return res.status(400).json({ status: false, creator: CREATOR, message: "URL parameter required!" });
        }

        try {
            console.log(`[${label}] Extracting: ${videoUrl}`);
            const info = await getVideoInfo(platform, videoUrl);
            const downloadUrl = info.url
                || info.formats?.find(f => f.vcodec !== 'none' && f.acodec !== 'none')?.url
                || null;

            if (!downloadUrl) throw new Error(`${label} video link could not be extracted.`);

            const title = info.title || `${label} Video`;
            const thumbnail = info.thumbnail || '';
            const duration = info.duration_string || info.duration || null;
            const author = info.uploader || 'Unknown';

            return res.json({
                status: true,
                creator: CREATOR,
                title,
                thumbnail,
                duration,
                author,
                download_url: downloadUrl,
                result: { title, url: downloadUrl, thumbnail, duration, author }
            });
        } catch (err) {
            console.error(`[${label} ERROR]`, err.message || err);
            return res.status(err.statusCode || 500).json({
                status: false,
                creator: CREATOR,
                message: err.statusCode ? err.message : `${label} download failed`,
                error: err.message
            });
        }
    });
}

downloaderRoute('/api/v1/download/yt', 'yt', 'YouTube');
downloaderRoute('/api/v1/download/fb', 'fb', 'Facebook');
downloaderRoute('/api/v1/download/tiktok', 'tiktok', 'TikTok');

// =======================================================
// ERROR HANDLER + START (must stay last)
// =======================================================

app.use((err, req, res, next) => {
    console.error(`[SERVER ERROR]`, err.stack || err);
    res.status(500).json({ status: false, creator: CREATOR, message: "Internal Server Error", error: err.message });
});

// =======================================================
// KEEP-ALIVE / ALWAYS-RUNNING SETUP
// =======================================================

// 1. Never let one bad request / scraper error kill the whole server
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err.stack || err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason && reason.stack ? reason.stack : reason);
});

const server = app.listen(PORT, () => {
    console.log(`🚀 ${CREATOR} API Server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard available at http://localhost:${PORT}/dashboard`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[FATAL] Port ${PORT} is already in use. Stop the other process first.`);
    } else {
        console.error('[SERVER LISTEN ERROR]', err);
    }
    process.exit(1); // let PM2 / the host restart us
});

// Avoid dropped connections behind proxies (Render, Heroku, Nginx ...)
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// 2. Self-ping so free hosts (Render, Glitch, Replit ...) don't put the app to sleep.
//    Set SELF_URL (or RENDER_EXTERNAL_URL) to your public URL, e.g. https://your-app.onrender.com
const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '';
const PING_EVERY_MS = 4 * 60 * 1000; // every 4 minutes

if (SELF_URL) {
    setInterval(async () => {
        try {
            await axios.get(`${SELF_URL.replace(/\/$/, '')}/status`, { timeout: 15000 });
            console.log(`[KEEP-ALIVE] Pinged ${SELF_URL} at ${new Date().toISOString()}`);
        } catch (e) {
            console.warn('[KEEP-ALIVE] Ping failed:', e.message);
        }
    }, PING_EVERY_MS);
    console.log(`🔁 Keep-alive enabled -> ${SELF_URL} every ${PING_EVERY_MS / 60000} min`);
} else {
    console.log('ℹ️  Keep-alive off (set SELF_URL env to enable self-ping on free hosting).');
}

// 3. Clean shutdown when the host / PM2 stops or restarts the app
function shutdown(signal) {
    console.log(`[${signal}] Shutting down gracefully...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
