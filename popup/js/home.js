/* eslint-disable no-undef */

const STORAGE_KEY = SETTINGS_STORAGE_KEY;
const MAX_STATUS_SYNC_RETRIES = 2;
let refreshTimerId = null;
let refreshRequestId = 0;
let statusSyncRetryCount = 0;
let lastStatusSyncTabId = null;
let uiSettings = getDefault();

// Persist settings
async function persistSettings(settings) {
    try {
        uiSettings = await saveSettings(settings);
    } catch {
        alert("Unable to save settings to local storage.");
        uiSettings = normalizeSettings(settings);
    }
    renderDevStorage(uiSettings);
}

// ------------------------------------------------------------
// STATUS & SITE LINK LOGIC
// for displaying status & site link in the home page
// ------------------------------------------------------------

// Check if page is browser-protected or otherwise invulnerable to my pesky censoring code, how dare they >:(
function isBrowserProtectedUrl(url) {
    if (!url || typeof url !== "string") {
        return false;
    }
    return /^(about|chrome|edge|moz-extension|chrome-extension|view-source):/i.test(url);
}

// Render status heading + message area based on status type
function setStatus(statusType, heading, message, showPendingNotice = false) {
    const focusEl = document.querySelector(".home-status-focus");
    const messageEl = document.querySelector(".home-status-msg");
    if (!focusEl || !messageEl) {
        return;
    }
    const safeHeading = String(heading || "").toUpperCase();
    focusEl.innerHTML = `Censoring <span class="home-status-value status-${statusType}">${safeHeading}</span>`;
    const baseMessage = String(message || "");
    messageEl.textContent = "";
    if (baseMessage) {
        messageEl.appendChild(document.createTextNode(baseMessage));
    }
    if (showPendingNotice) {
        if (baseMessage) {
            messageEl.appendChild(document.createTextNode(" "));
        }
        const noticeEl = document.createElement("span");
        noticeEl.className = "status-settings-pending";
        noticeEl.textContent = "Settings changed after this page was censored. Reload this page to apply them.";
        messageEl.appendChild(noticeEl);
    }
}

// Render site label and style unavailable state
function setSiteLink(text) {
    const siteLinkEl = document.querySelector(".home-sitelink");
    if (!siteLinkEl) {
        return;
    }
    const normalizedText = String(text || "").trim().toLowerCase();
    siteLinkEl.classList.toggle("soft", normalizedText === "site unavailable");
    siteLinkEl.textContent = text;
}

// Convert site url into readable host/path text for site link display
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

// map content-script tuple into popup status types
function buildStatusFromTuple(status) {
    if (!Array.isArray(status) || status.length < 3) {
        return null;
    }
    const didRun = Boolean(status[0]);
    const heading = String(status[1] || (didRun ? "Enabled" : "Unavailable"));
    const message = String(status[2] || "");
    const normalizedHeading = heading.toLowerCase();
    let statusType = "disabled";

    // note: there's DEFINITELY a better way to do this but this will work for now
    if (didRun) {
        statusType = "enabled";
    } else if (normalizedHeading === "omitted") {
        statusType = "omitted";
    } else if (normalizedHeading.startsWith("loading")) {
        statusType = "loading";
    } else if (normalizedHeading === "protected") {
        statusType = "protected";
    } else if (normalizedHeading === "unavailable") {
        statusType = "unavailable";
    }

    return { statusType, heading, message };
}

// ------------------------------------------------------------
// SETTINGS COMPARISON LOGIC
// for telling whether or not settings have been changed
// this lets us show the warning to the user to reload the page
// ------------------------------------------------------------

// create deterministic serialized signature for settings comparison
function buildSettingsSignature(settings) {
    const normalized = normalizeSettings(settings);
    return JSON.stringify({
        disableCensor: normalized.disableCensor,
        censorMode: normalized.censorMode,
        censorChar: normalized.censorChar,
        censorSub: normalized.censorSub,
        censoredPhrases: normalized.censoredPhrases,
        ignoredSites: normalized.ignoredSites
    });
}

function shouldShowPendingNotice(pageSettings) {
    if (!pageSettings) {
        return false;
    }
    return buildSettingsSignature(pageSettings) !== buildSettingsSignature(uiSettings);
}

// ------------------------------------------------------------
// UI UPDATE LOGIC
// update the UI based on settings and vice versa
// ------------------------------------------------------------

// Push settings values into all UI controls
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

    updateModeCustomVisibility(parsed.censorMode);
}

// Mode 3 uses substitute phrase input; other modes use char input
function updateModeCustomVisibility(mode) {
    const charRow = document.querySelector("#char-row");
    const subRow = document.querySelector("#sub-row");
    if (!charRow || !subRow) {
        return;
    }

    const useSubstituteMode = Number(mode) === 3;
    charRow.classList.toggle("hidden", useSubstituteMode);
    subRow.classList.toggle("hidden", !useSubstituteMode);
}

// DEV FUNCTION: JSON dump of currently loaded settings
// !!! REMOVE BEFORE PRODUCTION BUILD !!!
function renderDevStorage(settings) {
    const devPre = document.querySelector("#dev-storage-data");
    if (!devPre) {
        return;
    }
    devPre.textContent = JSON.stringify(settings, null, 2);
}
// !!! REMOVE BEFORE PRODUCTION BUILD !!!

// Returns currently focused tab in the current window.
async function getActiveTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
}

// Main popup status refresh pipeline
// uses request id guarding so only latest async attempt will update UI
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

    // Reset retry tracking when user switches tabs.
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
            setStatus("protected", "Protected", "This page is protected by the browser.");
        });
        return;
    }

    try {
        // Query content script for page-local status tuple + settings used at run time.
        const response = await browser.tabs.sendMessage(activeTab.id, { type: "GET_CENSOR_STATUS" });
        statusSyncRetryCount = 0;
        applyIfCurrent(() => {
            const responseSite = response && typeof response.site === "string" && response.site.length > 0
                ? response.site
                : formatSiteLink(activeTab.url);
            setSiteLink(responseSite);

            const pageSettings = response && response.settings ? normalizeSettings(response.settings) : null;
            const statusData = buildStatusFromTuple(response && response.status);
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
        // Content script may not be ready/injectable yet
        // Retry based on sync var and then give up
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

// Cancel pending polling timer
function clearRefreshTimer() {
    if (refreshTimerId !== null) {
        window.clearTimeout(refreshTimerId);
        refreshTimerId = null;
    }
}

// Debounced polling scheduler to avoid stacking concurrent timers
function scheduleRefresh() {
    if (refreshTimerId !== null) {
        return;
    }
    refreshTimerId = window.setTimeout(() => {
        refreshTimerId = null;
        refreshStatus();
    }, 700);
}

// Temporary nav handlers for non-implemented pages
function wireComingSoonNav() {
    const comingSoonButtons = [
        document.querySelector("#nav-words"),
        document.querySelector("#nav-omit"),
        document.querySelector("#nav-info")
    ].filter(Boolean);

    comingSoonButtons.forEach((button) => {
        button.addEventListener("click", () => {
            alert("Functionality coming soon.");
        });
    });
}

// Overwrite storage with defaults for testing
// NOTE: This was going to be dev only but i kinda like it
// Might reformat to use in info if needs be later on
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

// Attach settings control events
// each writes to storage and refreshes status UI
function wireSettingsControls() {
    const toggleEl = document.querySelector("#disable-censor-toggle");
    if (toggleEl) {
        toggleEl.addEventListener("change", async (event) => {
            uiSettings.disableCensor = Boolean(event.target && event.target.checked);
            await persistSettings(uiSettings);
            refreshStatus();
        });
    }

    const modeInputs = Array.from(document.querySelectorAll('input[name="censor_mode"]'));
    modeInputs.forEach((input) => {
        input.addEventListener("change", async (event) => {
            const nextMode = Number.parseInt(event.target && event.target.value, 10);
            if (!Number.isInteger(nextMode) || nextMode < 0 || nextMode > 3) {
                return;
            }
            uiSettings.censorMode = nextMode;
            updateModeCustomVisibility(uiSettings.censorMode);
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

// Popup boot sequence
async function initializeUi() {
    let loadedSettings = getDefault();
    try {
        loadedSettings = await loadSettings();
    } catch {
        // Keep defaults when storage read fails.
    }
    applySettingsToUi(loadedSettings);
    renderDevStorage(loadedSettings);
    wireSettingsControls();
    wireDevControls();
    wireComingSoonNav();
    refreshStatus();
}

initializeUi();

// Keep UI in sync if settings change externally
browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) {
        return;
    }
    const nextValue = changes[STORAGE_KEY].newValue;
    const fallback = getDefault();
    applySettingsToUi(nextValue || fallback);
    renderDevStorage(nextValue || fallback);
    refreshStatus();
});

// Status should refresh when active tab changes
browser.tabs.onActivated.addListener(() => {
    refreshStatus();
});

// Status should refresh when active tab URL/load state changes
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab && tab.active && (changeInfo.status === "loading" || changeInfo.status === "complete" || changeInfo.url)) {
        refreshStatus();
    }
});

// kill pending timers when popup closes
window.addEventListener("unload", () => {
    clearRefreshTimer();
});
