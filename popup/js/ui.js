/* eslint-disable no-undef */

// ----------------------------
//         UI Constants
// ----------------------------

const STORAGE_KEY = SETTINGS_STORAGE_KEY; // localStorage access key
const DEV_UI_STORAGE_KEY = "censorcatDevUiEnabled";
const MAX_STATUS_SYNC_RETRIES = 2; // How many attempts to get page data before we determine it's protected
let refreshTimerId = null;
let refreshRequestId = 0;
let statusSyncRetryCount = 0;
let lastStatusSyncTabId = null;
let uiSettings = getDefault();

// ----------------------------
//     Storage persistence
// ----------------------------

// Save settings to storage and refresh word/omit lists
async function persistSettings(settings) {
    try {
        uiSettings = await saveSettings(settings);
    } catch {
        showUiAlert("Unable to save settings to local storage.", "error");
        uiSettings = normalizeSettings(settings);
    }
    renderDevStorage(uiSettings);
    setWordDetails();
    setOmitDetails();
}

// ----------------------------
//      Navigation buttons
// ----------------------------

const VIEW_IDS = ["view-home", "view-words", "view-omit", "view-info"];
const NAV_IDS = ["nav-home", "nav-words", "nav-omit", "nav-info"];

// Hide all views and clear active nav state
function hideAllPages() {
    clearUiAlert();
    VIEW_IDS.forEach((id) => document.querySelector(`#${id}`)?.classList.add("hidden"));
    NAV_IDS.forEach((id) => document.querySelector(`#${id}`)?.classList.remove("active"));
}

// Show one view and set its nav button active
function showPage(viewId, navId) {
    hideAllPages();
    document.querySelector(`#${viewId}`)?.classList.remove("hidden");
    document.querySelector(`#${navId}`)?.classList.add("active");
}

document.querySelector("#nav-home").addEventListener("click", () => showPage("view-home", "nav-home"));
document.querySelector("#nav-words").addEventListener("click", () => showPage("view-words", "nav-words"));
document.querySelector("#nav-omit").addEventListener("click", () => showPage("view-omit", "nav-omit"));
document.querySelector("#nav-info").addEventListener("click", () => showPage("view-info", "nav-info"));

// ----------------------------
//   HOME: status & site link
// ----------------------------

// Return true if URL is a protected browser scheme (about:, moz-extension:, etc)
function isBrowserProtectedUrl(url) {
    if (!url || typeof url !== "string") {
        return false;
    }
    return /^(about|chrome|edge|moz-extension|chrome-extension|view-source):/i.test(url);
}

// Convert URL to hostname+path for display or return unavailable/protected message
function formatSiteLink(url) {
    if (!url || typeof url !== "string") {
        return "Site unavailable";
    }
    if (isBrowserProtectedUrl(url)) {
        return "Browser protected page";
    }
    try {
        const parsed = new URL(url);
        return `${parsed.hostname}${parsed.pathname}`;
    } catch {
        return url;
    }
}

// Set home sitelink text and toggle soft/protected classes by content
function setSiteLink(text) {
    const siteLinkEl = document.querySelector(".home-sitelink");
    if (!siteLinkEl) {
        return;
    }
    const normalizedText = String(text || "").trim().toLowerCase();
    siteLinkEl.classList.toggle("soft", normalizedText === "site unavailable");
    siteLinkEl.classList.toggle("protected", normalizedText === "browser protected page");
    siteLinkEl.textContent = text;
}

// Update home page status heading and message, optionally append reload notice
function setStatus(statusType, heading, message, showPendingNotice = false) {
    const focusEl = document.querySelector(".home-status-focus");
    const messageEl = document.querySelector(".home-status-msg");
    if (!focusEl || !messageEl) return;
    focusEl.innerHTML = `Censoring <span class="home-status-value status-${statusType}">${String(heading || "").toUpperCase()}</span>`;
    messageEl.textContent = String(message || "");
    if (showPendingNotice) {
        messageEl.appendChild(document.createTextNode(" "));
        const notice = document.createElement("span");
        notice.className = "status-settings-pending";
        notice.textContent = "Settings changed after this page was censored. Reload this page to apply them.";
        messageEl.appendChild(notice);
    }
}

// Map content script status tuple to { statusType, heading, message }
function buildStatus(status) {
    if (!Array.isArray(status) || status.length < 3) return null;
    const didRun = Boolean(status[0]);
    const heading = String(status[1] || (didRun ? "Enabled" : "Unavailable"));
    const message = String(status[2] || "");
    const h = heading.toLowerCase();
    const statusType = didRun ? "enabled"
        : h === "omitted" ? "omitted"
        : h.startsWith("loading") ? "loading"
        : h === "protected" ? "protected"
        : h === "unavailable" ? "unavailable"
        : "disabled";
    return { statusType, heading, message };
}

function showUiAlert(message, severity = "info") {
    const el = document.querySelector("#ui-alert");
    if (!el) return;

    const text = String(message || "");
    el.textContent = text;
    el.classList.remove("hidden");
    el.classList.remove("error", "warning", "info");
    if (severity === "error" || severity === "warning" || severity === "info") {
        el.classList.add(severity);
    }

    el.tabIndex = 0;

    const dismiss = () => clearUiAlert();

    el.onclick = dismiss;
    el.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            dismiss();
        }
    };
}

function clearUiAlert() {
    const el = document.querySelector("#ui-alert");
    if (!el) return;

    if (document.activeElement === el) {
        el.blur();
    }

    el.classList.add("hidden");
    el.classList.remove("error", "warning", "info");
    el.tabIndex = -1;
    el.onclick = null;
    el.onkeydown = null;
}

async function copyTextToClipboard(text) {
    const value = String(text ?? "");
    if (!value) return false;

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(value);
            return true;
        }
    } catch {
        // fall back to execCommand
    }

    try {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "-9999px";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const ok = document.execCommand && document.execCommand("copy");
        document.body.removeChild(textarea);
        return Boolean(ok);
    } catch {
        return false;
    }
}

// -----------------------------------
//    List UI (for words & omit tabs)
// -----------------------------------

// Return phrase with middle letters replaced by asterisks for list display
function maskPhraseForDisplay(text) {
    const s = String(text || "");
    const len = s.length;
    if (len === 0) return "—";
    if (len === 1) return s;
    return s[0] + "*".repeat(len - 2) + s[len - 1];
}

// Populate words-status and word-list from uiSettings.censoredPhrases
function setWordDetails() {
    const count = Array.isArray(uiSettings.censoredPhrases) ? uiSettings.censoredPhrases.length : 0;
    const wordsStatusElement = document.getElementById("words-status");
    if (wordsStatusElement) {
        wordsStatusElement.innerHTML = `Currently censoring <strong>${count}</strong> words/phrases.`;
    }

    const wordListEl = document.getElementById("word-list");
    if (!wordListEl) {
        return;
    }
    wordListEl.textContent = "";

    const phrases = Array.isArray(uiSettings.censoredPhrases) ? uiSettings.censoredPhrases : [];
    phrases.forEach((entry, index) => {
        const [phraseText, caseSensitive, isRegex] = Array.isArray(entry)
            ? entry
            : [String(entry || ""), false, false];

        const item = document.createElement("div");
        item.className = "scroll-item";

        const p = document.createElement("p");
        p.className = "scroll-text copy-target";
        p.textContent = isRegex ? phraseText : maskPhraseForDisplay(phraseText);
        p.dataset.copyValue = phraseText;
        p.tabIndex = 0;
        p.setAttribute("role", "button");

        p.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            clearUiAlert();
            const ok = await copyTextToClipboard(p.dataset.copyValue);
            if (ok) {
                showUiAlert("Copied uncensored word/phrase to clipboard.", "info");
            } else {
                showUiAlert("Could not copy to clipboard.", "error");
            }
        });

        p.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                p.click();
            }
        });
        item.appendChild(p);

        const phraseRight = document.createElement("div");
        phraseRight.className = "scroll-right phrase-right";

        if (caseSensitive) {
            const caseIcon = document.createElement("img");
            caseIcon.src = browser.runtime.getURL("icons/elements/icon-case.png");
            caseIcon.alt = "Case-sensitive icon";
            phraseRight.appendChild(caseIcon);
        }
        if (isRegex) {
            const regexIcon = document.createElement("img");
            regexIcon.src = browser.runtime.getURL("icons/elements/icon-regx.png");
            regexIcon.alt = "REGEX pattern icon";
            phraseRight.appendChild(regexIcon);
        }

        const removeBtn = document.createElement("button");
        removeBtn.className = "remove-item";
        removeBtn.type = "button";
        removeBtn.textContent = "X";
        removeBtn.addEventListener("click", () => {
            if (confirm("Remove this phrase from the censor list?")) {
                uiSettings.censoredPhrases.splice(index, 1);
                persistSettings(uiSettings);
            }
        });
        phraseRight.appendChild(removeBtn);

        item.appendChild(phraseRight);
        wordListEl.appendChild(item);
    });

    if (phrases.length === 0) {
        const emptyEl = document.createElement("p");
        emptyEl.className = "scroll-empty-state";
        emptyEl.textContent = "No items to display.";
        wordListEl.appendChild(emptyEl);
    }
}

// Populate omit-status and omit-list from uiSettings.ignoredSites
function setOmitDetails() {
    const omitListEl = document.getElementById("omit-list");
    const omitStatusEl = document.getElementById("omit-status");
    if (!omitListEl) {
        return;
    }
    omitListEl.textContent = "";

    const sites = Array.isArray(uiSettings.ignoredSites) ? uiSettings.ignoredSites : [];
    if (omitStatusEl) {
        omitStatusEl.innerHTML = `Currently omitting <strong>${sites.length}</strong> site${sites.length === 1 ? "" : "s"}.`;
    }
    sites.forEach((entry, index) => {
        const [site, wholeDomain] = Array.isArray(entry) && entry.length >= 2
            ? entry
            : [String(entry || ""), false];

        const item = document.createElement("div");
        item.className = "scroll-item";

        const p = document.createElement("p");
        p.className = "scroll-text copy-target";
        p.textContent = site;
        if (wholeDomain) {
            const domainSpan = document.createElement("span");
            domainSpan.className = "omit-domain-tag";
            domainSpan.textContent = " (domain)";
            p.appendChild(domainSpan);
        }

        const clipboardLink = site.includes("://") ? site : `https://${site}`;
        p.dataset.copyValue = clipboardLink;
        p.tabIndex = 0;
        p.setAttribute("role", "button");

        p.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            clearUiAlert();
            const ok = await copyTextToClipboard(p.dataset.copyValue);
            if (ok) {
                showUiAlert("Omit link copied to clipboard.", "info");
            } else {
                showUiAlert("Could not copy to clipboard.", "error");
            }
        });

        p.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                p.click();
            }
        });
        item.appendChild(p);

        const itemRight = document.createElement("div");
        itemRight.className = "scroll-right phrase-right";

        const removeBtn = document.createElement("button");
        removeBtn.className = "remove-item";
        removeBtn.type = "button";
        removeBtn.textContent = "X";
        removeBtn.addEventListener("click", () => {
            if (confirm("Remove this site from the omit list?")) {
                uiSettings.ignoredSites.splice(index, 1);
                persistSettings(uiSettings);
            }
        });
        itemRight.appendChild(removeBtn);

        item.appendChild(itemRight);
        omitListEl.appendChild(item);
    });

    if (sites.length === 0) {
        const emptyEl = document.createElement("p");
        emptyEl.className = "scroll-empty-state";
        emptyEl.textContent = "No items to display.";
        omitListEl.appendChild(emptyEl);
    }
}

// ----------------------------
//  Setting changes detection
// ----------------------------

function buildMultiset(arr, keyFn) {
    const map = new Map();
    if (!Array.isArray(arr)) {
        return map;
    }
    for (const item of arr) {
        const k = keyFn(item);
        map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
}

function isMultisetSubmultiset(sub, sup) {
    for (const [k, count] of sub) {
        if ((sup.get(k) || 0) < count) {
            return false;
        }
    }
    return true;
}

function isStrictMultisetSuperset(sub, sup) {
    return isMultisetSubmultiset(sub, sup) && sup.size > 0
        && [...sup.entries()].some(([k, v]) => v > (sub.get(k) || 0));
}

function phraseEntryKey(entry) {
    const [word, caseSensitive, isRegex] = Array.isArray(entry)
        ? entry
        : [String(entry || ""), false, false];
    return JSON.stringify([String(word), Boolean(caseSensitive), Boolean(isRegex)]);
}

function omitEntryKey(entry) {
    const [site, wholeDomain] = Array.isArray(entry)
        ? entry
        : [String(entry || ""), false];
    return JSON.stringify([String(site), Boolean(wholeDomain)]);
}

function coreSettingsDiffer(page, ui) {
    return page.disableCensor !== ui.disableCensor
        || page.censorMode !== ui.censorMode
        || page.censorChar !== ui.censorChar
        || page.censorSub !== ui.censorSub;
}

// Phrase list
// show reload notice when words are removed
function phraseRemovalsTriggerPending(page, ui) {
    const p = buildMultiset(page.censoredPhrases, phraseEntryKey);
    const u = buildMultiset(ui.censoredPhrases, phraseEntryKey);
    return !isMultisetSubmultiset(p, u);
}

// Omit list
// show reload notice when entries are added
function omitAdditionsTriggerPending(page, ui) {
    const p = buildMultiset(page.ignoredSites, omitEntryKey);
    const u = buildMultiset(ui.ignoredSites, omitEntryKey);
    return isStrictMultisetSuperset(p, u);
}

// Return true when the tab's snapshot settings warrant the "reload to apply" notice
function shouldShowPendingNotice(pageSettings) {
    if (!pageSettings) {
        return false;
    }
    const page = normalizeSettings(pageSettings);
    const ui = uiSettings;
    if (coreSettingsDiffer(page, ui)) {
        return true;
    }
    if (phraseRemovalsTriggerPending(page, ui)) {
        return true;
    }
    if (omitAdditionsTriggerPending(page, ui)) {
        return true;
    }
    return false;
}

// ----------------------------
//   Update UI with settings
// ----------------------------

// Push settings into all home page controls (toggle, mode, char, substitute phrase)
function applySettingsToUi(settings) {
    const parsed = normalizeSettings(settings);
    uiSettings = parsed;

    const toggleEl = document.querySelector("#disable-censor-toggle");
    if (toggleEl) {
        toggleEl.checked = parsed.disableCensor;
        toggleEl.disabled = false;
    }

    const modeOptionsEl = document.querySelector(".mode-options");
    if (modeOptionsEl) {
        modeOptionsEl.classList.remove("is-loading");
    }

    const modeInputs = Array.from(document.querySelectorAll('input[name="censor_mode"]'));
    modeInputs.forEach((input) => {
        input.disabled = false;
        input.checked = Number(input.value) === parsed.censorMode;
    });

    const charInput = document.querySelector("#char");
    if (charInput) {
        charInput.disabled = false;
        charInput.value = parsed.censorChar;
    }

    const subInput = document.querySelector("#censor-phrase");
    if (subInput) {
        subInput.disabled = false;
        subInput.value = parsed.censorSub;
    }

    updateModeVisibility(parsed.censorMode);
}

// Show char row or substitute phrase row depending on censor mode
function updateModeVisibility(mode) {
    const charRow = document.querySelector("#char-row");
    const subRow = document.querySelector("#sub-row");
    if (!charRow || !subRow) {
        return;
    }

    const useSubstituteMode = Number(mode) === 3;
    charRow.classList.toggle("hidden", useSubstituteMode);
    subRow.classList.toggle("hidden", !useSubstituteMode);
}

// ------------------------------
//     Tabs & refresh elements
// ------------------------------

// Return the currently active tab in the current window
async function getActiveTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
}

// Cancel any pending refreshStatus timer
function clearRefreshTimer() {
    if (refreshTimerId !== null) {
        window.clearTimeout(refreshTimerId);
        refreshTimerId = null;
    }
}

// Schedule a single refreshStatus run after 700 ms
function scheduleRefresh() {
    if (refreshTimerId !== null) {
        return;
    }
    refreshTimerId = window.setTimeout(() => {
        refreshTimerId = null;
        refreshStatus();
    }, 700);
}

// Fetch tab and content script status then update site link and status UI
async function refreshStatus() {
    const requestId = ++refreshRequestId;
    const applyIfCurrent = (updateFn) => {
        if (requestId === refreshRequestId) {
            updateFn();
        }
    };

    let activeTab = null;
    try {
        activeTab = await getActiveTab();
    } catch {
        applyIfCurrent(() => {
            setSiteLink("Site unavailable");
            setStatus("unavailable", "Unavailable", "Censoring is unavailable for this page.");
        });
        return;
    }

    if (!activeTab) {
        applyIfCurrent(() => {
            setSiteLink("No active tab");
            setStatus("disabled", "Disabled", "No active tab is available.");
        });
        return;
    }

    if (activeTab.id !== lastStatusSyncTabId) {
        lastStatusSyncTabId = activeTab.id;
        statusSyncRetryCount = 0;
    }

    const siteText = formatSiteLink(activeTab.url);
    applyIfCurrent(() => {
        setSiteLink(siteText);
    });

    if (activeTab.status !== "complete") {
        statusSyncRetryCount = 0;
        applyIfCurrent(() => {
            setStatus("loading", "Loading...", "Waiting for page content to finish loading...");
        });
        scheduleRefresh();
        return;
    }

    if (isBrowserProtectedUrl(activeTab.url)) {
        statusSyncRetryCount = 0;
        applyIfCurrent(() => {
            setStatus("protected", "Protected", "This page is protected by the browser and cannot be censored.");
        });
        return;
    }

    try {
        const response = await browser.tabs.sendMessage(activeTab.id, { type: "GET_CENSOR_STATUS" });
        statusSyncRetryCount = 0;
        applyIfCurrent(() => {
            const responseSite = response && typeof response.site === "string" && response.site.length > 0
                ? response.site
                : formatSiteLink(activeTab.url);
            setSiteLink(responseSite);

            const pageSettings = response && response.settings ? normalizeSettings(response.settings) : null;
            const statusData = buildStatus(response && response.status);
            if (statusData) {
                setStatus(
                    statusData.statusType,
                    statusData.heading,
                    statusData.message,
                    shouldShowPendingNotice(pageSettings)
                );
            } else {
                setStatus("unavailable", "Unavailable", "Censoring status is unavailable.");
            }
        });
    } catch {
        statusSyncRetryCount += 1;
        const shouldRetry = statusSyncRetryCount < MAX_STATUS_SYNC_RETRIES;
        applyIfCurrent(() => {
            if (shouldRetry) {
                setStatus("loading", "Loading...", "Waiting for censoring status to sync...");
                scheduleRefresh();
                return;
            }
            clearRefreshTimer();
            setStatus("unavailable", "Unavailable", "Censoring is unavailable for this page.");
        });
    }
}

// --------------------------------
//   Wire event handlers & controls
// --------------------------------

// Open full-tab import/export page (popup cannot host file dialogs reliably).
function wireSettingsIoPage() {
    const btn = document.querySelector("#open-settings-io");
    if (!btn) {
        return;
    }

    btn.addEventListener("click", () => {
        const url = browser.runtime.getURL("popup/export-import.html");
        browser.tabs.create({ url }).catch(() => {
            showUiAlert(
                "Could not open the import/export page. Check that the extension is allowed to open tabs.",
                "error"
            );
        });
    });
}

// Custom switch styling keeps a real checkbox
function wireSwitchEnterToggle(checkbox) {
    if (!checkbox) {
        return;
    }
    checkbox.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") {
            return;
        }
        event.preventDefault();
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

// Toggle html class and checkbox so .dev-card sections use display flex vs none
function applyDevFeaturesVisibility(enabled) {
    document.documentElement.classList.toggle("dev-features-enabled", Boolean(enabled));
    const toggleEl = document.querySelector("#dev-toggle");
    if (toggleEl) {
        toggleEl.checked = Boolean(enabled);
    }
}

// Persist dev UI visibility
function wireDevFeaturesToggle() {
    const toggleEl = document.querySelector("#dev-toggle");
    if (!toggleEl) {
        return;
    }
    toggleEl.addEventListener("change", async () => {
        const on = Boolean(toggleEl.checked);
        try {
            await browser.storage.local.set({ [DEV_UI_STORAGE_KEY]: on });
        } catch {
            toggleEl.checked = !on;
            showUiAlert("Could not save dev features preference.", "error");
            return;
        }
        applyDevFeaturesVisibility(on);
    });
    wireSwitchEnterToggle(toggleEl);
}

// Wire reset-to-defaults button to persist defaults and refresh UI
function wireDevControls() {
    const resetButton = document.querySelector("#dev-reset-defaults");
    if (!resetButton) {
        return;
    }

    resetButton.addEventListener("click", async () => {
        const defaults = getDefault();
        await persistSettings(defaults);
        applySettingsToUi(defaults);
        refreshStatus();
    });
}

// Wire disable toggle, mode radios, char input, and substitute phrase to storage
function wireSettingsControls() {
    const toggleEl = document.querySelector("#disable-censor-toggle");
    if (toggleEl) {
        toggleEl.addEventListener("change", async (event) => {
            uiSettings.disableCensor = Boolean(event.target && event.target.checked);
            await persistSettings(uiSettings);
            refreshStatus();
        });
        wireSwitchEnterToggle(toggleEl);
    }

    const modeInputs = Array.from(document.querySelectorAll('input[name="censor_mode"]'));
    modeInputs.forEach((input) => {
        input.addEventListener("change", async (event) => {
            const nextMode = Number.parseInt(event.target && event.target.value, 10);
            if (!Number.isInteger(nextMode) || nextMode < 0 || nextMode > 3) {
                return;
            }
            uiSettings.censorMode = nextMode;
            updateModeVisibility(uiSettings.censorMode);
            await persistSettings(uiSettings);
            refreshStatus();
        });
    });

    const charInput = document.querySelector("#char");
    if (charInput) {
        charInput.addEventListener("change", async (event) => {
            const value = String(event.target && event.target.value ? event.target.value : "");
            uiSettings.censorChar = value.length > 0 ? Array.from(value)[0] : "*";
            charInput.value = uiSettings.censorChar;
            await persistSettings(uiSettings);
            refreshStatus();
        });
    }

    const subInput = document.querySelector("#censor-phrase");
    if (subInput) {
        subInput.addEventListener("change", async (event) => {
            const value = String(event.target && typeof event.target.value === "string" ? event.target.value : "").trim();
            uiSettings.censorSub = value.length > 0 ? value : getDefault().censorSub;
            subInput.value = uiSettings.censorSub;
            await persistSettings(uiSettings);
            refreshStatus();
        });
    }
}

// Validate IPv4 addresses
// - Returns true if the host is a valid IPv4 address
function isValidIPv4(host) {
    if (typeof host !== "string") return false;
    const parts = host.split(".");
    if (parts.length !== 4) return false;
    return parts.every((part) => {
        if (!/^\d+$/.test(part)) return false;
        const n = Number(part);
        return Number.isInteger(n) && n >= 0 && n <= 255;
    });
}

// Validate hostnames: must contain at least one dot (except localhost)
// - Returns true if the host is a valid hostname
function isValidHostname(host) {
    if (typeof host !== "string") return false;
    const h = host.toLowerCase();
    if (!h) return false;
    if (h === "localhost") return true;
    if (isValidIPv4(h)) return true;
    if (!h.includes(".")) return false;
    if (h.length > 253) return false;
    if (!/^[a-z0-9.-]+$/.test(h)) return false;
    if (h.startsWith(".") || h.endsWith(".")) return false;
    if (h.includes("..")) return false;
    const labels = h.split(".");
    return labels.every((label) => {
        if (!label || label.length > 63) return false;
        if (label.startsWith("-") || label.endsWith("-")) return false;
        return /^[a-z0-9-]+$/.test(label);
    });
}

// Normalize URL/host/path input to a string used by censor.js ignore matching
// - If wholeDomain is true: return only `hostname`
// - Otherwise: return `hostname + pathname` (without query/hash)
function normalizeOmitSiteInput(inputValue, wholeDomain) {
    const raw = String(inputValue || "").trim();
    if (!raw) return "";
    if (/\s/.test(raw)) return "";

    // Handle explicit http(s) URLs.
    if (/^https?:\/\//i.test(raw)) {
        try {
            const p = new URL(raw);
            return `${p.hostname}${p.pathname === "/" ? "" : p.pathname}`;
        } catch {
            return "";
        }
    }

    // Handle inputs without scheme by parsing as if https://<raw>.
    // This supports entries like `example.com/some/path`.
    try {
        const p = new URL(`https://${raw.replace(/^\/*/, "")}`);
        if (!isValidHostname(p.hostname)) return "";
        if (wholeDomain) return p.hostname;
        return `${p.hostname}${p.pathname === "/" ? "" : p.pathname}`;
    } catch {
        return "";
    }
}

// Wire omit-current-site button and omit form submit to add sites to ignoredSites
function wireAddOmitForm() {
    const viewOmit = document.getElementById("view-omit");
    if (!viewOmit) {
        return;
    }
    const addPhraseInput = viewOmit.querySelector("#omit-add-phrase");
    const domainIndicator = viewOmit.querySelector("#domain-indicator");
    const submitBtn = viewOmit.querySelector("#omit-phrase-submit");
    const useCurrentBtn = document.getElementById("omit-current-site");

    if (useCurrentBtn && addPhraseInput) {
        useCurrentBtn.addEventListener("click", async () => {
            try {
                const tab = await getActiveTab();
                if (tab && tab.url) {
                    const siteText = formatSiteLink(tab.url);
                    if (siteText !== "Site unavailable" && siteText !== "Browser protected page") {
                        addPhraseInput.value = siteText;
                    } else {
                        addPhraseInput.value = tab.url;
                    }
                } else {
                    addPhraseInput.placeholder = "No tab available. Focus a tab and try again.";
                    addPhraseInput.value = "";
                }
            } catch {
                addPhraseInput.placeholder = "Could not get tab. Check extension permissions.";
                addPhraseInput.value = "";
            }
        });
    }

    if (!addPhraseInput || !submitBtn) {
        return;
    }

    submitBtn.addEventListener("click", async () => {
        const raw = (addPhraseInput.value || "").trim();
        clearUiAlert();
        const rawLower = raw.toLowerCase();
        const wholeDomain = Boolean(domainIndicator && domainIndicator.checked);
        const site = normalizeOmitSiteInput(raw, wholeDomain);
        if (!site) {
            if (rawLower.includes("about:")) {
                showUiAlert(
                    "It looks like you're trying to omit a browser settings page. These pages are already protected by the browser and cannot be censored by CensorCAT.",
                    "warning"
                );
                return;
            }
            if (rawLower.includes("/C:/")) {
                showUiAlert(
                    "It looks like you're trying to omit a system file. These files are already protected by the system and cannot be censored by CensorCAT.",
                    "warning"
                );
                return;
            }
            if (rawLower.includes("moz-extension://")) {
                showUiAlert(
                    "It looks like you're trying to omit an extension-generated page. These pages are already protected by the browser and cannot be censored by CensorCAT.",
                    "warning"
                );
                return;
            }
            showUiAlert(
                wholeDomain
                    ? "Please enter a valid domain to omit (example: wikipedia.org)."
                    : "Please enter a valid URL or domain to omit (example: wikipedia.org or wikipedia.org/wiki/Page).",
                "error"
            );
            return;
        }
        const list = Array.isArray(uiSettings.ignoredSites) ? uiSettings.ignoredSites : [];
        const alreadyExists = list.some(([s, w]) => s === site && w === wholeDomain);
        if (alreadyExists) {
            showUiAlert("This site is already in the omit list with the same options.", "warning");
            return;
        }
        const entry = [site, wholeDomain];
        uiSettings.ignoredSites = list;
        uiSettings.ignoredSites.push(entry);
        await persistSettings(uiSettings);

        addPhraseInput.value = "";
        if (domainIndicator) {
            domainIndicator.checked = false;
        }
    });
}

// Wire case/regex checkboxes and censor form submit to add phrases to censoredPhrases
function wireAddCensorForm() {
    const viewWords = document.getElementById("view-words");
    if (!viewWords) return;
    const addPhraseInput = viewWords.querySelector("#add-phrase");
    const caseIndicator = viewWords.querySelector("#case-indicator");
    const regexIndicator = viewWords.querySelector("#regex-indicator");
    const submitBtn = viewWords.querySelector("#censor-phrase-submit");
    if (!addPhraseInput || !caseIndicator || !regexIndicator || !submitBtn) return;

    const uncheckOther = (other) => {
        if (caseIndicator.checked && regexIndicator.checked) other.checked = false;
    };
    caseIndicator.addEventListener("change", () => uncheckOther(regexIndicator));
    regexIndicator.addEventListener("change", () => uncheckOther(caseIndicator));

    submitBtn.addEventListener("click", async () => {
        const phrase = (addPhraseInput.value || "").trim();
        clearUiAlert();
        if (phrase.length === 0) {
            showUiAlert("Please enter a word or phrase to censor.", "error");
            return;
        }
        if (caseIndicator.checked && regexIndicator.checked) {
            showUiAlert("Cannot use both case-sensitive and REGEX at the same time. Please uncheck one.", "error");
            return;
        }

        const caseSensitive = caseIndicator.checked;
        const isRegex = regexIndicator.checked;
        if (isRegex) {
            const flags = caseSensitive ? "g" : "gi";
            try {
                new RegExp(phrase, flags);
            } catch (err) {
                const detail = err && typeof err.message === "string" && err.message.length > 0
                    ? err.message
                    : "The pattern could not be compiled.";
                showUiAlert(`Invalid regular expression: ${detail}`, "error");
                return;
            }
        }
        const list = Array.isArray(uiSettings.censoredPhrases) ? uiSettings.censoredPhrases : [];
        const alreadyExists = list.some(([p, c, r]) => p === phrase && c === caseSensitive && r === isRegex);
        if (alreadyExists) {
            showUiAlert("This phrase is already in the censor list with the same options.", "warning");
            return;
        }

        const entry = [phrase, caseSensitive, isRegex];
        uiSettings.censoredPhrases = list;
        uiSettings.censoredPhrases.push(entry);
        await persistSettings(uiSettings);

        addPhraseInput.value = "";
        caseIndicator.checked = false;
        regexIndicator.checked = false;
    });
}

// ----------------------
//     Debug functions
// ----------------------

// Write settings JSON to dev storage pre element
function renderDevStorage(settings) {
    const el = document.querySelector("#dev-storage-data");
    if (el) el.textContent = JSON.stringify(settings, null, 2);
}

function setAboutVersion() {
    const el = document.querySelector("#about-version");
    if (!el) {
        return;
    }

    let currentVersion = "Unknown";
    try {
        const manifest = browser.runtime && browser.runtime.getManifest ? browser.runtime.getManifest() : null;
        if (manifest && typeof manifest.version === "string" && manifest.version.length > 0) {
            currentVersion = manifest.version;
        }
    } catch {
        // leave unknown
    }

    el.innerHTML = `<strong>Version:</strong> v${currentVersion}`;
}


// ----------------------
//     INITILIZATION
// ----------------------

// Load settings, apply to UI, wire controls, and refresh status
async function initializeUi() {
    let loadedSettings = getDefault();
    try {
        loadedSettings = await loadSettings();
    } catch {
        // Keep defaults when storage read fails
    }
    let devFeaturesEnabled = false;
    try {
        const devStored = await browser.storage.local.get(DEV_UI_STORAGE_KEY);
        devFeaturesEnabled = Boolean(devStored[DEV_UI_STORAGE_KEY]);
    } catch {
        // leave false
    }
    applySettingsToUi(loadedSettings);
    applyDevFeaturesVisibility(devFeaturesEnabled);
    renderDevStorage(loadedSettings);
    setWordDetails();
    setOmitDetails();
    wireSettingsControls();
    wireAddCensorForm();
    wireAddOmitForm();
    wireSettingsIoPage();
    wireDevFeaturesToggle();
    wireDevControls();
    setAboutVersion();
    refreshStatus();
}

initializeUi();

browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
        return;
    }
    if (changes[DEV_UI_STORAGE_KEY]) {
        applyDevFeaturesVisibility(Boolean(changes[DEV_UI_STORAGE_KEY].newValue));
    }
    if (!changes[STORAGE_KEY]) {
        return;
    }
    const nextValue = changes[STORAGE_KEY].newValue;
    const fallback = getDefault();
    applySettingsToUi(nextValue || fallback);
    renderDevStorage(nextValue || fallback);
    setWordDetails();
    setOmitDetails();
    refreshStatus();
});

browser.tabs.onActivated.addListener(() => refreshStatus());
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab?.active && (changeInfo.status === "loading" || changeInfo.status === "complete" || changeInfo.url)) {
        refreshStatus();
    }
});
window.addEventListener("unload", () => {
    clearRefreshTimer();
});
