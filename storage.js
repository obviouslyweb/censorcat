/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */

// localstorage definition key
const SETTINGS_STORAGE_KEY = "censorcatSettings";

// Get default settings from defaults.js
function getDefault() {
    const modeRaw = Number(CENSOR_MODE);
    const mode = Number.isInteger(modeRaw) && modeRaw >= 0 && modeRaw <= 3 ? modeRaw : 0;
    const char = typeof CENSOR_CHAR === "string" && CENSOR_CHAR.length > 0 ? Array.from(CENSOR_CHAR)[0] : "*";
    const sub = typeof CENSOR_SUB === "string" && CENSOR_SUB.length > 0 ? CENSOR_SUB : "[CENSORED]";

    return {
        disableCensor: Boolean(DISABLE_CENSOR),
        censorMode: mode,
        censorChar: char,
        censorSub: sub,
        censoredPhrases: Array.isArray(CENSORED_PHRASES) ? CENSORED_PHRASES : [],
        ignoredSites: Array.isArray(IGNORED_SITES) ? IGNORED_SITES : []
    };
}

// Take what is in localstorage and format it so the rest of the program can use it
function normalizeSettings(raw = {}) {
    const defaults = getDefault();
    const modeRaw = Number(raw.censorMode);
    const charRaw = typeof raw.censorChar === "string" ? Array.from(raw.censorChar)[0] : "";
    const subRaw = typeof raw.censorSub === "string" ? raw.censorSub : "";

    return {
        disableCensor: typeof raw.disableCensor === "boolean" ? raw.disableCensor : defaults.disableCensor,
        censorMode: Number.isInteger(modeRaw) && modeRaw >= 0 && modeRaw <= 3 ? modeRaw : defaults.censorMode,
        censorChar: charRaw || defaults.censorChar,
        censorSub: subRaw || defaults.censorSub,
        censoredPhrases: Array.isArray(raw.censoredPhrases) ? raw.censoredPhrases : defaults.censoredPhrases,
        ignoredSites: Array.isArray(raw.ignoredSites) ? raw.ignoredSites : defaults.ignoredSites
    };
}

// Load settings from localstorage
async function loadSettings() {
    const defaults = getDefault();
    const stored = await browser.storage.local.get(SETTINGS_STORAGE_KEY);
    const found = stored && stored[SETTINGS_STORAGE_KEY];
    if (!found) {
        await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: defaults });
        return defaults;
    }
    return normalizeSettings(found);
}

// Save settings to localstorage
async function saveSettings(rawSettings = {}) {
    const normalized = normalizeSettings(rawSettings);
    await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: normalized });
    return normalized;
}
