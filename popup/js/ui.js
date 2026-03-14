/* eslint-disable no-undef */

// /////////////////////////////
//         UI Constants
// /////////////////////////////

const STORAGE_KEY = SETTINGS_STORAGE_KEY; // localStorage access key
const MAX_STATUS_SYNC_RETRIES = 2; // How many attempts to get page data before we determine it's protected
let refreshTimerId = null;
let refreshRequestId = 0;
let statusSyncRetryCount = 0;
let lastStatusSyncTabId = null;
let uiSettings = getDefault();

// /////////////////////////////
//     Storage persistence
// /////////////////////////////

// Save settings to storage and refresh word/omit lists
async function persistSettings(settings) {
    try {
        uiSettings = await saveSettings(settings);
    } catch {
        alert("Unable to save settings to local storage.");
        uiSettings = normalizeSettings(settings);
    }
    renderDevStorage(uiSettings);
    setWordDetails();
    setOmitDetails();
}

// /////////////////////////////
//      Navigation buttons
// /////////////////////////////

const VIEW_IDS = ["view-home", "view-words", "view-omit", "view-info"];
const NAV_IDS = ["nav-home", "nav-words", "nav-omit", "nav-info"];

// Hide all views and clear active nav state
function hideAllPages() {
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

// /////////////////////////////
//   HOME: status & site link
// /////////////////////////////

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

// /////////////////////////////////////
//    List UI (for words & omit tabs)
// /////////////////////////////////////

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
        p.className = "scroll-text";
        p.textContent = isRegex ? phraseText : maskPhraseForDisplay(phraseText);
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
        p.className = "scroll-text";
        p.textContent = site;
        if (wholeDomain) {
            const domainSpan = document.createElement("span");
            domainSpan.className = "omit-domain-tag";
            domainSpan.textContent = " (domain)";
            p.appendChild(domainSpan);
        }
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

// /////////////////////////////
//  Setting changes detection
// /////////////////////////////

// Return JSON string of normalized settings for comparison
function getSettingsSignature(settings) {
    const n = normalizeSettings(settings);
    return JSON.stringify({
        disableCensor: n.disableCensor,
        censorMode: n.censorMode,
        censorChar: n.censorChar,
        censorSub: n.censorSub,
        censoredPhrases: n.censoredPhrases,
        ignoredSites: n.ignoredSites
    });
}

// Return true if page settings differ from current UI settings
function shouldShowPendingNotice(pageSettings) {
    return pageSettings && getSettingsSignature(pageSettings) !== getSettingsSignature(uiSettings);
}

// /////////////////////////////
//   Update UI with settings
// /////////////////////////////

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

// ///////////////////////////////
//     Tabs & refresh elements
// ///////////////////////////////

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
            setStatus("protected", "Protected", "This page is protected by the browser.");
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

// //////////////////////////////////
//   Wire event handlers & controls
// //////////////////////////////////

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

// Normalize URL or host/path string to hostname or hostname+path for omit list
function normalizeOmitSiteInput(inputValue) {
    const raw = String(inputValue || "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) {
        try {
            const p = new URL(raw);
            return `${p.hostname}${p.pathname === "/" ? "" : p.pathname}`;
        } catch {
            return raw;
        }
    }
    return raw.replace(/^\/*/, "");
}

// Wire omit-current-site button and omit form submit to add sites to ignoredSites
function wireAddOmitForm() {
    const viewOmit = document.getElementById("view-omit");
    if (!viewOmit) {
        return;
    }
    const addPhraseInput = viewOmit.querySelector("#add-phrase");
    const domainIndicator = viewOmit.querySelector("#domain-indicator");
    const submitBtn = viewOmit.querySelector("#censor-phrase-submit");
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
        const site = normalizeOmitSiteInput(raw);
        if (!site) {
            alert("Please enter a URL or site to omit.");
            return;
        }
        const wholeDomain = Boolean(domainIndicator && domainIndicator.checked);
        const list = Array.isArray(uiSettings.ignoredSites) ? uiSettings.ignoredSites : [];
        const alreadyExists = list.some(([s, w]) => s === site && w === wholeDomain);
        if (alreadyExists) {
            alert("This site is already in the omit list with the same options.");
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
    const addPhraseInput = document.querySelector("#add-phrase");
    const caseIndicator = document.querySelector("#case-indicator");
    const regexIndicator = document.querySelector("#regex-indicator");
    const submitBtn = document.querySelector("#censor-phrase-submit");
    if (!addPhraseInput || !caseIndicator || !regexIndicator || !submitBtn) return;

    const uncheckOther = (other) => {
        if (caseIndicator.checked && regexIndicator.checked) other.checked = false;
    };
    caseIndicator.addEventListener("change", () => uncheckOther(regexIndicator));
    regexIndicator.addEventListener("change", () => uncheckOther(caseIndicator));

    submitBtn.addEventListener("click", async () => {
        const phrase = (addPhraseInput.value || "").trim();
        if (phrase.length === 0) {
            alert("Please enter a word or phrase to censor.");
            return;
        }
        if (caseIndicator.checked && regexIndicator.checked) {
            alert("Cannot use both case-sensitive and REGEX at the same time. Please uncheck one.");
            return;
        }

        const caseSensitive = caseIndicator.checked;
        const isRegex = regexIndicator.checked;
        const list = Array.isArray(uiSettings.censoredPhrases) ? uiSettings.censoredPhrases : [];
        const alreadyExists = list.some(([p, c, r]) => p === phrase && c === caseSensitive && r === isRegex);
        if (alreadyExists) {
            alert("This phrase is already in the censor list with the same options.");
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

// ////////////////////////
//     Debug functions
// ////////////////////////

// Write settings JSON to dev storage pre element
function renderDevStorage(settings) {
    const el = document.querySelector("#dev-storage-data");
    if (el) el.textContent = JSON.stringify(settings, null, 2);
}


// ////////////////////////
//     INITILIZATION
// ////////////////////////

// Load settings, apply to UI, wire controls, and refresh status
async function initializeUi() {
    let loadedSettings = getDefault();
    try {
        loadedSettings = await loadSettings();
    } catch {
        // Keep defaults when storage read fails
    }
    applySettingsToUi(loadedSettings);
    renderDevStorage(loadedSettings);
    setWordDetails();
    setOmitDetails();
    wireSettingsControls();
    wireAddCensorForm();
    wireAddOmitForm();
    wireDevControls();
    refreshStatus();
}

initializeUi();

browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) {
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
