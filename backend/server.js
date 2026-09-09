// Importing required modules
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');
const Database = require('better-sqlite3');
const cron = require('node-cron');

// Initialize the app
const app = express();
const CLUB_ID = '00ES8GNB6000001DVV0AG08LVUPGND5I';
const GAMES_SOURCE_URL = `https://www.fussball.de/ajax.club.matchplan/-/id/${CLUB_ID}/mode/PAGE/show-filter/true`;
const GAMES_PRINT_URL = 'https://www.fussball.de/vereinsspielplan.druck/-';
const MATCHPLAN_PAGE_SIZE = 10;
const MATCHPLAN_MAX_PAGES = 100;
const FUSSBALL_DE_HEADERS = {
    'User-Agent': 'Mozilla/5.0',
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/json, text/javascript, */*; q=0.01'
};
const gamesCacheStatus = {
    lastRefreshAttempt: null,
    lastRefreshSuccess: null,
    lastSource: 'cache',
    lastError: null
};

const SPONSOR_GROUP_FOLDERS = [
    '01_Hauptsponsoren_ 1000 Euro +',
    '02_Co-Sponsoren_ 500 Euro +',
    '03_Premiumpartner_ 250 Euro +',
    '04_Partner SG 150 Euro'
];

function normalizeSponsorGroupFolder(groupName) {
    if (!groupName) return 'misc';
    const normalized = String(groupName).trim();
    if (SPONSOR_GROUP_FOLDERS.includes(normalized)) {
        return normalized;
    }
    return normalized
        .replace(/[\\/]+/g, '_')
        .replace(/[^a-zA-Z0-9 _\-\+]/g, '_')
        .trim() || 'misc';
}

// Middleware to parse JSON bodies
app.use(express.json());

// Setup file upload temp directory
const uploadsTemp = path.join(__dirname, '../frontend/uploads');
if (!fs.existsSync(uploadsTemp)) fs.mkdirSync(uploadsTemp, { recursive: true });
const upload = multer({ dest: uploadsTemp });

// Initialize SQLite DB
const dbPath = path.join(__dirname, 'data/scoreboard.db');
ensureParentDir(dbPath);
const db = new Database(dbPath);
// Create tables
db.prepare(`CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY,
    name TEXT,
    team TEXT,
    position TEXT,
    image TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS sponsors (
    id INTEGER PRIMARY KEY,
    name TEXT,
    group_name TEXT,
    image TEXT,
    active INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 99,
    weight INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS game_settings (
    id INTEGER PRIMARY KEY,
    game_id TEXT,
    auto_sync INTEGER DEFAULT 0,
    sync_before_minutes INTEGER DEFAULT 30,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS lineups (
    id INTEGER PRIMARY KEY,
    game_id TEXT,
    player_id INTEGER,
    role TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

// Helper to move uploaded file into target folder and return public path
function moveUploadToFrontend(file, targetDir, targetFilename) {
    const destDir = path.join(__dirname, '..', 'frontend', targetDir);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const destName = targetFilename || file.originalname;
    const destPath = path.join(destDir, destName);
    try {
        fs.renameSync(file.path, destPath);
        return path.join('/' + targetDir, destName).replace(/\\\\/g, '/');
    } catch (e) {
        // fallback: copy
        fs.copyFileSync(file.path, destPath);
        fs.unlinkSync(file.path);
        return path.join('/' + targetDir, destName).replace(/\\\\/g, '/');
    }
}

// Serve static files from the frontend directory
app.use(express.static(path.join(__dirname, '../frontend')));

// Helper to write display.json ensuring directory exists
function writeDisplay(displayData) {
    const displayPath = path.join(__dirname, 'data/display.json');
    const displayDir = path.dirname(displayPath);
    if (!fs.existsSync(displayDir)) fs.mkdirSync(displayDir, { recursive: true });
    // Compute a numeric display elapsed seconds that includes any running time
    // plus the configured offsetMinutes. We store it as `displayElapsedSeconds`
    // so consumers can read the offset-applied number directly.
    try {
        const computed = computeDisplayElapsedSeconds(displayData);
        displayData.displayElapsedSeconds = computed;
    } catch (e) {
        // Ignore compute errors and continue writing whatever we have
    }

    fs.writeFileSync(displayPath, JSON.stringify(displayData, null, 2));
}

// Compute the elapsed seconds including running time and offset (in seconds)
function computeDisplayElapsedSeconds(displayData) {
    let base = Number(displayData.elapsedSeconds || 0);
    if (displayData.isGameActive && displayData.startTime) {
        const running = Math.floor((Date.now() - displayData.startTime) / 1000);
        base += running;
    }
    const offsetSecs = (Number(displayData.offsetMinutes || 0) || 0) * 60;
    return base + offsetSecs;
}

function computeCurrentElapsedSeconds(displayData) {
    let base = Number(displayData.elapsedSeconds || 0);
    if (displayData.isGameActive && displayData.startTime) {
        base += Math.floor((Date.now() - displayData.startTime) / 1000);
    }
    return base;
}

function ensureParentDir(filePath) {
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function getGamesCachePath() {
    return path.join(__dirname, 'data/games-cache.json');
}

function getGamesBackupPath() {
    return path.join(__dirname, 'data/games-backup.json');
}

function readGamesCache() {
    const cachePath = getGamesCachePath();
    if (!fs.existsSync(cachePath)) {
        return [];
    }

    try {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        return Array.isArray(cached) ? cached : [];
    } catch (error) {
        console.error('Error reading games cache:', error);
        return [];
    }
}

function readGamesBackup() {
    const backupPath = getGamesBackupPath();
    if (!fs.existsSync(backupPath)) {
        return [];
    }

    try {
        const cached = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
        return Array.isArray(cached) ? cached : [];
    } catch (error) {
        console.error('Error reading games backup:', error);
        return [];
    }
}

function writeGamesCache(games) {
    const cachePath = getGamesCachePath();
    ensureParentDir(cachePath);
    fs.writeFileSync(cachePath, JSON.stringify(games, null, 2));
}

function writeGamesBackup(games) {
    const backupPath = getGamesBackupPath();
    ensureParentDir(backupPath);
    fs.writeFileSync(backupPath, JSON.stringify(games, null, 2));
}

function parseGameDateTime(dateTimeText) {
    if (!dateTimeText) {
        return null;
    }

    const dateMatch = String(dateTimeText).match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
    const timeMatch = String(dateTimeText).match(/(\d{1,2}):(\d{2})/);

    if (!dateMatch || !timeMatch) {
        return null;
    }

    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]) - 1;
    let year = Number(dateMatch[3]);
    if (year < 100) {
        year += 2000;
    }

    const hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2]);
    const parsed = new Date(year, month, day, hours, minutes, 0, 0);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getStartOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function formatDateForFussballDe(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function sortGamesByDateTime(games) {
    return [...games].sort((firstGame, secondGame) => {
        const firstDate = parseGameDateTime(firstGame.dateTime);
        const secondDate = parseGameDateTime(secondGame.dateTime);

        if (!firstDate && !secondDate) {
            return 0;
        }

        if (!firstDate) {
            return 1;
        }

        if (!secondDate) {
            return -1;
        }

        return firstDate.getTime() - secondDate.getTime();
    });
}

function filterFutureGames(games, now = new Date()) {
    return sortGamesByDateTime(games.filter(game => {
        const gameDate = parseGameDateTime(game.dateTime);
        return gameDate && gameDate.getTime() >= now.getTime();
    }));
}

function filterGamesFromTodayUntilDaysAhead(games, daysAhead = 7, now = new Date()) {
    const rangeStart = now.getTime();
    const rangeEnd = getStartOfDay(now).getTime() + ((daysAhead + 1) * 24 * 60 * 60 * 1000);

    return sortGamesByDateTime(games.filter(game => {
        const gameDate = parseGameDateTime(game.dateTime);
        if (!gameDate) {
            return false;
        }

        const timestamp = gameDate.getTime();
        return timestamp >= rangeStart && timestamp < rangeEnd;
    }));
}

function dedupeGames(games) {
    const seen = new Set();

    return games.filter(game => {
        const key = [game.dateTime, game.competition, game.homeTeam, game.awayTeam]
            .map(value => String(value || '').trim().toLowerCase())
            .join('|');

        if (seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

function buildMatchplanRequestParams(now = new Date()) {
    const rangeStart = getStartOfDay(now);
    const rangeEnd = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());

    return {
        max: MATCHPLAN_PAGE_SIZE,
        offset: 0,
        dateFrom: formatDateForFussballDe(rangeStart),
        dateTo: formatDateForFussballDe(rangeEnd),
        matchType: -1,
        showVenues: false
    };
}

function buildLoadMoreUrl({ dateFrom, dateTo, matchType, max, offset, showVenues }) {
    return [
        'https://www.fussball.de/ajax.club.matchplan.loadmore/-',
        `datum-bis/${dateTo}`,
        `datum-von/${dateFrom}`,
        `id/${CLUB_ID}`,
        `match-type/${matchType}`,
        `max/${max}`,
        `offset/${offset}`,
        'mime-type/JSON',
        'mode/PAGE',
        `show-venues/${showVenues}`
    ].join('/');
}

function buildPrintMatchplanUrl({ dateFrom, dateTo, matchType, showVenues }) {
    return [
        GAMES_PRINT_URL,
        `datum-bis/${dateTo}`,
        `datum-von/${dateFrom}`,
        `id/${CLUB_ID}`,
        `match-type/${matchType}`,
        'max/999',
        'mode/PRINT',
        `show-venues/${showVenues}`
    ].join('/');
}

async function fetchMatchplanHtml(now = new Date()) {
    const requestParams = buildMatchplanRequestParams(now);

    const initialResponse = await axios.get(GAMES_SOURCE_URL, {
        timeout: 15000,
        params: {
            max: requestParams.max,
            offset: requestParams.offset,
            'datum-von': requestParams.dateFrom,
            'datum-bis': requestParams.dateTo,
            'match-type': requestParams.matchType,
            'show-venues': requestParams.showVenues
        },
        headers: FUSSBALL_DE_HEADERS
    });

    let combinedHtml = initialResponse.data || '';
    let offset = MATCHPLAN_PAGE_SIZE;
    let isFinal = false;
    let pageCount = 1;
    let previousHtmlBlock = '';

    console.log(`[games-sync] initial matchplan page loaded, html length=${combinedHtml.length}`);

    while (!isFinal && pageCount < MATCHPLAN_MAX_PAGES) {
        const loadMoreUrl = buildLoadMoreUrl({
            dateFrom: requestParams.dateFrom,
            dateTo: requestParams.dateTo,
            matchType: requestParams.matchType,
            max: requestParams.max,
            offset,
            showVenues: requestParams.showVenues
        });

        const loadMoreResponse = await axios.get(loadMoreUrl, {
            timeout: 15000,
            headers: FUSSBALL_DE_HEADERS
        });

        const payload = loadMoreResponse.data;
        if (!payload || payload.success === false || !payload.html) {
            console.warn(`[games-sync] loadmore stopped at offset=${offset}, missing payload or html`);
            break;
        }

        if (payload.html === previousHtmlBlock) {
            console.warn(`[games-sync] loadmore returned repeated html at offset=${offset}, stopping pagination`);
            break;
        }

        combinedHtml += `\n${payload.html}`;
        previousHtmlBlock = payload.html;
        isFinal = payload.final === true || String(payload.final).toLowerCase() === 'true';
        pageCount += 1;
        console.log(`[games-sync] loadmore offset=${offset}, html length=${payload.html.length}, final=${isFinal}`);
        offset += MATCHPLAN_PAGE_SIZE;
    }

    if (!isFinal && pageCount >= MATCHPLAN_MAX_PAGES) {
        console.warn(`[games-sync] reached max page limit ${MATCHPLAN_MAX_PAGES}, stopping pagination`);
    }

    console.log(`[games-sync] combined matchplan pages=${pageCount}, total html length=${combinedHtml.length}`);

    return combinedHtml;
}

async function fetchNextGamesHtml(now = new Date()) {
    const requestParams = buildMatchplanRequestParams(now);

    const response = await axios.get(GAMES_SOURCE_URL, {
        timeout: 15000,
        params: {
            max: requestParams.max,
            offset: 0,
            'datum-von': requestParams.dateFrom,
            'datum-bis': requestParams.dateTo,
            'match-type': requestParams.matchType,
            'show-venues': requestParams.showVenues
        },
        headers: FUSSBALL_DE_HEADERS
    });

    const html = response.data || '';
    console.log(`[games-sync] next-games page loaded, html length=${html.length}`);
    return html;
}

async function fetchPrintMatchplanHtml(now = new Date()) {
    const requestParams = buildMatchplanRequestParams(now);
    const printUrl = buildPrintMatchplanUrl({
        dateFrom: requestParams.dateFrom,
        dateTo: requestParams.dateTo,
        matchType: requestParams.matchType,
        showVenues: requestParams.showVenues
    });

    const response = await axios.get(printUrl, {
        timeout: 20000,
        headers: {
            'User-Agent': FUSSBALL_DE_HEADERS['User-Agent'],
            'Accept': 'text/html,application/xhtml+xml'
        }
    });

    const html = response.data || '';
    console.log(`[games-sync] print view loaded, html length=${html.length}`);
    return html;
}

function extractGamesFromHtml(html) {
    const $ = cheerio.load(html);
    const games = [];
    const wrappedRows = $('div#id-club-matchplan-table table.table-striped tbody tr.row-competition');
    const allRows = $('tr.row-competition');

    if (allRows.length > wrappedRows.length) {
        console.log(`[games-sync] parsing loadmore fragments too: wrappedRows=${wrappedRows.length}, allRows=${allRows.length}`);
    }

    allRows.each((index, element) => {
        const row = $(element);
        const nextRow = row.next('tr');
        const dateCell = row.find('td.column-date').first();
        const dateLabel = dateCell.find('.hidden-small.inline').first().text().replace('|', ' ').trim();
        const timeLabel = dateCell.clone().find('.hidden-small.inline').remove().end().text().replace('|', ' ').trim();
        const competition = row.find('td.column-team a').first().text().trim();
        const homeTeam = nextRow.find('td.column-club .club-name').first().text().trim();
        const awayTeam = nextRow.find('td.column-club.no-border .club-name').first().text().trim();

        const dateTime = [dateLabel, timeLabel].filter(Boolean).join(' ');

        if (dateTime && competition && homeTeam && awayTeam) {
            games.push({
                dateTime,
                competition,
                homeTeam,
                awayTeam
            });
        }
    });

    return games;
}

function formatPrintDateTime(dateText, timeText) {
    const weekdayMap = {
        Montag: 'Mo',
        Dienstag: 'Di',
        Mittwoch: 'Mi',
        Donnerstag: 'Do',
        Freitag: 'Fr',
        Samstag: 'Sa',
        Sonntag: 'So'
    };
    const match = String(dateText || '').match(/^(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag),\s*(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!match) {
        return '';
    }

    const weekday = weekdayMap[match[1]] || match[1].slice(0, 2);
    return `${weekday}, ${match[2]}.${match[3]}.${match[4].slice(-2)} ${timeText}`;
}

function extractGamesFromPrintHtml(html) {
    const $ = cheerio.load(html);
    const games = [];
    $('tr.row-competition').each((index, element) => {
        const row = $(element);
        const nextRow = row.next('tr');
        const competition = row.find('td.column-team a').first().text().replace(/\s+/g, ' ').trim();
        const homeTeam = nextRow.find('td.column-club .club-name').first().text().replace(/\s+/g, ' ').trim();
        const awayTeam = nextRow.find('td.column-club.no-border .club-name').first().text().replace(/\s+/g, ' ').trim();
        const detailUrl = nextRow.find('td.column-score a').attr('href') || nextRow.find('td.column-club a').first().attr('href') || '';

        if (!competition || !homeTeam || !awayTeam || /spielfrei/i.test(awayTeam)) {
            return;
        }

        games.push({
            competition,
            homeTeam,
            awayTeam,
            detailUrl
        });
    });

    console.log(`[games-sync] print parser extracted=${games.length} game shells`);
    return games;
}

function formatMatchDetailDateTime(dateTimeText) {
    const parsed = parseGameDateTime(dateTimeText);
    if (!parsed) {
        return '';
    }

    const weekdayMap = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    const weekday = weekdayMap[parsed.getDay()];
    const day = String(parsed.getDate()).padStart(2, '0');
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const year = String(parsed.getFullYear()).slice(-2);
    const hours = String(parsed.getHours()).padStart(2, '0');
    const minutes = String(parsed.getMinutes()).padStart(2, '0');

    return `${weekday}, ${day}.${month}.${year} ${hours}:${minutes}`;
}

async function fetchKickoffDateTimeFromMatchDetail(detailUrl) {
    if (!detailUrl) {
        return '';
    }

    const response = await axios.get(detailUrl, {
        timeout: 20000,
        headers: {
            'User-Agent': FUSSBALL_DE_HEADERS['User-Agent'],
            'Accept': 'text/html,application/xhtml+xml'
        }
    });
    const html = response.data || '';
    const directMatch = html.match(/am\s+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/i);
    if (directMatch) {
        return formatMatchDetailDateTime(directMatch[1]);
    }

    const fallbackMatch = html.match(/(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/);
    return fallbackMatch ? formatMatchDetailDateTime(fallbackMatch[1]) : '';
}

async function resolvePrintGamesDateTimes(games) {
    const resolvedGames = [];
    const batchSize = 5;

    for (let index = 0; index < games.length; index += batchSize) {
        const batch = games.slice(index, index + batchSize);
        const batchResults = await Promise.all(batch.map(async game => {
            try {
                const dateTime = await fetchKickoffDateTimeFromMatchDetail(game.detailUrl);
                if (!dateTime) {
                    console.warn(`[games-sync] print detail missing datetime for ${game.homeTeam} vs ${game.awayTeam}`);
                    return null;
                }

                return {
                    dateTime,
                    competition: game.competition,
                    homeTeam: game.homeTeam,
                    awayTeam: game.awayTeam
                };
            } catch (error) {
                console.warn(`[games-sync] print detail fetch failed for ${game.homeTeam} vs ${game.awayTeam}: ${error.message}`);
                return null;
            }
        }));

        resolvedGames.push(...batchResults.filter(Boolean));
    }

    console.log(`[games-sync] print detail resolved=${resolvedGames.length}`);
    return resolvedGames;
}

async function refreshGamesCache(now = new Date()) {
    gamesCacheStatus.lastRefreshAttempt = new Date().toISOString();

    try {
        const nextGamesHtml = await fetchNextGamesHtml(now);
        const extractedGames = extractGamesFromHtml(nextGamesHtml);
        const dedupedGames = dedupeGames(extractedGames);
        const backupGames = readGamesBackup();
        const mergedBackupGames = sortGamesByDateTime(dedupeGames([...backupGames, ...dedupedGames]));
        const cachedGames = filterFutureGames(mergedBackupGames, now);

        writeGamesBackup(mergedBackupGames);
        writeGamesCache(cachedGames);

        console.log(`[games-sync] next-games extracted=${extractedGames.length}, mergedBackup=${mergedBackupGames.length}, future=${cachedGames.length}`);

        gamesCacheStatus.lastRefreshSuccess = new Date().toISOString();
        gamesCacheStatus.lastSource = 'live';
        gamesCacheStatus.lastError = null;

        return {
            success: true,
            source: 'live',
            cachedGames,
            dropdownGames: filterGamesFromTodayUntilDaysAhead(cachedGames, 7, now)
        };
    } catch (error) {
        const fallbackCachedGames = filterFutureGames(dedupeGames([
            ...readGamesBackup(),
            ...readGamesCache()
        ]), now);
        console.error(`[games-sync] live refresh failed, falling back to cache: ${error.message}`);

        gamesCacheStatus.lastSource = 'cache';
        gamesCacheStatus.lastError = error.message;

        return {
            success: fallbackCachedGames.length > 0,
            source: 'cache',
            error,
            cachedGames: fallbackCachedGames,
            dropdownGames: filterGamesFromTodayUntilDaysAhead(fallbackCachedGames, 7, now)
        };
    }
}

async function refreshGamesBackup(now = new Date()) {
    const printHtml = await fetchPrintMatchplanHtml(now);
    const extractedGameShells = extractGamesFromPrintHtml(printHtml);
    const extractedGames = await resolvePrintGamesDateTimes(extractedGameShells);
    const mergedBackupGames = sortGamesByDateTime(dedupeGames([
        ...readGamesBackup(),
        ...extractedGames
    ]));

    writeGamesBackup(mergedBackupGames);
    writeGamesCache(filterFutureGames(mergedBackupGames, now));

    console.log(`[games-sync] backup rebuilt: extracted=${extractedGames.length}, backup=${mergedBackupGames.length}`);

    return {
        success: true,
        source: 'backup-build',
        backupGames: mergedBackupGames,
        dropdownGames: filterGamesFromTodayUntilDaysAhead(mergedBackupGames, 7, now)
    };
}

function refreshGamesCacheOnBoot() {
    refreshGamesCache().then(result => {
        if (result.source === 'live') {
            console.log(`Games cache refreshed on boot from live source: ${result.cachedGames.length} future games stored.`);
            return;
        }

        console.warn('Games cache boot refresh fell back to local cache.', gamesCacheStatus.lastError || 'Unknown error');
    }).catch(error => {
        console.error('Boot-time games cache refresh failed:', error);
    });
}

// SSE clients list for pushing updates to connected displays
const sseClients = [];

function broadcastDisplay(displayData) {
    // Ensure the numeric displayElapsedSeconds is computed for the payload
    try {
        displayData.elapsedSeconds = computeCurrentElapsedSeconds(displayData);
        displayData.displayElapsedSeconds = computeDisplayElapsedSeconds(displayData);
    } catch (e) {}

    // Build a minimal payload that includes the key fields clients need
    const payloadObj = {
        homeTeam: displayData.homeTeam,
        awayTeam: displayData.awayTeam,
        homeScore: displayData.homeScore,
        awayScore: displayData.awayScore,
        isGameActive: displayData.isGameActive,
        startTime: displayData.startTime,
        elapsedSeconds: displayData.elapsedSeconds,
        offsetMinutes: displayData.offsetMinutes,
        displayElapsedSeconds: displayData.displayElapsedSeconds,
        time: displayData.time
    };
    const payload = JSON.stringify(payloadObj);
    sseClients.forEach(res => {
        try {
            res.write(`data: ${payload}\n\n`);
        } catch (e) {
            // ignore write errors; client will be cleaned up on close
        }
    });
}

// SSE endpoint - clients can connect to receive real-time updates
app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });

    // Send a ping comment to establish connection
    res.write(': connected\n\n');

    // Add to clients list
    sseClients.push(res);

    // Remove client on close
    req.on('close', () => {
        const idx = sseClients.indexOf(res);
        if (idx !== -1) sseClients.splice(idx, 1);
    });
});

// Endpoint to update the display with team names and scores
app.post('/api/update-display', (req, res) => {
    const incoming = req.body || {};

    // Log the received data for debugging
    console.log('Updating display with (incoming):', incoming);

    try {
        const displayPath = path.join(__dirname, 'data/display.json');
        let displayData = {};

        if (fs.existsSync(displayPath)) {
            displayData = JSON.parse(fs.readFileSync(displayPath, 'utf-8'));
        }

        // Merge incoming fields into existing displayData, preserving unspecified fields
        if (typeof incoming.homeTeam !== 'undefined') displayData.homeTeam = incoming.homeTeam;
        if (typeof incoming.awayTeam !== 'undefined') displayData.awayTeam = incoming.awayTeam;
        if (typeof incoming.homeScore !== 'undefined') displayData.homeScore = incoming.homeScore;
        if (typeof incoming.awayScore !== 'undefined') displayData.awayScore = incoming.awayScore;

        // Merge clock object if provided
        if (incoming.clock && typeof incoming.clock === 'object') {
            displayData.startTime = typeof incoming.clock.startTime !== 'undefined' ? incoming.clock.startTime : displayData.startTime;
            displayData.elapsedSeconds = typeof incoming.clock.elapsedTime !== 'undefined' ? incoming.clock.elapsedTime : displayData.elapsedSeconds;
            displayData.isGameActive = typeof incoming.clock.running !== 'undefined' ? incoming.clock.running : displayData.isGameActive;
            // Preserve initialElapsedSeconds if present
            if (typeof incoming.clock.initialElapsedSeconds !== 'undefined') displayData.initialElapsedSeconds = incoming.clock.initialElapsedSeconds;
            // Respect offsetMinutes if provided in clock payload
            if (typeof incoming.clock.offsetMinutes !== 'undefined') displayData.offsetMinutes = incoming.clock.offsetMinutes;
        }

        // Also accept top-level offsetMinutes
        if (typeof incoming.offsetMinutes !== 'undefined') displayData.offsetMinutes = incoming.offsetMinutes;

        // Save merged display data
        writeDisplay(displayData);
        // Broadcast to SSE clients
        broadcastDisplay(displayData);

        res.json({ success: true, message: 'Display updated successfully', displayData });
    } catch (error) {
        console.error('Error updating display:', error);
        res.status(500).json({ success: false, message: 'Failed to update display' });
    }
});

// Endpoint to scrape games from fussball.de
app.get('/api/scrape', async (req, res) => {
    try {
        const result = await refreshGamesCache();
        if (!result.success && result.cachedGames.length === 0) {
            return res.status(500).json({ success: false, message: 'Failed to refresh games cache', data: [] });
        }

        res.json({
            success: true,
            message: result.source === 'live'
                ? 'Naechste Spiele geladen und in Backup-Datei uebernommen'
                : 'Loaded games from local cache',
            data: result.dropdownGames,
            cacheCount: result.cachedGames.length,
            backupPath: getGamesBackupPath(),
            source: result.source,
            lastRefreshAttempt: gamesCacheStatus.lastRefreshAttempt,
            lastRefreshSuccess: gamesCacheStatus.lastRefreshSuccess,
            lastRefreshError: gamesCacheStatus.lastError
        });
    } catch (error) {
        console.error('Error scraping games:', error);
        res.status(500).json({ success: false, message: 'Failed to scrape games', data: [] });
    }
});

app.get('/api/games-cache', (req, res) => {
    const cachedGames = filterFutureGames(readGamesCache());
    const backupGames = filterFutureGames(readGamesBackup());
    const mergedFutureGames = sortGamesByDateTime(dedupeGames([
        ...backupGames,
        ...cachedGames
    ]));

    res.json({
        success: true,
        cachePath: getGamesCachePath(),
        backupPath: getGamesBackupPath(),
        backupCount: backupGames.length,
        totalFutureGames: mergedFutureGames.length,
        dropdownGames: filterGamesFromTodayUntilDaysAhead(mergedFutureGames, 7),
        data: mergedFutureGames,
        source: gamesCacheStatus.lastSource,
        lastRefreshAttempt: gamesCacheStatus.lastRefreshAttempt,
        lastRefreshSuccess: gamesCacheStatus.lastRefreshSuccess,
        lastRefreshError: gamesCacheStatus.lastError
    });
});

app.post('/api/build-games-backup', async (req, res) => {
    try {
        const result = await refreshGamesBackup();
        res.json({
            success: true,
            message: 'Backup-Datei mit Vereinsspielplan aktualisiert',
            backupPath: getGamesBackupPath(),
            backupCount: result.backupGames.length,
            data: result.dropdownGames
        });
    } catch (error) {
        console.error('Error building games backup:', error);
        res.status(500).json({
            success: false,
            message: 'Backup-Datei konnte nicht erstellt werden'
        });
    }
});

// Endpoint to provide display data
app.get('/api/display-data', (req, res) => {
    try {
        // Read the display data from the JSON file
        const displayPath = path.join(__dirname, 'data/display.json');
        if (fs.existsSync(displayPath)) {
            const displayData = JSON.parse(fs.readFileSync(displayPath, 'utf-8'));

            // Calculate the current time if the game is active
            if (displayData.isGameActive && displayData.startTime) {
                const elapsed = Math.floor((Date.now() - displayData.startTime) / 1000);
                displayData.elapsedSeconds = elapsed + (displayData.initialElapsedSeconds || 0);
                displayData.time = `${Math.floor(displayData.elapsedSeconds / 60).toString().padStart(2, '0')}:${(displayData.elapsedSeconds % 60).toString().padStart(2, '0')}`;
            }

            // Debugging: Log offsetMinutes when fetched
            console.log('Fetched offsetMinutes:', displayData.offsetMinutes || 0);

            // Ensure displayElapsedSeconds is up-to-date for the response
            displayData.displayElapsedSeconds = computeDisplayElapsedSeconds(displayData);

            // If the clock is not running, compute a time string from displayElapsedSeconds
            if (!displayData.isGameActive) {
                const total = Math.floor(displayData.displayElapsedSeconds || 0);
                displayData.time = `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
            }

            res.json({
                    success: true,
                    clock: {
                        running: displayData.isGameActive || false,
                        startTime: displayData.startTime || null,
                        elapsedTime: displayData.elapsedSeconds || 0
                    },
                    time: displayData.time || '00:00',
                    team1: {
                        name: displayData.homeTeam || 'Team 1',
                        score: displayData.homeScore || 0
                    },
                    team2: {
                        name: displayData.awayTeam || 'Team 2',
                        score: displayData.awayScore || 0
                    },
                    isGameActive: displayData.isGameActive || false,
                    elapsedSeconds: displayData.elapsedSeconds || 0,
                    offsetMinutes: displayData.offsetMinutes || 0,
                    displayElapsedSeconds: displayData.displayElapsedSeconds || 0
                });
        } else {
            res.json({
                success: true,
                time: '00:00',
                team1: { name: 'Team 1', score: 0 },
                team2: { name: 'Team 2', score: 0 },
                isGameActive: false,
                elapsedSeconds: 0
            });
        }
    } catch (error) {
        console.error('Error fetching display data:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch display data' });
    }
});

// Endpoint to list sponsor images with display priority and weighted rotation shares
app.get('/api/sponsors', (req, res) => {
    try {
        const sponsorsRoot = path.join(__dirname, '../frontend/sponsors');
        const sponsors = [];

        if (!fs.existsSync(sponsorsRoot)) {
            return res.json({ success: true, sponsors: [] });
        }

        const groups = fs.readdirSync(sponsorsRoot);
        groups.forEach(group => {
            const groupPath = path.join(sponsorsRoot, group);
            try {
                const stat = fs.statSync(groupPath);
                if (stat.isDirectory()) {
                    const m = group.match(/^(\d+)_/);
                    const rank = m ? parseInt(m[1], 10) : 99;
                    const weight = Math.max(1, 5 - rank);

                    const files = fs.readdirSync(groupPath).filter(f => /\.(png|jpe?g|gif|webp|svg)$/i.test(f));
                    files.forEach(f => {
                        sponsors.push({
                            url: `/sponsors/${encodeURIComponent(group)}/${encodeURIComponent(f)}`,
                            group,
                            priority: rank,
                            weight
                        });
                    });
                } else if (stat.isFile()) {
                    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(group)) {
                        sponsors.push({
                            url: `/sponsors/${encodeURIComponent(group)}`,
                            group: 'root',
                            priority: 4,
                            weight: 1
                        });
                    }
                }
            } catch (e) {
                // ignore unreadable entries
            }
        });

        res.json({ success: true, sponsors });
    } catch (error) {
        console.error('Error listing sponsors:', error);
        res.status(500).json({ success: false, message: 'Failed to list sponsors' });
    }
});

// --------- New DB-backed API endpoints ---------

// Sponsors CRUD (file upload for image)
app.get('/api/sponsors-db', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM sponsors ORDER BY priority ASC, created_at DESC').all();
        res.json({ success: true, sponsors: rows });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

app.post('/api/sponsors-db', upload.single('image'), (req, res) => {
    try {
        const { name, group_name, active, priority } = req.body;
        let imagePath = null;
        let storedGroup = group_name || '';
        if (req.file) {
            const groupFolder = normalizeSponsorGroupFolder(group_name);
            imagePath = moveUploadToFrontend(req.file, `sponsors/${groupFolder}`);
            storedGroup = groupFolder;
        }
        const info = db.prepare('INSERT INTO sponsors (name, group_name, image, active, priority) VALUES (?, ?, ?, ?, ?)')
            .run(name || 'Unnamed', storedGroup, imagePath || '', active ? 1 : 0, priority ? Number(priority) : 99);
        const sponsor = db.prepare('SELECT * FROM sponsors WHERE id = ?').get(info.lastInsertRowid);
        res.json({ success: true, sponsor });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

app.put('/api/sponsors-db/:id', upload.single('image'), (req, res) => {
    try {
        const id = Number(req.params.id);
        const { name, group_name, active, priority } = req.body;
        const sponsor = db.prepare('SELECT * FROM sponsors WHERE id = ?').get(id);
        if (!sponsor) return res.status(404).json({ success: false, message: 'Not found' });
        let imagePath = sponsor.image;
        let storedGroup = sponsor.group_name || '';
        if (req.file) {
            const groupFolder = normalizeSponsorGroupFolder(group_name || sponsor.group_name);
            imagePath = moveUploadToFrontend(req.file, `sponsors/${groupFolder}`);
            storedGroup = groupFolder;
        }
        db.prepare('UPDATE sponsors SET name = ?, group_name = ?, image = ?, active = ?, priority = ? WHERE id = ?')
            .run(name || sponsor.name, storedGroup, imagePath || sponsor.image, active ? 1 : 0, priority ? Number(priority) : sponsor.priority, id);
        res.json({ success: true, sponsor: db.prepare('SELECT * FROM sponsors WHERE id = ?').get(id) });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

app.delete('/api/sponsors-db/:id', (req, res) => {
    try {
        const id = Number(req.params.id);
        db.prepare('DELETE FROM sponsors WHERE id = ?').run(id);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

// Players CRUD (with image upload)
app.get('/api/players', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM players ORDER BY name COLLATE NOCASE').all();
        res.json({ success: true, players: rows });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

app.post('/api/players', upload.single('image'), (req, res) => {
    try {
        const { name, team, position, is_active } = req.body;
        let imagePath = '';
        if (req.file) {
            const teamFolder = (team || 'unknown').replace(/[^a-zA-Z0-9_\-]/g, '_');
            imagePath = moveUploadToFrontend(req.file, `players/${teamFolder}`);
        }
        const info = db.prepare('INSERT INTO players (name, team, position, image, is_active) VALUES (?, ?, ?, ?, ?)')
            .run(name || 'Unnamed', team || '', position || '', imagePath || '', is_active ? 1 : 1);
        const player = db.prepare('SELECT * FROM players WHERE id = ?').get(info.lastInsertRowid);
        res.json({ success: true, player });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

app.put('/api/players/:id', upload.single('image'), (req, res) => {
    try {
        const id = Number(req.params.id);
        const existing = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
        if (!existing) return res.status(404).json({ success: false });
        const { name, team, position, is_active } = req.body;
        let imagePath = existing.image;
        if (req.file) {
            const teamFolder = (team || existing.team || 'unknown').replace(/[^a-zA-Z0-9_\-]/g, '_');
            imagePath = moveUploadToFrontend(req.file, `players/${teamFolder}`);
        }
        db.prepare('UPDATE players SET name = ?, team = ?, position = ?, image = ?, is_active = ? WHERE id = ?')
            .run(name || existing.name, team || existing.team, position || existing.position, imagePath || existing.image, typeof is_active !== 'undefined' ? (is_active ? 1 : 0) : existing.is_active, id);
        res.json({ success: true, player: db.prepare('SELECT * FROM players WHERE id = ?').get(id) });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

app.delete('/api/players/:id', (req, res) => {
    try {
        const id = Number(req.params.id);
        db.prepare('DELETE FROM players WHERE id = ?').run(id);
        db.prepare('DELETE FROM lineups WHERE player_id = ?').run(id);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

// Game settings endpoints
app.get('/api/gamesettings/:gameId', (req, res) => {
    try {
        const gameId = req.params.gameId;
        const row = db.prepare('SELECT * FROM game_settings WHERE game_id = ?').get(gameId);
        res.json({ success: true, settings: row || null });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

app.post('/api/gamesettings/:gameId', (req, res) => {
    try {
        const gameId = req.params.gameId;
        const { auto_sync, sync_before_minutes } = req.body;
        const existing = db.prepare('SELECT * FROM game_settings WHERE game_id = ?').get(gameId);
        if (existing) {
            db.prepare('UPDATE game_settings SET auto_sync = ?, sync_before_minutes = ? WHERE game_id = ?')
                .run(auto_sync ? 1 : 0, Number(sync_before_minutes || 30), gameId);
        } else {
            db.prepare('INSERT INTO game_settings (game_id, auto_sync, sync_before_minutes) VALUES (?, ?, ?)')
                .run(gameId, auto_sync ? 1 : 0, Number(sync_before_minutes || 30));
        }
        res.json({ success: true, settings: db.prepare('SELECT * FROM game_settings WHERE game_id = ?').get(gameId) });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

// Lineup management for a game
app.post('/api/games/:gameId/lineup', (req, res) => {
    try {
        const gameId = req.params.gameId;
        const { starters = [], bench = [], others = [] } = req.body;
        // Remove existing for game
        db.prepare('DELETE FROM lineups WHERE game_id = ?').run(gameId);
        const insert = db.prepare('INSERT INTO lineups (game_id, player_id, role) VALUES (?, ?, ?)');
        starters.forEach(pid => insert.run(gameId, Number(pid), 'starter'));
        bench.forEach(pid => insert.run(gameId, Number(pid), 'bench'));
        others.forEach(pid => insert.run(gameId, Number(pid), 'not_selected'));
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

app.get('/api/games/:gameId/lineup', (req, res) => {
    try {
        const gameId = req.params.gameId;
        const rows = db.prepare('SELECT l.*, p.name as player_name, p.image as player_image FROM lineups l LEFT JOIN players p ON p.id = l.player_id WHERE l.game_id = ?').all(gameId);
        res.json({ success: true, lineup: rows });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

// Basic cron scheduler example (placeholder) to run sync jobs; can be extended
cron.schedule('*/5 * * * *', () => {
    // placeholder: in future check DB for upcoming games with auto_sync and trigger sync
});


// Endpoint to start the clock
app.post('/api/start-clock', (req, res) => {
    try {
        const displayPath = path.join(__dirname, 'data/display.json');
        let displayData = {};
        const incoming = req.body || {};

        if (fs.existsSync(displayPath)) {
            displayData = JSON.parse(fs.readFileSync(displayPath, 'utf-8'));
        }

        if (typeof incoming.elapsedSeconds === 'number') {
            displayData.elapsedSeconds = Math.max(0, Math.floor(incoming.elapsedSeconds));
        }

        if (typeof incoming.offsetMinutes !== 'undefined') {
            displayData.offsetMinutes = Number(incoming.offsetMinutes) || 0;
        }

        displayData.isGameActive = true;
        displayData.startTime = Date.now();

    writeDisplay(displayData);
    broadcastDisplay(displayData);
        res.json({ success: true, message: 'Clock started', startTime: displayData.startTime });
    } catch (error) {
        console.error('Error starting clock:', error);
        res.status(500).json({ success: false, message: 'Failed to start clock' });
    }
});

// Endpoint to stop the clock
app.post('/api/stop-clock', (req, res) => {
    try {
        const displayPath = path.join(__dirname, 'data/display.json');
        let displayData = {};

        if (fs.existsSync(displayPath)) {
            displayData = JSON.parse(fs.readFileSync(displayPath, 'utf-8'));
        }

        // Allow clients to supply the current elapsed values when stopping the clock.
        // This is useful when the client's displayed time (including offset) should be
        // treated as authoritative.
        const incoming = req.body || {};

        if (displayData.isGameActive) {
            if (typeof incoming.elapsedSeconds === 'number') {
                // Client supplied the base elapsed seconds (without offset)
                displayData.elapsedSeconds = incoming.elapsedSeconds;
            } else if (typeof incoming.displayElapsedSeconds === 'number') {
                // Client supplied the display value (offset included). Convert to base elapsed
                    const offset = Number((typeof incoming.offsetMinutes !== 'undefined' ? incoming.offsetMinutes : (typeof displayData.offsetMinutes !== 'undefined' ? displayData.offsetMinutes : 0))) * 60;
                const displayVal = Number(incoming.displayElapsedSeconds || 0);
                const baseElapsed = Math.max(0, Math.floor(displayVal) - Math.floor(offset));
                displayData.elapsedSeconds = baseElapsed;
            } else {
                // Default behavior: compute based on startTime and add to stored elapsedSeconds
                const elapsed = Math.floor((Date.now() - displayData.startTime) / 1000);
                displayData.elapsedSeconds = (displayData.elapsedSeconds || 0) + elapsed;
            }

            displayData.isGameActive = false;
            delete displayData.startTime;
        }

        // Persist and broadcast
        writeDisplay(displayData);
        broadcastDisplay(displayData);
        res.json({ success: true, message: 'Clock stopped', elapsedSeconds: displayData.elapsedSeconds });
    } catch (error) {
        console.error('Error stopping clock:', error);
        res.status(500).json({ success: false, message: 'Failed to stop clock' });
    }
});

// Endpoint to reset the clock
app.post('/api/reset-clock', (req, res) => {
    try {
        const displayPath = path.join(__dirname, 'data/display.json');
        let displayData = {};

        if (fs.existsSync(displayPath)) {
            displayData = JSON.parse(fs.readFileSync(displayPath, 'utf-8'));
        }

        displayData.elapsedSeconds = 0;
    displayData.offsetMinutes = 0;
        displayData.isGameActive = false;
        delete displayData.startTime;

    writeDisplay(displayData);
    broadcastDisplay(displayData);
        res.json({ success: true, message: 'Clock reset' });
    } catch (error) {
        console.error('Error resetting clock:', error);
        res.status(500).json({ success: false, message: 'Failed to reset clock' });
    }
});

// Update score and sync with display data
app.post('/api/update-score', (req, res) => {
    try {
        const { team, action } = req.body;
        const displayPath = path.join(__dirname, 'data/display.json');
        let displayData = {};

        if (fs.existsSync(displayPath)) {
            displayData = JSON.parse(fs.readFileSync(displayPath, 'utf-8'));
        }

        if (team === 'home') {
            displayData.homeScore = parseInt(displayData.homeScore) || 0;
            displayData.homeScore += action === 'increment' ? 1 : -1;
            if (displayData.homeScore < 0) displayData.homeScore = 0;
        } else if (team === 'away') {
            displayData.awayScore = parseInt(displayData.awayScore) || 0;
            displayData.awayScore += action === 'increment' ? 1 : -1;
            if (displayData.awayScore < 0) displayData.awayScore = 0;
        }

    writeDisplay(displayData);
    broadcastDisplay(displayData);
        res.json({ success: true, message: 'Score updated' });
    } catch (error) {
        console.error('Error updating score:', error);
        res.status(500).json({ success: false, message: 'Failed to update score' });
    }
});

// Endpoint to set offset minutes
app.post('/api/set-offset', (req, res) => {
    const { offsetMinutes } = req.body;

    try {
        const displayPath = path.join(__dirname, 'data/display.json');
        let displayData = {};

        if (fs.existsSync(displayPath)) {
            displayData = JSON.parse(fs.readFileSync(displayPath, 'utf-8'));
        }

        displayData.offsetMinutes = offsetMinutes;

        // Debugging: Log offsetMinutes when set
        console.log('Setting offsetMinutes to:', offsetMinutes);

        // Save the updated display data
    writeDisplay(displayData);
    broadcastDisplay(displayData);

        res.json({ success: true, message: 'Offset minutes updated successfully' });
    } catch (error) {
        console.error('Error setting offset minutes:', error);
        res.status(500).json({ success: false, message: 'Failed to set offset minutes' });
    }
});

// Start the server
const PORT = 3000;
function startServer() {
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
        refreshGamesCacheOnBoot();
    });
}

async function runCli() {
    if (!process.argv.includes('--build-games-backup')) {
        startServer();
        return;
    }

    try {
        const result = await refreshGamesBackup();
        console.log(`Games backup created at ${getGamesBackupPath()} with ${result.backupGames.length} games.`);
        process.exit(0);
    } catch (error) {
        console.error('Failed to create games backup:', error);
        process.exit(1);
    }
}

// Ensure there is a default display.json on startup and broadcast it so clients start
// with a stopped clock state.
(() => {
    try {
        const displayPath = path.join(__dirname, 'data/display.json');
        let displayData = {};
        if (fs.existsSync(displayPath)) {
            displayData = JSON.parse(fs.readFileSync(displayPath, 'utf-8')) || {};
        }

        // If no explicit isGameActive flag, or file missing, initialize defaults
        if (typeof displayData.isGameActive === 'undefined') {
            displayData.isGameActive = false;
        }
        if (typeof displayData.elapsedSeconds === 'undefined') {
            displayData.elapsedSeconds = 0;
        }
        if (typeof displayData.offsetMinutes === 'undefined') {
            displayData.offsetMinutes = 0;
        }

        writeDisplay(displayData);
        broadcastDisplay(displayData);
        console.log('Initial display state ensured and broadcasted.');
    } catch (e) {
        console.error('Error ensuring initial display state:', e);
    }
})();

runCli();

// Export the app for testing or further configuration
module.exports = app;